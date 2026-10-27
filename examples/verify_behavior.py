import argparse
import asyncio
from pathlib import Path

from proveryalka.agent.verification import render_verification, verify_and_explain
from proveryalka.behavior import BehavioralModel
from proveryalka.verification import CommandChecker


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("--version-id", required=True)
    parser.add_argument("--property", action="append", dest="property_ids")
    parser.add_argument("--checker", nargs=argparse.REMAINDER, required=True)
    args = parser.parse_args()
    model = BehavioralModel.model_validate_json(args.model.read_text(encoding="utf-8"))
    async def event_sink(event):
        print(event.model_dump_json(), flush=True)
    outcome = await verify_and_explain(
        model, CommandChecker(args.checker), args.property_ids,
        version_id=args.version_id, on_event=event_sink,
    )
    print(render_verification(outcome))


if __name__ == "__main__":
    asyncio.run(main())
