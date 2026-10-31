"""Минимальный JSON-RPC сервер по stdio с формой сообщений Codex app-server; без сети и модели."""
import json
import os
import sys

MODE = os.environ.get("FAKE_CODEX_MODE", "ok")
LOG = open(os.environ["FAKE_CODEX_LOG"], "a", encoding="utf-8")


def log(entry):
    LOG.write(json.dumps(entry, ensure_ascii=False) + "\n")
    LOG.flush()


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def notify(method, params):
    send({"method": method, "params": params})


def finish(status="completed", error=None):
    notify("turn/completed", {"threadId": "t1", "turn": {"id": "u1", "status": status, "error": error, "items": []}})


def answer():
    notify("item/started", {"threadId": "t1", "turnId": "u1", "item": {"type": "reasoning", "id": "r"}})
    notify("item/completed", {"threadId": "t1", "turnId": "u1", "completedAtMs": 1, "item": {
        "type": "agentMessage", "id": "a", "text": os.environ.get("FAKE_CODEX_ANSWER", '{"answer":"да","count":4}')}})
    finish()


log({"argv": sys.argv[1:]})
for line in sys.stdin:
    message = json.loads(line)
    log(message)
    method, ident = message.get("method"), message.get("id")
    if method is None:
        if ident == "srv1":
            answer()
        continue
    if ident is None:
        continue
    if method == "initialize":
        send({"id": ident, "result": {"codexHome": "/fake", "platformFamily": "unix", "platformOs": "macos", "userAgent": "fake"}})
    elif method == "account/read":
        account = None if MODE == "logged_out" else {"type": "chatgpt", "planType": "plus"}
        send({"id": ident, "result": {"account": account, "requiresOpenaiAuth": True}})
    elif method == "config/read":
        send({"id": ident, "result": {"config": {"mcp_servers": {"docs": {"command": "docs"}}}, "origins": {}}})
    elif method == "thread/start":
        sandbox = {"type": "dangerFullAccess"} if MODE == "unsafe_sandbox" else {"type": "readOnly", "networkAccess": False}
        send({"id": ident, "result": {"thread": {"id": "t1", "ephemeral": True}, "sandbox": sandbox, "model": "gpt-test",
                                      "modelProvider": "openai", "cwd": "/tmp", "approvalPolicy": "never", "approvalsReviewer": "user"}})
    elif method == "mcpServerStatus/list":
        status = "ready" if MODE == "mcp_enabled" else "disabled"
        send({"id": ident, "result": {"data": [{"name": "docs", "runtimeStatus": status}]}})
    elif method == "turn/start":
        send({"id": ident, "result": {"turn": {"id": "u1", "status": "inProgress", "items": []}}})
        if MODE == "tool":
            notify("item/started", {"threadId": "t1", "turnId": "u1", "item": {"type": "commandExecution", "id": "c", "command": "cat secrets"}})
        elif MODE == "approval":
            send({"id": "srv1", "method": "item/commandExecution/requestApproval", "params": {"threadId": "t1", "turnId": "u1", "itemId": "c"}})
        elif MODE == "failed":
            finish("failed", {"message": "limit", "codexErrorInfo": "usageLimitExceeded"})
        else:
            answer()
    elif method == "turn/interrupt":
        send({"id": ident, "result": {}})
        finish("interrupted")
    else:
        send({"id": ident, "error": {"code": -32601, "message": "unknown"}})
