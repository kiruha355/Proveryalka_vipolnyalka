"""Аналитик через локальный Codex app-server с авторизацией подписки ChatGPT.

Приложение само запускает отдельный процесс `codex app-server` (stdio, JSON-RPC),
открывает эфемерный поток без инструментов и получает один структурированный ответ.
Токены не читаются и не передаются: авторизацию выполняет сам Codex.
Глобальная конфигурация Codex не меняется — отключения действуют только в этом процессе.
"""
import asyncio
import json
import os
import shutil
import signal
import tempfile
from uuid import uuid4

from agents import Model, ModelResponse
from agents.usage import Usage
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from .errors import AgentError


# Возможности Codex, дающие аналитику инструменты, память или внешние действия.
DISABLED_FEATURES = (
    "shell_tool", "unified_exec", "apps", "plugins", "hooks", "memories", "multi_agent",
    "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation",
    "view_image", "goals", "skill_search", "tool_suggest", "sleep_tool", "remote_plugin",
)
# Любой другой элемент хода означает попытку действия, а не анализ: ход прерывается.
ANALYSIS_ITEMS = {"userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"}
ERROR_CODES = {
    "unauthorized": "PROVIDER_AUTH",
    "usageLimitExceeded": "PROVIDER_RATE_LIMIT",
    "rateLimitExceeded": "PROVIDER_RATE_LIMIT",
    "sessionBudgetExceeded": "PROVIDER_RATE_LIMIT",
    "serverOverloaded": "PROVIDER_UNAVAILABLE",
    "internalServerError": "PROVIDER_UNAVAILABLE",
    "modelNotFound": "PROVIDER_NOT_FOUND",
    "contextWindowExceeded": "CONTEXT_LIMIT",
}


def codex_settings():
    return {
        "command": os.getenv("PROVERYALKA_CODEX_BIN", "codex"),
        "model": os.getenv("PROVERYALKA_CODEX_MODEL") or None,
        "effort": os.getenv("PROVERYALKA_CODEX_EFFORT") or None,
    }


