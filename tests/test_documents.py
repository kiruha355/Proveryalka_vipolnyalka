import hashlib
import io
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from proveryalka.agent import dialogue
from proveryalka.api.app import create_app
from proveryalka.config import Settings
from test_analyst_http import TEXT, Script
from test_check_api import FakeChecker, wait_run


WORD = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def docx(body, extra=None, xml=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml if xml is not None else f'<?xml version="1.0"?><w:document {WORD}><w:body>{body}</w:body></w:document>')
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return stream.getvalue()


@pytest.fixture
def client(tmp_path):
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts", max_document_bytes=200_000, max_input_chars=5_000)
    with TestClient(create_app(settings, checker=FakeChecker())) as client:
        client.sid = client.post("/api/sessions", json={"title": "Документы"}, headers={"Idempotency-Key": "s"}).json()["id"]
        yield client


def upload(client, name, data, key="d"):
    return client.post(f"/api/sessions/{client.sid}/documents", files={"file": (name, data, "application/octet-stream")}, headers={"Idempotency-Key": key})


def test_text_and_markdown_become_sources_with_provenance(client, tmp_path):
    data = "﻿Заявку можно отменить.\r\nОтменённую заявку нельзя исполнить.\r\n".encode("utf-8")
    response = upload(client, "../../etc/Правила.txt", data)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["source"]["text"] == "Заявку можно отменить.\nОтменённую заявку нельзя исполнить."
    assert body["document"] == {
        "source_id": body["source"]["id"], "filename": "Правила.txt", "format": "txt", "media_type": "text/plain",
        "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "characters": len(body["source"]["text"]),
    }
    assert upload(client, "../../etc/Правила.txt", data).json() == body
    assert upload(client, "Другое.txt", b"x", "d").json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    markdown = upload(client, "notes.MD", "# Правила\n\n- пункт".encode(), "md").json()
    assert markdown["document"]["format"] == "md" and markdown["source"]["text"].startswith("# Правила")
    detail = client.get(f"/api/sessions/{client.sid}").json()
    assert [d["filename"] for d in detail["documents"]] == ["Правила.txt", "notes.MD"]
    assert {s["id"] for s in detail["sources"]} == {body["source"]["id"], markdown["source"]["id"]}
    assert not (tmp_path / "artifacts").exists()


def test_docx_text_extraction_ignores_deleted_text(client):
    body = (
        "<w:p><w:r><w:t>Заявка</w:t></w:r><w:r><w:tab/><w:t>создаётся</w:t></w:r></w:p>"
        "<w:p><w:del><w:r><w:delText>удалено</w:delText></w:r></w:del><w:r><w:t>Отмена</w:t><w:br/><w:t>возможна</w:t></w:r></w:p>"
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ячейка</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    )
    response = upload(client, "rules.docx", docx(body))
    assert response.status_code == 201, response.text
    assert response.json()["source"]["text"] == "Заявка\tсоздаётся\nОтмена\nвозможна\nЯчейка"
    assert response.json()["document"]["format"] == "docx"


@pytest.mark.parametrize("name,data,status,code", [
    ("scan.pdf", b"%PDF-1.7", 415, "UNSUPPORTED_DOCUMENT"),
    ("latin.txt", "Заявка".encode("cp1251"), 422, "DOCUMENT_ENCODING"),
    ("nul.txt", b"a\x00b", 422, "DOCUMENT_ENCODING"),
    ("blank.md", b" \n\t", 422, "DOCUMENT_EMPTY"),
    ("long.txt", b"x" * 5_001, 422, "INPUT_LIMIT"),
    ("big.txt", b"x" * 200_001, 413, "DOCUMENT_TOO_LARGE"),
    ("broken.docx", b"PK\x03\x04 not a zip", 422, "DOCUMENT_INVALID"),
    ("empty.docx", docx("", xml=None).replace(b"word/document.xml", b"word/documenx.xml"), 422, "DOCUMENT_INVALID"),
])
def test_rejected_documents(client, name, data, status, code):
    response = upload(client, name, data)
    assert response.status_code == status and response.json()["error"]["code"] == code
    assert client.get(f"/api/sessions/{client.sid}").json()["documents"] == []


