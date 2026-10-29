import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..verification.checker import CheckerError, check_behavior, make_request, spec_hash, validate_trace
from ..verification.contracts import EngineInfo, VerificationReport, VerificationResult
from .artifacts import ArtifactStore, new_run_id, now, remove_tree
from .cache import ResultCache
from .parser import Outcome, interpret, trace_changes
from .preflight import preflight
from .runner import EngineUnavailable, detect_engine, run_process
from .spec import COMPILER_VERSION, MODULE, generate


ENGINE_NAME = "TLC"
SANY_ERRORS = ("*** Errors", "Fatal errors", "***Parse Error***")


@dataclass
class CheckRun:
    """Результат одного запуска для серверного адаптера: отчёт и ссылка на комплект материалов."""
    run_id: str
    report: VerificationReport
    directory: Path | None
    cached: list[str] = field(default_factory=list)

    def files(self):
        return [] if self.directory is None else json.loads((self.directory / "manifest.json").read_text(encoding="utf-8"))["files"]


class TLCChecker:
    """Адаптер BehaviorChecker поверх настоящих SANY и TLC; без LLM и HTTP."""

    def __init__(self, settings: Settings | None = None, *, cache: ResultCache | None | bool = True):
        self.settings = settings or Settings.from_env()
        self.store = ArtifactStore(self.settings.artifacts_path / "checks")
        if cache is True:
            cache = ResultCache(self.settings.check_cache_path) if self.settings.check_cache_path else None
        self.cache = cache or None
        self._engine = None
        self._engine_lock = asyncio.Lock()
        self._stops: dict[str, asyncio.Event] = {}

    async def engine(self):
        async with self._engine_lock:
            if self._engine is None:
                self._engine = await detect_engine(self.settings.java_path, self.settings.tla_jar)
            return self._engine

    async def check(self, request):
        return (await self.run(request)).report

    def cancel(self, run_id):
        """Останавливает запуск: процессы TLC завершаются, незавершённые свойства получают CANCELLED."""
        stop = self._stops.get(run_id)
        if stop is None:
            return False
        stop.set()
        return True

    async def run(self, request, run_id=None):
        loop = asyncio.get_running_loop()
        # Свой срок чуть раньше внешнего таймаута, чтобы успеть остановить TLC и записать материалы.
        budget = request.limits.timeout_seconds
        deadline = loop.time() + max(budget - min(1.0, budget * 0.1), budget * 0.5)
        started = time.monotonic()
        run_id = run_id or new_run_id()
        model_hash = spec_hash(request.model)
        issues = preflight(request.model)
        if issues:
            message = "MODEL_INVALID: " + "; ".join(str(issue) for issue in issues)
            return CheckRun(run_id, self.report(request, model_hash, None, {p: Outcome("MODEL_INVALID", message) for p in request.property_ids}), None)
        try:
            engine = await self.engine()
        except EngineUnavailable as error:
            outcome = Outcome("ENGINE_ERROR", f"ENGINE_UNAVAILABLE: {error}")
            return CheckRun(run_id, self.report(request, model_hash, None, {p: outcome for p in request.property_ids}), None)
        info = EngineInfo(name=ENGINE_NAME, version=engine.version)
        results, cached = {}, []
        if self.cache is not None:
            for identifier in request.property_ids:
                hit = self.cache.get(request, identifier, engine.version, model_hash)
                if hit is not None:
                    results[identifier] = hit
                    cached.append(identifier)
        bundle = self.store.create(run_id)
        stop = self._stops[bundle.run_id] = asyncio.Event()
        manifest = {
            "created_at": now(), "spec_hash": model_hash, "version_id": request.version_id,
            "engine": {"name": ENGINE_NAME, "version": engine.version, "tlc": engine.tlc_version,
                       "jar_sha256": engine.jar_sha256, "java_major": engine.java_version},
            "compiler_version": COMPILER_VERSION, "limits": request.limits.model_dump(mode="json"),
            "heap_mb": self.settings.tlc_heap_mb, "cached_properties": cached, "steps": [],
        }
        try:
            bundle.write("request.json", request.model_dump_json(indent=2))
            pending = [p for p in request.property_ids if p not in results]
            outcomes = await self.execute(request, engine, bundle, pending, deadline, stop, manifest) if pending else {}
        except asyncio.CancelledError:
            # Внешняя отмена (например, таймаут вызывающего): процессы уже остановлены, материалы сохраняем.
            manifest.update(interrupted=True, finished_at=now())
            bundle.finish(manifest)
            raise
        finally:
            self._stops.pop(bundle.run_id, None)
        report = self.report(request, model_hash, info, outcomes, results)
        for result in report.results:
            if self.cache is not None and result.property_id not in cached:
                self.cache.put(result)
        bundle.write("report.json", report.model_dump_json(indent=2))
        manifest["elapsed_seconds"] = round(time.monotonic() - started, 3)
        manifest["finished_at"] = now()
        bundle.finish(manifest)
        return CheckRun(bundle.run_id, report, bundle.path, cached)

    async def execute(self, request, engine, bundle, pending, deadline, stop, manifest):
        properties = {prop.id: prop for prop in request.model.properties}
        spec = generate(request.model, request.limits, f"spec_hash {manifest['spec_hash']}")
        bundle.write(f"{MODULE}.tla", spec.text)
        sany = await self.process(engine, "tla2sany.SANY", [f"{MODULE}.tla"], bundle, "sany", deadline, stop)
        manifest["steps"].append(self.step("sany", sany))
        if sany.stopped or sany.returncode != 0 or any(mark in sany.stdout for mark in SANY_ERRORS):
            if sany.stopped == "timeout":
                outcome = Outcome("TIMEOUT", "Время истекло во время разбора SANY", reason="timeout")
            elif sany.stopped == "cancelled":
                outcome = Outcome("ENGINE_ERROR", "CANCELLED: проверка остановлена по запросу", reason="cancelled")
            elif any(mark in sany.stdout for mark in SANY_ERRORS):
                outcome = Outcome("ENGINE_ERROR", f"SANY отклонил сгенерированную спецификацию: {sany.stdout.strip()[-1000:]}", reason="sany")
            else:
                output = (sany.stderr or sany.stdout).strip()[-1000:]
                outcome = Outcome("ENGINE_ERROR", f"SANY завершился с кодом {sany.returncode}: {output}", reason="engine")
            return {identifier: outcome for identifier in pending}
        semaphore = asyncio.Semaphore(max(1, self.settings.tlc_parallel))

        async def check_property(identifier):
            async with semaphore:
                prop = properties[identifier]
                directory = f"properties/{identifier}"
                bundle.write(f"{directory}/{MODULE}.cfg", spec.config(identifier))
                arguments = [
                    "-tool", "-workers", "1", "-fp", "1", "-deadlock", "-noGenerateSpecTE",
                    "-metadir", f"{directory}/states", "-dumpTrace", "json", f"{directory}/trace.json",
                    "-config", f"{directory}/{MODULE}.cfg", f"{MODULE}.tla",
                ]
                if stop.is_set() or asyncio.get_running_loop().time() >= deadline:
                    reason = "cancelled" if stop.is_set() else "timeout"
                    return identifier, Outcome(
                        "ENGINE_ERROR" if stop.is_set() else "TIMEOUT",
                        "CANCELLED: проверка остановлена до запуска TLC" if stop.is_set() else "Время истекло до запуска TLC для этого свойства",
                        reason=reason,
                    )
                result = await self.process(engine, "tlc2.TLC", arguments, bundle, f"{directory}/tlc", deadline, stop)
                remove_tree(bundle.file(f"{directory}/states"))
                outcome = interpret(result, prop, request.model, spec, bundle.file(f"{directory}/trace.json"), request.limits)
                outcome = self.confirm(request, prop, outcome)
                step = self.step(f"tlc:{identifier}", result)
                step.update(status=outcome.status, reason=outcome.reason)
                manifest["steps"].append(step)
                if outcome.trace:
                    bundle.write(f"{directory}/changes.json", json.dumps(trace_changes(outcome.trace), ensure_ascii=False, indent=2))
                return identifier, outcome

        return dict(await asyncio.gather(*(check_property(identifier) for identifier in pending)))

    async def process(self, engine, main, arguments, bundle, name, deadline, stop):
        tmpdir = bundle.file(f"{name}.tmp")
        tmpdir.mkdir(parents=True, exist_ok=True)
        command = engine.command(main, arguments, self.settings.tlc_heap_mb, tmpdir)
        try:
            result = await run_process(command, bundle.path, deadline, stop)
        finally:
            remove_tree(tmpdir)
        bundle.write(f"{name}.stdout.log", result.stdout)
        bundle.write(f"{name}.stderr.log", result.stderr)
        return result

    def step(self, name, result):
        # Путь к jar и каталогам сохраняется относительно комплекта; окружение процесса не пишется.
        command = [part.replace(str(self._engine.jar), "tla2tools.jar") if self._engine else part for part in result.command]
        return {
            "name": name, "command": [part for part in command if not part.startswith("-Djava.io.tmpdir=")],
            "returncode": result.returncode, "stopped": result.stopped,
            "elapsed_seconds": round(result.elapsed_seconds, 3),
        }

    def confirm(self, request, prop, outcome):
        """Независимая сверка окончательного результата с семантикой модели; сбой не превращается в успех."""
        if outcome.status not in {"PROPERTY_HOLDS", "PROPERTY_VIOLATED"}:
            return outcome
        probe = VerificationResult(
            spec_hash="0" * 64, mode="engine", executed=True, engine=EngineInfo(name=ENGINE_NAME, version="-"),
            limits=request.limits, property_id=prop.id, status=outcome.status, conclusive=True,
            message=outcome.message, trace=outcome.trace,
        )
        try:
            validate_trace(request.model, prop, probe, request.limits)
        except ValueError as error:
            return Outcome("ENGINE_ERROR", f"Результат TLC не согласуется с моделью: {error}", statistics=outcome.statistics, reason="mismatch")
        return outcome

    def report(self, request, model_hash, info, outcomes, ready=None):
        results = []
        for identifier in request.property_ids:
            if ready and identifier in ready:
                results.append(ready[identifier])
                continue
            outcome = outcomes[identifier]
            executed = info is not None
            results.append(VerificationResult(
                spec_hash=model_hash, version_id=request.version_id, mode="engine", executed=executed,
                engine=info, limits=request.limits, property_id=identifier, status=outcome.status,
                conclusive=outcome.status in {"PROPERTY_HOLDS", "PROPERTY_VIOLATED"},
                message=outcome.message, trace=outcome.trace, statistics=outcome.statistics,
            ))
        return VerificationReport(results=results)


async def check_with_tlc(model, property_ids=None, limits=None, *, version_id=None, settings=None):
    """Публичный вызов без веб-сервера: валидация, компиляция, SANY/TLC и разбор с общей проверкой отчёта."""
    return await check_behavior(model, TLCChecker(settings), property_ids, limits, version_id=version_id)


__all__ = ["CheckRun", "CheckerError", "TLCChecker", "check_with_tlc", "make_request"]
