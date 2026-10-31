import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from proveryalka.api.app import create_app
from proveryalka.config import Settings
from proveryalka.services import ServiceError
from proveryalka.storage.session import StoredSession
from proveryalka.storage.sqlite import SQLiteStore


@pytest.fixture
def store(tmp_path):
    result = SQLiteStore(tmp_path / "database.sqlite3")
    result.initialize()
    return result


def new_session(store, key="session"):
    return store.create_session({"title": "Заявка", "mode": "analyzer"}, key)["id"]


def test_restart_preserves_source_text_requirements_and_history(store):
    session_id = new_session(store)
    text = "Первая строка\n  Cancel сбрасывает approved.\n"
    source = store.create_source(session_id, {"text": text, "requirements": ["Сброс approved", "Не выполнять отменённую"]}, "src")
    items = [{"role": "user", "content": text}, {"type": "function_call", "call_id": "tool1", "name": "check", "arguments": "{}"}]
    store.append_messages(session_id, items)
    restarted = SQLiteStore(store.path)
    restarted.initialize()
    data = restarted.get_session(session_id)
    assert data["sources"][0] == source
    assert data["sources"][0]["text"] == text
    assert [r["code"] for r in data["requirements"]] == ["R1", "R2"]
    assert [r["text"] for r in data["requirements"]] == ["Сброс approved", "Не выполнять отменённую"]
    assert restarted.history(session_id) == items
    assert restarted.history(session_id, 1) == items[-1:]
    assert restarted.history(session_id, 0) == []
    assert restarted.history(session_id, -1) == []
    assert restarted.create_source(session_id, {"text": text, "requirements": ["Сброс approved", "Не выполнять отменённую"]}, "src") == source


def test_concurrent_retries_create_one_session_and_conflicts_do_not_write(store):
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: new_session(store), range(24)))
    assert len(set(results)) == 1
    assert len(store.list_sessions()) == 1
    with pytest.raises(ServiceError) as error:
        store.create_session({"title": "Changed"}, "session")
    assert error.value.status == 409
    assert store.list_sessions()[0]["title"] == "Заявка"


def test_parallel_batches_and_sources_have_unique_order(store):
    session_id = new_session(store)

    def write(index):
        # Separate instances simulate independent request handlers/processes.
        writer = SQLiteStore(store.path)
        writer.append_messages(session_id, [{"batch": index, "part": 0}, {"batch": index, "part": 1}])
        writer.create_source(session_id, {"text": str(index), "requirements": [f"rule {index}"]}, f"src-{index}")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(write, range(24)))
    result = store.get_session(session_id)
    assert [m["sequence"] for m in result["messages"]] == list(range(1, 49))
    for first, second in zip(result["messages"][::2], result["messages"][1::2]):
        assert first["message_data"]["batch"] == second["message_data"]["batch"]
        assert first["message_data"]["part"] == 0
        assert second["message_data"]["part"] == 1
    assert [r["code"] for r in result["requirements"]] == [f"R{i}" for i in range(1, 25)]


def test_concurrent_source_retries_are_atomic(store):
    session_id = new_session(store)
    body = {"text": "source", "requirements": ["first", "second"]}
    with ThreadPoolExecutor(max_workers=8) as pool:
        sources = list(pool.map(lambda _: store.create_source(session_id, body, "same"), range(16)))
    assert len({source["id"] for source in sources}) == 1
    assert len(store.get_session(session_id)["requirements"]) == 2
    with pytest.raises(ServiceError) as error:
        store.create_source(session_id, {"text": "changed"}, "same")
    assert error.value.status == 409


def test_membership_is_checked_in_queries_and_foreign_keys(store):
    first = new_session(store, "first")
    second = new_session(store, "second")
    source = store.create_source(first, {"text": "private", "requirements": ["rule"]}, "source")
    with pytest.raises(ServiceError) as error:
        store.get_source(second, source["id"])
    assert error.value.status == 404
    with pytest.raises(sqlite3.IntegrityError):
        with store.transaction(write=True) as connection:
            connection.execute("INSERT INTO requirements VALUES (?,?,?,?,?)", ("bad", second, source["id"], 1, "wrong session"))
    assert store.get_session(second)["requirements"] == []
    store.append_messages(first, [{"role": "user", "content": "private"}])
    assert store.history(second) == []
    assert store.pop_message(second) is None
    store.clear_history(second)
    assert len(store.history(first)) == 1


@pytest.mark.parametrize("operation", [
    lambda s: s.get_session("missing"),
    lambda s: s.history("missing"),
    lambda s: s.append_messages("missing", []),
    lambda s: s.pop_message("missing"),
    lambda s: s.clear_history("missing"),
    lambda s: s.create_source("missing", {"text": "x"}, "key"),
])
def test_missing_entities(store, operation):
    with pytest.raises(ServiceError) as error:
        operation(store)
    assert error.value.status == 404


