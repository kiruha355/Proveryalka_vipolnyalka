"""Запуск тестов сгенерированного проекта в контейнере Docker с ограничениями.

Политика: без сети, rootfs только для чтения, пользователь 10001 без capabilities и
no-new-privileges, лимиты памяти без swap, CPU и числа процессов, /tmp — tmpfs с noexec,
проект смонтирован только для чтения, переменные окружения и секреты хоста не передаются,
Docker socket не монтируется. Время ограничивает хост: по таймауту или отмене контейнер
останавливается и удаляется. Песочница проверяет код на хосте безопасно, но не заменяет TLC.
"""
import asyncio
import json
import os
import re
import shutil
import signal
import stat
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from .paths import safe_path
from .settings import IMAGE_DIR, CodegenSettings


PROTOCOL = "proveryalka-sandbox/1"
LABEL = "proveryalka.codegen.test_run"
OWNER_LABEL = "proveryalka.codegen.owner"
USER = "10001:10001"
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$")
UNKNOWN_COUNTS = {"total": None, "passed": None, "failed": None, "errors": None, "skipped": None}


class SandboxUnavailable(Exception):
    pass


async def run_tool(command, timeout=30.0, limit=1 << 20):
    """Короткий вызов CLI Docker без shell: (код, stdout, stderr); недоступный бинарник → SandboxUnavailable."""
    try:
        process = await asyncio.create_subprocess_exec(
            *command, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True,
        )
    except OSError as error:
        raise SandboxUnavailable(f"Docker CLI unavailable: {error.strerror or error}") from error
    try:
        out, err = await asyncio.wait_for(process.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        kill_group(process)
        await process.wait()
        raise
    return process.returncode, out[:limit].decode("utf-8", "replace"), err[:limit].decode("utf-8", "replace")


def kill_group(process):
    if process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


async def read_capped(stream, limit):
    kept, size, total = [], 0, 0
    while True:
        chunk = await stream.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if size < limit:
            part = chunk[: limit - size]
            kept.append(part)
            size += len(part)
    return b"".join(kept), total > limit


def write_job(directory, files):
    """Пишет проверенные файлы и снимает права записи: в контейнер монтируется копия только для чтения."""
    root = Path(directory)
    for path, content in files:
        target = root / safe_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(0o444)
    for folder in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        folder.chmod(0o555)
    root.chmod(0o555)


def remove_job(directory):
    for folder, _, _ in os.walk(directory):
        os.chmod(folder, stat.S_IRWXU)
    shutil.rmtree(directory)


def parse_summary(stdout):
    for line in reversed(stdout.decode("utf-8", "replace").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("protocol") == PROTOCOL and type(data.get("pytest_exit_code")) is int:
            return data
    return None


def counts_of(summary):
    counts = (summary or {}).get("counts")
    if not isinstance(counts, dict) or any(type(counts.get(k)) is not int or counts[k] < 0 for k in UNKNOWN_COUNTS):
        return dict(UNKNOWN_COUNTS)
    return {k: counts[k] for k in UNKNOWN_COUNTS}


def cases_of(summary):
    cases = []
    for item in (summary or {}).get("cases") or []:
        if isinstance(item, dict) and item.get("outcome") in ("passed", "failed", "error", "skipped"):
            duration = item.get("duration_seconds")
            message = item.get("message")
            cases.append({"name": str(item.get("name", ""))[:500], "classname": str(item.get("classname", ""))[:500],
                          "outcome": item["outcome"], "duration_seconds": duration if isinstance(duration, (int, float)) and not isinstance(duration, bool) else None,
                          "message": str(message)[:2000] if message is not None else None})
    return cases


def classify(summary, stopped, container, timeout_seconds):
    """(status, error_code, message) по сводке runner, причине остановки и состоянию контейнера."""
    if stopped == "cancelled":
        return "cancelled", "CANCELLED", "Запуск отменён; контейнер остановлен и удалён"
    if stopped == "timeout":
        return "timeout", "TIMEOUT", f"Тесты не завершились за {timeout_seconds:g} с; контейнер остановлен и удалён"
    if container.get("OOMKilled"):
        return "failed", "OOM_KILLED", "Процесс превысил лимит памяти песочницы и был остановлен"
    if summary is None:
        if container.get("ExitCode") in (125, 126, 127):
            return "engine_unavailable", "SANDBOX_START_FAILED", "Docker не смог запустить контейнер песочницы"
        return "error", "SANDBOX_OUTPUT_INVALID", "Песочница не вернула сводку результатов"
    code = summary["pytest_exit_code"]
    counts = counts_of(summary)
    if code == 0:
        if counts["total"]:
            return "passed", None, f"Пройдено {counts['passed']} из {counts['total']}"
        return "failed", "NO_TESTS", "Тесты не найдены"
    if code == 1:
        return "failed", "TESTS_FAILED", f"Не пройдено {counts['failed']} и ошибок {counts['errors']} из {counts['total']}" if counts["total"] is not None else "Тесты не пройдены"
    if code == 5:
        return "failed", "NO_TESTS", "Тесты не найдены"
    if code < 0:
        return "failed", f"PYTEST_SIGNAL_{-code}", f"pytest остановлен сигналом {-code}"
    return "failed", f"PYTEST_EXIT_{code}", f"pytest завершился с кодом {code}"


class DockerSandbox:
    def __init__(self, settings=None):
        self.settings = settings or CodegenSettings.from_env()
        # A service instance has no authority over another instance, even on the
        # same host/daemon. Unknown/legacy owners require manual reconciliation.
        self.owner_id = uuid4().hex
        self._active_names = set()

    def policy(self):
        s = self.settings
        return {"engine": "docker", "image": s.image, "network": "none", "read_only_root": True, "user": USER,
                "capabilities": [], "no_new_privileges": True, "memory_mb": s.memory_mb, "swap_mb": 0,
                "cpus": s.cpus, "pids_limit": s.pids_limit, "tmpfs_mb": s.tmpfs_mb, "project_mount": "read-only"}

    def command(self, name, job_dir, run_label):
        s = self.settings
        source = str(job_dir)
        if not NAME.match(name) or not NAME.match(run_label) or any(char in source for char in ",\"'\n="):
            raise ValueError("Unsafe container name or job directory")
        return [
            s.docker, "run", "--name", name, "--label", f"{LABEL}={run_label}",
            "--label", f"{OWNER_LABEL}={self.owner_id}",
            "--network", "none", "--read-only", "--user", USER,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--memory", f"{s.memory_mb}m", "--memory-swap", f"{s.memory_mb}m",
            "--cpus", f"{s.cpus:g}", "--pids-limit", str(s.pids_limit),
            "--ulimit", "nofile=1024:1024", "--ulimit", "core=0",
            "--tmpfs", f"/tmp:rw,nosuid,nodev,noexec,size={s.tmpfs_mb}m,mode=1777",
            "--mount", f"type=bind,source={source},target=/job,readonly",
            "--workdir", "/job", "--init", "--log-driver", "none", "--stop-timeout", "1",
            s.image,
        ]

    async def probe(self):
        code, out, err = await run_tool([self.settings.docker, "version", "--format", "{{.Server.Version}}"], timeout=20)
        if code != 0 or not out.strip():
            raise SandboxUnavailable(f"Docker daemon unavailable: {(err or out).strip()[:300]}")
        version = out.strip()
        code, out, err = await run_tool([self.settings.docker, "image", "inspect", "--format", "{{.Id}}", self.settings.image], timeout=20)
        if code != 0 or not out.strip():
            raise SandboxUnavailable(f"Sandbox image {self.settings.image} is not built; run python -m proveryalka.codegen sandbox-build")
        return {"engine_version": version, "image_id": out.strip()}

    async def inspect(self, name):
        try:
            code, out, _ = await run_tool([self.settings.docker, "inspect", "--format", "{{json .State}}", name], timeout=20)
            return json.loads(out) if code == 0 else {}
        except (SandboxUnavailable, ValueError, asyncio.TimeoutError):
            return {}

    async def owned_container(self, name):
        """Resolve an immutable container ID after checking this instance's label."""
        try:
            code, out, _ = await run_tool([self.settings.docker, "inspect", "--format", "{{json .}}", name], timeout=20)
            data = json.loads(out) if code == 0 else {}
            labels = (data.get("Config") or {}).get("Labels") or {}
            if labels.get(OWNER_LABEL) == self.owner_id and labels.get(LABEL) and re.fullmatch(r"[0-9a-f]{64}", data.get("Id", "")):
                return data
        except (SandboxUnavailable, ValueError, asyncio.TimeoutError):
            pass
        return None

    async def remove(self, name):
        try:
            container = await self.owned_container(name)
            if container:
                await run_tool([self.settings.docker, "rm", "-f", container["Id"]], timeout=30)
        except (SandboxUnavailable, asyncio.TimeoutError):
            pass

    async def stop_container(self, name):
        try:
            container = await self.owned_container(name)
            if container:
                await run_tool([self.settings.docker, "kill", container["Id"]], timeout=20)
        except (SandboxUnavailable, asyncio.TimeoutError):
            pass

    async def cleanup_orphans(self):
        """Remove only stopped, inactive containers proven to belong to this instance.

        A label shared by the application is not proof of an orphan. In particular,
        never infer another host/process is dead from a local PID or missing lock.
        """
        try:
            code, out, _ = await run_tool([self.settings.docker, "ps", "-aq", "--filter", f"label={LABEL}",
                                         "--filter", f"label={OWNER_LABEL}={self.owner_id}", "--filter", "status=exited"], timeout=20)
        except (SandboxUnavailable, asyncio.TimeoutError):
            return 0
        if code != 0:
            return 0
        ids = [line for line in out.split() if re.fullmatch(r"[0-9a-f]{12,64}", line)]
        removed = 0
        for identifier in ids:
            container = await self.owned_container(identifier)
            if not container or container.get("Name", "").lstrip("/") in self._active_names:
                continue
            if (container.get("State") or {}).get("Status") != "exited":
                continue
            # No force: a concurrent restart must turn this into a failed rm,
            # never a kill. Use the checked ID, not a reusable container name.
            try:
                code, _, _ = await run_tool([self.settings.docker, "rm", container["Id"]], timeout=30)
                removed += code == 0
            except (SandboxUnavailable, asyncio.TimeoutError):
                pass
        return removed

    async def run(self, files, *, run_id, timeout_seconds, stop=None):
        """files: [(path, bytes)] уже сверенные с SHA-256 генерации. Возвращает (result, log)."""
        started = time.monotonic()
        sandbox = self.policy()
        try:
            sandbox.update(await self.probe())
        except (SandboxUnavailable, asyncio.TimeoutError) as error:
            message = str(error) or "Docker did not answer"
            return self.result("engine_unavailable", "ENGINE_UNAVAILABLE", message, None, None, sandbox, started, None), None
        name = f"pv-codegen-{run_id}-{uuid4().hex[:12]}"
        job = tempfile.mkdtemp(prefix="pv-codegen-job-")
        stopped, stopper, container = None, None, {}
        self._active_names.add(name)
        try:
            write_job(job, files)
            try:
                process = await asyncio.create_subprocess_exec(
                    *self.command(name, job, run_id), stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
                )
            except OSError as error:
                return self.result("engine_unavailable", "ENGINE_UNAVAILABLE", f"Docker CLI unavailable: {error}", None, None, sandbox, started, None), None
            output = asyncio.ensure_future(read_capped(process.stdout, self.settings.output_limit_bytes))
            errors = asyncio.ensure_future(read_capped(process.stderr, self.settings.log_limit_bytes))
            waiter = asyncio.ensure_future(process.wait())
            waiters = {waiter}
            if stop is not None:
                stopper = asyncio.ensure_future(stop.wait())
                waiters.add(stopper)
            try:
                done, _ = await asyncio.wait(waiters, timeout=timeout_seconds, return_when=asyncio.FIRST_COMPLETED)
                if waiter not in done:
                    stopped = "cancelled" if stopper is not None and stopper in done else "timeout"
                    await self.stop_container(name)
                    try:
                        await asyncio.wait_for(asyncio.shield(waiter), 20)
                    except asyncio.TimeoutError:
                        kill_group(process)
                        await waiter
                (stdout, _), (stderr, truncated) = await asyncio.gather(output, errors)
            except asyncio.CancelledError:
                await self.stop_container(name)
                kill_group(process)
                raise
            container = await self.inspect(name)
        finally:
            if stopper is not None:
                stopper.cancel()
            await self.remove(name)
            self._active_names.discard(name)
            remove_job(job)
        summary = None if stopped else parse_summary(stdout)
        status, code, message = classify(summary, stopped, container, timeout_seconds)
        sandbox.update(container_exit_code=container.get("ExitCode"), oom_killed=bool(container.get("OOMKilled")))
        log = stderr.decode("utf-8", "replace")
        if truncated:
            log += f"\n[журнал обрезан до {self.settings.log_limit_bytes} байт]\n"
        return self.result(status, code, message, summary, truncated, sandbox, started, container), log

    @staticmethod
    def result(status, code, message, summary, truncated, sandbox, started, container):
        return {
            "status": status, "error_code": code, "message": message,
            "exit_code": summary["pytest_exit_code"] if summary else None,
            "counts": counts_of(summary), "cases": cases_of(summary),
            "cases_truncated": bool((summary or {}).get("cases_truncated")),
            "python": (summary or {}).get("python"),
            "duration_seconds": round(time.monotonic() - started, 3),
            "sandbox": sandbox, "log_truncated": truncated,
        }


async def build_image(settings=None):
    """Сборка образа песочницы (нужна сеть для зависимостей по хэшам); запуск тестов идёт офлайн."""
    settings = settings or CodegenSettings.from_env()
    process = await asyncio.create_subprocess_exec(
        settings.docker, "build", "--tag", settings.image, "--label", "proveryalka.codegen.sandbox=1", str(IMAGE_DIR),
    )
    return await process.wait()