class CodexClient:
    """Один процесс app-server на `async with`; запросы внутри него выполняются по очереди."""

    def __init__(self, command="codex", model=None, effort=None):
        self.command = command
        self.model = model
        self.effort = effort
        self.process = None
        self.reader = None
        self.pending = {}
        self.notifications = asyncio.Queue()
        self.lock = asyncio.Lock()
        self.workdir = None
        self.disabled_servers = {}
        self.stderr_tail = []

    @classmethod
    def from_env(cls):
        return cls(**codex_settings())

    async def __aenter__(self):
        executable = shutil.which(self.command)
        if executable is None:
            raise AgentError("PROVIDER_UNAVAILABLE", "Codex CLI не найден; установите его или укажите PROVERYALKA_CODEX_BIN")
        # Пустой каталог: аналитику не нужен доступ к файлам проекта или чужим сессиям.
        self.workdir = tempfile.mkdtemp(prefix="proveryalka-codex-")
        arguments = [executable, "app-server", "--listen", "stdio://", "-c", 'web_search="disabled"']
        for feature in DISABLED_FEATURES:
            arguments += ["-c", f"features.{feature}=false"]
        try:
            self.process = await asyncio.create_subprocess_exec(
                *arguments, cwd=self.workdir, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                start_new_session=True, limit=16 * 1024 * 1024,
            )
        except OSError as error:
            await self.__aexit__(None, None, None)
            raise AgentError("PROVIDER_UNAVAILABLE", "Не удалось запустить Codex app-server") from error
        self.reader = asyncio.create_task(self.read())
        self.drain = asyncio.create_task(self.read_stderr())
        try:
            await self.request("initialize", {"clientInfo": {"name": "proveryalka", "title": "Proveryalka analyst", "version": "0.1.0"}})
            self.notify("initialized")
            account = await self.request("account/read", {"refreshToken": False})
            if account.get("account") is None and account.get("requiresOpenaiAuth", True):
                raise AgentError("PROVIDER_AUTH", "Codex не авторизован: выполните codex login с подпиской ChatGPT")
            config = (await self.request("config/read", {})).get("config") or {}
            self.disabled_servers = {name: {"enabled": False} for name in (config.get("mcp_servers") or {})}
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, *args):
        for task in (self.reader, getattr(self, "drain", None)):
            if task is not None:
                task.cancel()
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 5)
            except (ProcessLookupError, TimeoutError):
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await self.process.wait()
        for future in self.pending.values():
            if not future.done():
                future.set_exception(AgentError("PROVIDER_UNAVAILABLE", "Codex app-server остановлен"))
        if self.workdir is not None:
            shutil.rmtree(self.workdir, ignore_errors=True)
        return False

    def send(self, message):
        self.process.stdin.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))

    def notify(self, method, params=None):
        self.send({"method": method, **({"params": params} if params is not None else {})})

    async def request(self, method, params):
        identifier = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        self.send({"id": identifier, "method": method, "params": params})
        await self.process.stdin.drain()
        try:
            return await future
        finally:
            self.pending.pop(identifier, None)

    async def read_stderr(self):
        # Журнал процесса не передаётся клиентам; хранится хвост для локальной диагностики.
        while line := await self.process.stderr.readline():
            self.stderr_tail = (self.stderr_tail + [line.decode("utf-8", "replace").rstrip()])[-20:]

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if "id" in message and "method" in message:
                    self.refuse(message)
                elif "id" in message:
                    future = self.pending.get(message["id"])
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(AgentError("PROVIDER_ERROR", f"Codex отклонил запрос {message['error'].get('code')}"))
                        else:
                            future.set_result(message.get("result") or {})
                else:
                    self.notifications.put_nowait(message)
        finally:
            error = AgentError("PROVIDER_UNAVAILABLE", "Codex app-server завершился")
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)
            self.notifications.put_nowait({"method": "proveryalka/closed"})

    def refuse(self, message):
        # Разрешения на команды, правки и инструменты аналитику не выдаются.
        method = message["method"]
        if method.endswith("requestApproval"):
            self.send({"id": message["id"], "result": {"decision": "decline"}})
        else:
            self.send({"id": message["id"], "error": {"code": -32601, "message": "Not available for analysis"}})

    async def complete(self, instructions, text, schema=None):
        async with self.lock:
            started = await self.request("thread/start", {
                "ephemeral": True, "cwd": self.workdir, "sandbox": "read-only", "approvalPolicy": "never",
                "developerInstructions": instructions, "model": self.model,
                "config": {"mcp_servers": self.disabled_servers} if self.disabled_servers else None,
            })
            thread_id = started["thread"]["id"]
            # Проверка до первого запроса к модели: без инструментов, сети и записи.
            servers = (await self.request("mcpServerStatus/list", {"threadId": thread_id})).get("data") or []
            if (started.get("sandbox") or {}).get("type") != "readOnly" or any(s.get("runtimeStatus") != "disabled" for s in servers):
                raise AgentError("PROVIDER_ISOLATION", "Codex не подтвердил изоляцию аналитика; запрос к модели не отправлен")
            turn = await self.request("turn/start", {
                "threadId": thread_id, "input": [{"type": "text", "text": text}],
                "outputSchema": schema, "effort": self.effort,
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            })
            turn_id = turn["turn"]["id"]
            answer = None
            while True:
                message = await self.notifications.get()
                method, params = message.get("method"), message.get("params") or {}
                if method == "proveryalka/closed":
                    raise AgentError("PROVIDER_UNAVAILABLE", "Codex app-server завершился до ответа")
                if params.get("threadId") not in (None, thread_id):
                    continue
                item = params.get("item") or {}
                if method == "item/started" and item.get("type") not in ANALYSIS_ITEMS:
                    await self.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
                    raise AgentError("PROVIDER_TOOL_USE", "Аналитик попытался выполнить действие вместо анализа; ход прерван")
                if method == "item/completed" and item.get("type") == "agentMessage":
                    answer = item.get("text")
                if method == "turn/completed":
                    result = params.get("turn") or {}
                    if result.get("status") == "completed" and answer:
                        return answer
                    info = (result.get("error") or {}).get("codexErrorInfo")
                    code = ERROR_CODES.get(info, "PROVIDER_ERROR") if isinstance(info, str) else "PROVIDER_ERROR"
                    raise AgentError(code, f"Codex не завершил ход: {result.get('status')}")


def input_text(input):
    """Агент получает одну строку пользователя; иная история передаётся как JSON, без потери данных."""
    if isinstance(input, str):
        return input
    if len(input) == 1 and isinstance(input[0], dict) and input[0].get("role") == "user" and isinstance(input[0].get("content"), str):
        return input[0]["content"]
    return json.dumps(input, ensure_ascii=False, default=str)


class CodexModel(Model):
    """Модель Agents SDK поверх CodexClient: тот же output_type и та же валидация Pydantic."""

    def __init__(self, client: CodexClient):
        self.client = client

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
        if tools or handoffs:
            raise AgentError("PROVIDER_UNSUPPORTED", "Codex runtime выполняет только анализ без инструментов")
        text = input_text(input)
        schema = None
        if output_schema is not None and not output_schema.is_plain_text():
            schema = output_schema.json_schema()
        answer = await self.client.complete(system_instructions or "", text, schema)
        return ModelResponse(output=[ResponseOutputMessage(
            id="codex_" + uuid4().hex, type="message", role="assistant", status="completed",
            content=[ResponseOutputText(type="output_text", text=answer, annotations=[])],
        )], usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):
        raise AgentError("PROVIDER_UNSUPPORTED", "Потоковый режим не используется")
        yield
