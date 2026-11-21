import pytest
from fastapi.testclient import TestClient
from test_analyst_http import TEXT, Script, draft, question
from test_check_api import wait_run
from test_documents import docx
from test_ownership import users as users  # noqa: PLC0414
from test_repositories import REMOTE, GitFixture, selection

from proveryalka.agent import dialogue
from proveryalka.api.app import create_app
from proveryalka.config import Settings


def post(client, path, body, key, status):
    response = client.post(path, json=body, headers={"Idempotency-Key": key})
    assert response.status_code == status, response.text
    return response.json()


def test_snapshot_file_ranges_are_immutable_and_owner_scoped(tmp_path, users):
    users.switch("alice")
    repo = GitFixture(tmp_path / "git")
    path = "src/правило + расчёт.py"
    repo.write(path, "# строка 1\r\n# правило ✅\r\n# конец")
    repo.write(".env", "disallowed\n")
    repo.write("empty.py", "")
    first = repo.commit()
    users.app.state.repositories.transport = repo
    session = post(users, "/api/sessions", {"title": "Снимок"}, "session", 201)["id"]
    root = f"/api/sessions/{session}/repositories"
    snapshot = post(users, root, {"remote_url": REMOTE}, "snapshot", 201)
    old = f"{root}/{snapshot['id']}"
    endpoint = old + "/files/content"
    params = {"path": path, "start_line": 2, "end_line": 3}
    response = users.get(endpoint, params=params)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "path": path, "commit_sha": first, "sha256": next(file["sha256"] for file in snapshot["files"] if file["path"] == path),
        "start_line": 2, "total_lines": 3, "lines": ["# правило ✅\r\n", "# конец"],
    }
    assert users.get(endpoint, params={**params, "end_line": 4}).status_code == 422
    assert users.get(endpoint, params={"path": "../.env"}).status_code == 404
    assert users.get(endpoint, params={"path": ".env"}).status_code == 404
    assert users.get(endpoint, params={"path": "empty.py"}).json()["lines"] == []
    assert users.get(old + "/context").json() is None
    body = selection(snapshot, path, 2, 2)
    context = post(users, old + "/context", body, "context", 201)
    assert users.get(old + "/context").json() == {
        "source_id": context["source"]["id"], "size_bytes": len(context["source"]["text"].encode()),
        "ranges": body["files"],
    }

    repo.write(path, "# обновлённый файл\n")
    second = repo.commit()
    updated = post(users, old + "/refresh", {"ref": "HEAD"}, "refresh", 201)
    assert updated["commit_sha"] == second and updated["parent_snapshot_id"] == snapshot["id"]
    assert users.get(endpoint, params=params).json() == response.json()
    assert users.get(f"{root}/{updated['id']}/files/content", params={"path": path}).json()["lines"] == ["# обновлённый файл\n"]

    users.switch("bob")
    assert users.get(endpoint, params=params).status_code == 404
    another = post(users, "/api/sessions", {"title": "Другой"}, "session", 201)["id"]
    assert users.get(endpoint.replace(session, another), params=params).status_code == 404
    assert users.get(old + "/context").status_code == 404


def test_snapshot_file_rejects_corrupted_content(tmp_path):
    app = create_app(Settings(database_path=tmp_path / "db"), codegen_sandbox=object())
    repo = GitFixture(tmp_path / "git")
    repo.write("main.py", "state = 'new'\n")
    repo.commit()
    app.state.repositories.transport = repo
    with TestClient(app) as client:
        session = post(client, "/api/sessions", {"title": "Снимок"}, "session", 201)["id"]
        root = f"/api/sessions/{session}/repositories"
        snapshot = post(client, root, {"remote_url": REMOTE}, "snapshot", 201)
        with app.state.backend.store.transaction(write=True) as connection:
            connection.execute("UPDATE repository_files SET content='damaged' WHERE snapshot_id=?", (snapshot["id"],))
        response = client.get(f"{root}/{snapshot['id']}/files/content", params={"path": "main.py"})
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "REPOSITORY_FILE_HASH_MISMATCH"
        assert "damaged" not in response.text


