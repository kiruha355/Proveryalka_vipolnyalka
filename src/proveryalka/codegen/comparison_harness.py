"""Trusted comparison test source, staged separately from the candidate in Docker."""

HARNESS = '''"""Compare the candidate's HTTP evaluate adapter with the immutable reference cases."""
import importlib
import json
import os
import sys
from contextlib import ExitStack
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
CANDIDATE = ROOT / "candidate"
ADAPTER = json.loads((ROOT / "adapter.json").read_text(encoding="utf-8"))
CASES = json.loads(Path(__file__).with_name("expected.json").read_text(encoding="utf-8"))
PROBE = CASES[0]


def request(client, case):
    return client.post(ADAPTER["api_prefix"] + "/evaluate",
                       json={"state": case["state"], "transition": case["transition"]})


def response_value(response):
    body = response.json()
    if response.status_code == 200:
        return body["state"]
    return body["error"]["code"]


@pytest.fixture(scope="session")
def adapter():
    with ExitStack() as stack:
        try:
            sys.path.insert(0, str(CANDIDATE))
            # Some projects open resources relative to their project directory.
            os.chdir(CANDIDATE)
            module = importlib.import_module(ADAPTER["module"])
            if not Path(module.__file__).resolve().is_relative_to(CANDIDATE):
                raise ImportError("Adapter module is outside the snapshot")
            app = module.app
            if not callable(app):
                raise TypeError("The adapter must expose an ASGI application")
        except (ImportError, AttributeError, TypeError, SyntaxError):
            yield None, "INCOMPATIBLE_ADAPTER: export an ASGI app from the selected module"
            return
        except Exception:
            yield None, "EXECUTION_ERROR: candidate module could not be initialized"
            return
        try:
            client = stack.enter_context(TestClient(app, raise_server_exceptions=False))
            response = request(client, PROBE)
        except Exception:
            yield None, "EXECUTION_ERROR: candidate app could not start or answer the probe"
            return
        if response.status_code >= 500:
            yield None, "EXECUTION_ERROR: candidate returned a server error during the probe"
            return
        try:
            valid = response.status_code == PROBE["status"] and response_value(response) == PROBE["expected"]
        except (ValueError, KeyError, TypeError):
            valid = False
        if not valid:
            yield None, "INCOMPATIBLE_ADAPTER: evaluate must return 404 UNKNOWN_TRANSITION for an unknown transition"
            return
        yield client, None


def test_adapter_contract(adapter):
    _, failure = adapter
    if failure:
        pytest.fail(failure, pytrace=False)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False)


@pytest.mark.parametrize("case", CASES[1:], ids=[case["key"] for case in CASES[1:]])
def test_transition(case, adapter):
    client, failure = adapter
    if failure:
        pytest.skip("Adapter probe did not complete")
    try:
        response = request(client, case)
    except Exception:
        pytest.fail("EXECUTION_ERROR: candidate failed to answer", pytrace=False)
    if response.status_code >= 500:
        pytest.fail("EXECUTION_ERROR: candidate returned a server error", pytrace=False)
    try:
        actual = canonical(response_value(response))
    except (ValueError, KeyError, TypeError):
        pytest.fail("INCOMPATIBLE_ADAPTER: expected a JSON state or error.code", pytrace=False)
    expected = canonical(case["expected"])
    if response.status_code != case["status"] or actual != expected:
        pytest.fail(f"Expected HTTP {case['status']} {expected[:600]}; "
                    f"received HTTP {response.status_code} {actual[:600]}", pytrace=False)
'''
