"""Командная строка ядра проверки.

    python -m proveryalka.checker                 запрос VerificationRequest из stdin, отчёт в stdout (для CommandChecker)
    python -m proveryalka.checker check model.json [--property P] [--timeout S] [--max-states N] [--max-depth D] [--json]
    python -m proveryalka.checker replay data/artifacts/checks/chk_...   повторить прогон по сохранённому комплекту
    python -m proveryalka.checker schema model|request|report             JSON Schema контрактов
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from ..behavior import BehavioralModel
from ..config import Settings
from ..verification.checker import InvalidCheckResult, check_behavior, validate_report
from ..verification.contracts import CheckLimits, VerificationReport, VerificationRequest
from .artifacts import ArtifactError, RunBundle
from .engine import TLCChecker
from .preflight import describe_validation_error


EXIT_INVALID = 2
EXIT_MISMATCH = 3
SCHEMAS = {"model": BehavioralModel, "request": VerificationRequest, "report": VerificationReport}


def print_issues(error, label="MODEL_INVALID"):
    for issue in describe_validation_error(error):
        print(f"{label} {issue}", file=sys.stderr)


def summary(report):
    lines = []
    for result in report.results:
        lines.append(f"{result.property_id}: {result.status} — {result.message}")
        for item in result.trace:
            action = item.transition_id or "начальное состояние"
            state = ", ".join(f"{key}={value!r}" for key, value in item.state.items())
            lines.append(f"  {item.number}. {action}: {state}")
        if result.related_requirements:
            lines.append(f"  требования: {', '.join(result.related_requirements)}")
    return "\n".join(lines)


async def serve(checker):
    try:
        request = VerificationRequest.model_validate_json(sys.stdin.buffer.read())
    except ValidationError as error:
        print_issues(error, "INVALID_REQUEST")
        return EXIT_INVALID
    report = await checker.check(request)
    sys.stdout.write(validate_report(request, report).model_dump_json() + "\n")
    return 0


async def check(checker, arguments):
    try:
        model = BehavioralModel.model_validate_json(Path(arguments.model).read_bytes())
        limits = CheckLimits(timeout_seconds=float(arguments.timeout), max_states=arguments.max_states, max_depth=arguments.max_depth)
    except ValidationError as error:
        print_issues(error)
        return EXIT_INVALID
    try:
        report = await check_behavior(model, checker, arguments.property or None, limits)
    except InvalidCheckResult as error:
        print(f"ENGINE_ERROR {error}", file=sys.stderr)
        return 1
    print(report.model_dump_json(indent=2) if arguments.json else summary(report))
    return 0


async def replay(checker, arguments):
    bundle = RunBundle(Path(arguments.directory).resolve().parent, Path(arguments.directory).name)
    try:
        _, request, saved = bundle.verify()
    except (ArtifactError, ValidationError) as error:
        print(f"Комплект повреждён: {error}", file=sys.stderr)
        return EXIT_INVALID
    checker.cache = None
    run = await checker.run(request)
    report = validate_report(request, run.report)
    same = True
    for old, new in zip(saved.results, report.results):
        match = old.status == new.status and old.trace == new.trace
        same &= match
        print(f"{old.property_id}: {old.status} → {new.status} {'совпадает' if match else 'РАСХОДИТСЯ'}")
    print(f"Новый комплект: {run.directory}")
    return 0 if same else EXIT_MISMATCH


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m proveryalka.checker", description="Проверка BehavioralModel на TLC")
    commands = parser.add_subparsers(dest="command")
    single = commands.add_parser("check", help="проверить файл модели")
    single.add_argument("model")
    single.add_argument("--property", action="append", help="ID свойства; можно повторять")
    single.add_argument("--timeout", default=CheckLimits().timeout_seconds, type=float)
    single.add_argument("--max-states", default=CheckLimits().max_states, type=int)
    single.add_argument("--max-depth", default=None, type=int)
    single.add_argument("--json", action="store_true", help="вывести VerificationReport JSON")
    again = commands.add_parser("replay", help="повторить прогон по каталогу комплекта")
    again.add_argument("directory")
    schema = commands.add_parser("schema", help="напечатать JSON Schema контракта")
    schema.add_argument("contract", choices=sorted(SCHEMAS))
    arguments = parser.parse_args(argv)
    if arguments.command == "schema":
        print(json.dumps(SCHEMAS[arguments.contract].model_json_schema(), ensure_ascii=False, indent=2))
        return 0
    checker = TLCChecker(Settings.from_env())
    if arguments.command == "check":
        return asyncio.run(check(checker, arguments))
    if arguments.command == "replay":
        return asyncio.run(replay(checker, arguments))
    return asyncio.run(serve(checker))


if __name__ == "__main__":
    sys.exit(main())