def test_automatic_context_and_analysis_attach_to_dialogue(tmp_path, monkeypatch):
    app = create_app(Settings(database_path=tmp_path / "db"), codegen_sandbox=object())
    if not hasattr(app.state.repositories, "plan"):
        pytest.skip("Requires develop f78ffa5 repository selection and source attachment contracts")

    repo = GitFixture(tmp_path / "git")
    repo.write("app/routes.py", "from app.booking import reserve_slot\nreserve_slot('morning')\n")
    quote = "def reserve_slot(slot):"
    repo.write("app/booking.py", quote + "\n    return slot\n")
    repo.write("README.md", "A slot cannot be reserved in the morning.\n")
    repo.write("package-lock.json", '{"asset": true}')
    repo.commit()
    app.state.repositories.transport = repo

    def review_repository(sources, previous):
        result = draft(sources, previous, reply="Нужно уточнить расхождение с документацией")
        result.analysis.requirements.append(result.analysis.requirements[0].model_copy(update={
            "source_id": sources[-1].id, "previous_id": None, "text": "Код содержит операцию резервирования", "quote": quote,
        }))
        return result

    def follow_up(sources, previous):
        result = draft(sources, previous, reply="Учёл оба источника")
        rule = previous.analysis.requirements[-1]
        ref = rule.source_refs[0]
        result.analysis.requirements.append(result.analysis.requirements[0].model_copy(update={
            "source_id": ref.source_id, "previous_id": rule.id, "text": rule.text, "quote": ref.quote,
        }))
        return result

    script = Script([
        lambda s, p: draft(s, p, questions=[question("Какой объект резервируется?")], reply="Уточните объект"),
        lambda s, p: draft(s, p, resolutions=[{
            "question_id": p.questions[0].id, "decision": "answered", "quote": "Объект — заявка.",
        }], reply="Объект известен"),
        lambda s, p: draft(s, p, reply="Документ добавлен"),
        review_repository,
        follow_up,
    ])
    monkeypatch.setattr(dialogue, "generate_state", script)
    with TestClient(app) as client:
        session = post(client, "/api/sessions", {"title": "Диалог"}, "session", 201)["id"]
        base = f"/api/sessions/{session}"
        def complete(path, body, key):
            run = post(client, path, body, key, 202)
            outcome = wait_run(client, run["run_id"])
            assert outcome["state"] == "completed", outcome
            return run

        # Leave all pre-existing history and rule references in place across both attachments.
        complete(base + "/messages", {"text": TEXT}, "first")
        before = client.get(base + "/dialogue").json()
        complete(base + "/messages", {"text": "Объект — заявка.", "question_id": before["open_question_ids"][0]}, "answer")
        before = client.get(base + "/dialogue").json()
        uploaded = client.post(
            base + "/documents",
            files={"file": ("booking.docx", docx("<w:p><w:r><w:t>Описание резервирования.</w:t></w:r></w:p>"))},
            headers={"Idempotency-Key": "document"},
        )
        assert uploaded.status_code == 201, uploaded.text
        document = uploaded.json()["source"]
        complete(base + "/messages", {"source_id": document["id"]}, "attach")
        snapshot = post(client, base + "/repositories", {"remote_url": REMOTE}, "snapshot", 201)
        root = f"{base}/repositories/{snapshot['id']}"
        body = {"manifest_sha256": snapshot["manifest_sha256"], "query": "reserve slot"}
        plan = post(client, root + "/selection", {"query": body["query"]}, "plan", 200)
        assert plan["coverage"] == "partial"
        assert plan["selected_line_count"] == 5
        context = post(client, root + "/context", {**body, "files": []}, "preview", 201)
        assert {row["path"] for row in context["excerpts"]} == {"app/routes.py", "app/booking.py", "README.md"}
        assert "package-lock.json" not in context["source"]["text"]
        assert post(client, root + "/context", body, "preview", 201) == context
        run = complete(root + "/analysis", {**body, "auto_select": True}, "analysis")
        assert post(client, root + "/analysis", body, "analysis", 202)["run_id"] == run["run_id"]
        payload = script.payloads[-1]
        assert payload["turn_kind"] == "attachment"
        assert document in payload["sources"]
        assert snapshot["commit_sha"] in payload["sources"][-1]["text"]
        assert 'Requested analysis scope: "reserve slot"' in payload["sources"][-1]["text"]
        after = client.get(base + "/dialogue").json()
        assert after["entries"][:len(before["entries"])] == before["entries"]
        assert after["requirements"][:len(before["requirements"])] == before["requirements"]
        ref = after["requirements"][-1]["source_refs"][0]
        location = client.get(f"{base}/sources/{ref['source_id']}/provenance", params={"start": ref["start"], "end": ref["end"]}).json()
        assert location["commit_sha"] == snapshot["commit_sha"]
        assert location["path"] == "app/booking.py" and location["start_line"] == location["end_line"] == 1
        file = client.get(root + "/files/content", params={"path": location["path"], "end_line": 1}).json()
        assert file["lines"] == [quote + "\n"]
        complete(base + "/messages", {"text": "Уточни условия резервирования."}, "follow-up")
        later = client.get(base + "/dialogue").json()
        assert later["requirements"] == after["requirements"]
        assert script.payloads[-1]["sources"][:-1] == payload["sources"]