def test_failed_writes_leave_no_partial_data(store):
    session_id = new_session(store)
    with pytest.raises(ValueError):
        store.append_messages(session_id, [{"content": "valid"}, {"bad": float("nan")}])
    assert store.history(session_id) == []
    with pytest.raises(ServiceError):
        store.create_source(session_id, {"text": "text", "requirements": ["valid", "  "]}, "source")
    assert store.get_session(session_id)["sources"] == []
    with pytest.raises(RuntimeError):
        with store.transaction(write=True) as connection:
            connection.execute("UPDATE sessions SET title='changed' WHERE id=?", (session_id,))
            raise RuntimeError("injected crash")
    assert store.get_session(session_id)["title"] == "Заявка"


def test_sdk_adapter_uses_same_history_without_second_database(store):
    session_id = new_session(store)
    source = store.create_source(session_id, {"text": "original", "requirements": ["rule"]}, "source")

    async def scenario():
        session = StoredSession(store, session_id)
        await session.add_items([{"role": "user", "content": "hello"}, {"role": "assistant", "content": "reply"}])
        assert len(store.get_session(session_id)["messages"]) == 2
        assert await session.get_items(1) == [{"role": "assistant", "content": "reply"}]
        assert await session.pop_item() == {"role": "assistant", "content": "reply"}
        await session.add_items([{"role": "assistant", "content": "updated"}])
        assert [row["sequence"] for row in store.get_session(session_id)["messages"]] == [1, 3]
        await session.clear_session()
        assert await session.get_items() == []
        assert await session.pop_item() is None
        assert store.get_source(session_id, source["id"])["text"] == "original"
        assert len(store.get_session(session_id)["requirements"]) == 1

    asyncio.run(scenario())


def test_parallel_pop_does_not_return_same_item_twice(store):
    session_id = new_session(store)
    store.append_messages(session_id, [{"number": n} for n in range(20)])
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: store.pop_message(session_id), range(24)))
    assert sorted(item["number"] for item in results if item is not None) == list(range(20))
    assert sum(item is None for item in results) == 4


def test_initialize_applies_codegen_and_source_migrations(store):
    with store.transaction() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 8
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"codegen_generations", "codegen_files", "codegen_test_runs"} <= tables
    assert {"image_sources", "image_analyses", "repository_snapshots", "repository_files", "repository_source_contexts"} <= tables
    store.initialize()  # Повторный запуск не применяет миграции заново.


def test_migration_refuses_future_schema_without_modifying_it(store):
    with store.transaction(write=True) as connection:
        connection.execute("PRAGMA user_version=9")
    with pytest.raises(RuntimeError, match="newer"):
        store.initialize()
    with store.transaction() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 9


def test_unavailable_database_has_safe_service_error(tmp_path):
    store = SQLiteStore(tmp_path / "absent-parent" / "secret-database.sqlite3")
    with pytest.raises(ServiceError) as error:
        store.list_sessions()
    assert error.value.status == 503
    assert "secret-database" not in error.value.message


def test_http_storage_restart_and_idempotency(tmp_path):
    settings = Settings(database_path=tmp_path / "nested" / "app.db")
    headers = {"Idempotency-Key": "session"}
    with TestClient(create_app(settings)) as client:
        created = client.post("/api/sessions", json={"title": "Test"}, headers=headers)
        assert created.status_code == 201
        session_id = created.json()["id"]
        assert client.post("/api/sessions", json={"title": "Test"}, headers=headers).json() == created.json()
        assert client.post("/api/sessions", json={"title": "Other"}, headers=headers).status_code == 409
        response = client.post(f"/api/sessions/{session_id}/sources", json={"text": "Original", "requirements": ["R text"]}, headers=headers)
        assert response.status_code == 201

    with TestClient(create_app(settings)) as client:
        detail = client.get(f"/api/sessions/{session_id}").json()
        assert detail["sources"][0]["text"] == "Original"
        assert detail["requirements"][0]["code"] == "R1"
        assert detail["messages"] == []  # Unavailable agent must not create phantom messages.
        assert client.get("/api/sessions?limit=1").json()[0]["id"] == session_id
        assert client.get("/api/sessions?offset=1").json() == []
        assert client.get("/api/sessions/missing").status_code == 404


def test_openapi_snapshot_matches_application():
    import json
    from pathlib import Path
    assert create_app().openapi() == json.loads((Path(__file__).parent / "fixtures/openapi.json").read_text())