def test_docx_entities_and_zip_bomb_are_rejected_quickly(client):
    laughs = f'<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document {WORD}><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>'
    external = f'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document {WORD}><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>'
    for xml in (laughs, external):
        response = upload(client, "entity.docx", docx("", xml=xml))
        assert response.status_code == 422 and "passwd" not in response.text
    bomb = docx("", xml="<w:document>" + " " * (25 * 1024 * 1024) + "</w:document>")
    assert len(bomb) < 200_000
    started = time.monotonic()
    response = upload(client, "bomb.docx", bomb)
    assert response.status_code == 413 and response.json()["error"]["code"] == "DOCUMENT_TOO_LARGE"
    assert time.monotonic() - started < 5


def test_oversized_body_is_refused_before_parsing(client):
    response = client.post(f"/api/sessions/{client.sid}/documents", content=b"x" * 300_000,
                           headers={"Idempotency-Key": "big", "Content-Type": "multipart/form-data; boundary=x"})
    assert response.status_code == 413
    assert client.post(f"/api/sessions/{client.sid}/documents", headers={"Idempotency-Key": "none"}).status_code in (411, 422)


def test_document_source_starts_the_dialogue(tmp_path, monkeypatch):
    script = Script()
    monkeypatch.setattr(dialogue, "generate_state", script)
    settings = Settings(database_path=tmp_path / "db", artifacts_path=tmp_path / "artifacts")
    with TestClient(create_app(settings, checker=FakeChecker())) as client:
        sid = client.post("/api/sessions", json={"title": "Документ"}, headers={"Idempotency-Key": "s"}).json()["id"]
        other = client.post("/api/sessions", json={"title": "Чужая"}, headers={"Idempotency-Key": "o"}).json()["id"]
        source = client.post(f"/api/sessions/{sid}/documents", files={"file": ("case.txt", TEXT.encode(), "text/plain")}, headers={"Idempotency-Key": "d"}).json()["source"]
        foreign = client.post(f"/api/sessions/{other}/messages", json={"source_id": source["id"]}, headers={"Idempotency-Key": "f"})
        assert foreign.status_code == 404
        assert client.post(f"/api/sessions/{sid}/messages", json={"source_id": source["id"], "text": "x"}, headers={"Idempotency-Key": "both"}).status_code == 422
        run = client.post(f"/api/sessions/{sid}/messages", json={"source_id": source["id"]}, headers={"Idempotency-Key": "m"}).json()
        assert wait_run(client, run["run_id"])["state"] == "completed"
        assert script.payloads[0]["sources"] == [source]
        assert client.get(f"/api/sessions/{sid}/dialogue").json()["requirements"][0]["source_refs"][0]["source_id"] == source["id"]
        again = client.post(f"/api/sessions/{sid}/messages", json={"source_id": source["id"]}, headers={"Idempotency-Key": "m2"})
        assert again.status_code == 409 and again.json()["error"]["code"] == "DIALOGUE_STARTED"


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16", "utf-16-le", "utf-16-be"])
def test_docx_dtd_rejected_after_encoding_detection(client, encoding):
    declaration = "UTF-8" if encoding == "utf-8" else "UTF-16"
    xml = f'<?xml version="1.0" encoding="{declaration}"?><!DOCTYPE w:document [<!ENTITY x "ENTITY_EXPANDED">]><w:document {WORD}><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>'
    response = upload(client, "entity.docx", docx("", xml=xml.encode(encoding)))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DOCUMENT_INVALID"
    assert client.get(f"/api/sessions/{client.sid}").json()["sources"] == []


def test_normal_utf16_docx_remains_readable(client):
    xml = f'<?xml version="1.0" encoding="UTF-16"?><w:document {WORD}><w:body><w:p><w:r><w:t>Отмена заявки</w:t></w:r></w:p></w:body></w:document>'
    response = upload(client, "normal.docx", docx("", xml=xml.encode("utf-16")))
    assert response.status_code == 201, response.text
    assert response.json()["source"]["text"] == "Отмена заявки"
