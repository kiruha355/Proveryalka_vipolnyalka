"""python -m proveryalka.codegen sandbox-build | sandbox-status"""
import argparse
import asyncio
import json

from .sandbox import DockerSandbox, SandboxUnavailable, build_image
from .settings import CodegenSettings


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m proveryalka.codegen")
    parser.add_argument("command", choices=["sandbox-build", "sandbox-status"])
    args = parser.parse_args(argv)
    settings = CodegenSettings.from_env()
    if args.command == "sandbox-build":
        return asyncio.run(build_image(settings))
    sandbox = DockerSandbox(settings)
    try:
        status = {"status": "ready", **asyncio.run(sandbox.probe()), **sandbox.policy()}
    except SandboxUnavailable as error:
        print(json.dumps({"status": "engine_unavailable", "reason": str(error), **sandbox.policy()}, ensure_ascii=False))
        return 1
    print(json.dumps(status, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
