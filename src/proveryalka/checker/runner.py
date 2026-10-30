import asyncio
import hashlib
import os
import re
import shutil
import signal
import time
from dataclasses import dataclass
from pathlib import Path


MIN_JAVA = 11
VERSION = re.compile(r"TLC2 Version (\S+)(?: \(rev: (\w+)\))?")
JAVA_VERSION = re.compile(r'version "(\d+)(?:\.(\d+))?')
# Единый формат чисел и сообщений TLC независимо от локали машины.
JVM_OPTIONS = ("-XX:+UseParallelGC", "-Duser.language=en", "-Duser.country=US", "-Dfile.encoding=UTF-8")


class EngineUnavailable(Exception):
    pass


@dataclass(frozen=True)
class Engine:
    java: str
    jar: Path
    java_version: str
    tlc_version: str
    jar_sha256: str

    @property
    def version(self):
        """Версия для отчёта и ключа кэша: сборка TLC и отпечаток конкретного jar."""
        return f"{self.tlc_version} jar:{self.jar_sha256[:12]}"

    def command(self, main, arguments, heap_mb, tmpdir):
        return [
            self.java, f"-Xmx{heap_mb}m", *JVM_OPTIONS, f"-Djava.io.tmpdir={tmpdir}",
            "-cp", str(self.jar), main, *arguments,
        ]


@dataclass(frozen=True)
class ProcessResult:
    command: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    elapsed_seconds: float
    stopped: str | None = None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def run_process(command, cwd, deadline=None, stop=None):
    """Запускает процесс без shell в отдельной группе; по таймауту или отмене завершает всю группу."""
    started = time.monotonic()
    loop = asyncio.get_running_loop()
    try:
        process = await asyncio.create_subprocess_exec(
            *command, cwd=cwd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        raise EngineUnavailable(f"Не удалось запустить {command[0]}: {error}") from error
    communicate = asyncio.ensure_future(process.communicate())
    waiters = {communicate}
    stopper = asyncio.ensure_future(stop.wait()) if stop is not None else None
    if stopper:
        waiters.add(stopper)
    stopped = None
    try:
        timeout = None if deadline is None else max(0.0, deadline - loop.time())
        done, _ = await asyncio.wait(waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if communicate not in done:
            stopped = "cancelled" if stopper in done else "timeout"
            await terminate(process)
        output, error_output = await communicate
    except asyncio.CancelledError:
        await terminate(process)
        communicate.cancel()
        raise
    finally:
        if stopper:
            stopper.cancel()
    return ProcessResult(
        command=list(command), returncode=process.returncode,
        stdout=output.decode("utf-8", errors="replace"), stderr=error_output.decode("utf-8", errors="replace"),
        elapsed_seconds=time.monotonic() - started, stopped=stopped,
    )


async def terminate(process, grace=2.0):
    """Сначала SIGTERM всей группе (JVM и её потомки), затем SIGKILL, если процесс не вышел."""
    if process.returncode is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=grace)
            return
        except asyncio.TimeoutError:
            continue


async def detect_engine(java=None, jar=None):
    """Проверяет совместимую Java и tla2tools.jar, фиксирует версию TLC."""
    java_path = shutil.which(java or "java")
    if java_path is None:
        raise EngineUnavailable("Java не найдена: установите JDK 11+ или задайте PROVERYALKA_JAVA")
    if jar is None or not Path(jar).is_file():
        raise EngineUnavailable(f"tla2tools.jar не найден: {jar}; задайте PROVERYALKA_TLA_JAR")
    jar = Path(jar).resolve()
    probe = await run_process([java_path, "-version"], cwd=jar.parent, deadline=asyncio.get_running_loop().time() + 30)
    match = JAVA_VERSION.search(probe.stderr + probe.stdout)
    if probe.returncode != 0 or match is None:
        raise EngineUnavailable(f"Не удалось определить версию Java: {probe.stderr.strip()[:200]}")
    major = int(match.group(2)) if match.group(1) == "1" else int(match.group(1))
    if major < MIN_JAVA:
        raise EngineUnavailable(f"Нужна Java {MIN_JAVA}+, найдена {major}")
    # У TLC нет отдельного флага версии: заголовок печатается до разбора аргументов.
    probe = await run_process(
        [java_path, *JVM_OPTIONS, "-cp", str(jar), "tlc2.TLC", "-version"],
        cwd=jar.parent, deadline=asyncio.get_running_loop().time() + 30,
    )
    version = VERSION.search(probe.stdout + probe.stderr)
    if version is None:
        raise EngineUnavailable(f"Файл {jar.name} не похож на tla2tools.jar: {(probe.stdout + probe.stderr).strip()[:200]}")
    tlc_version = version.group(1) + (f" rev {version.group(2)}" if version.group(2) else "")
    return Engine(
        java=java_path, jar=jar, java_version=str(major),
        tlc_version=tlc_version, jar_sha256=file_sha256(jar),
    )
