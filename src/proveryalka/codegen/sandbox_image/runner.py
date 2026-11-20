"""Запуск pytest для проекта в /job (только чтение) и сводка результата одной строкой JSON в stdout.

Вывод pytest идёт в stderr. Файл находится в образе песочницы, а не в проверяемом проекте.
Сводку формирует процесс в том же контейнере, что и тесты: песочница защищает хост, но не
гарантирует подлинность счётчиков против намеренно враждебного проекта.
"""
import json
import os
import platform
import subprocess
import sys
import xml.etree.ElementTree as ElementTree


PROTOCOL = "proveryalka-sandbox/1"
JUNIT = "/tmp/runner/junit.xml"
MAX_CASES = 5000
MAX_MESSAGE = 2000


def outcome(case):
    for child in case:
        if child.tag in ("failure", "error", "skipped"):
            kind = {"failure": "failed", "error": "error", "skipped": "skipped"}[child.tag]
            return kind, (child.get("message") or child.text or "")[:MAX_MESSAGE] or None
    return "passed", None


def summary():
    root = ElementTree.parse(JUNIT).getroot()
    counts = {"total": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0}
    cases = []
    for case in root.iter("testcase"):
        kind, message = outcome(case)
        counts["total"] += 1
        counts[{"passed": "passed", "failed": "failed", "error": "errors", "skipped": "skipped"}[kind]] += 1
        if len(cases) < MAX_CASES:
            try:
                duration = float(case.get("time"))
            except (TypeError, ValueError):
                duration = None
            cases.append({"name": case.get("name") or "", "classname": case.get("classname") or "",
                          "outcome": kind, "duration_seconds": duration, "message": message})
    return counts, cases


def main():
    os.makedirs(os.path.dirname(JUNIT), mode=0o700, exist_ok=True)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "TMPDIR": "/tmp", "LANG": "C.UTF-8",
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"}
    command = [sys.executable, "-B", "-m", "pytest", "-p", "no:cacheprovider", "-q", "-rfE",
               f"--junitxml={JUNIT}", "-o", "junit_family=xunit2"]
    process = subprocess.run(command, cwd="/job", env=env, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr)
    result = {"protocol": PROTOCOL, "pytest_exit_code": process.returncode, "python": platform.python_version(),
              "counts": None, "cases": [], "cases_truncated": False}
    try:
        counts, cases = summary()
        result.update(counts=counts, cases=cases, cases_truncated=counts["total"] > len(cases))
    except (OSError, ElementTree.ParseError):
        pass
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
