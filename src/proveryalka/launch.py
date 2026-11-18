"""Cross-platform stack preflight; the same checks back the PowerShell launcher."""
import argparse
import asyncio
import json
import os
import re
import shutil
import sys
from pathlib import Path

from .checker.runner import EngineUnavailable, run_process
from .runtime import diagnose
from .config import Settings
from .codegen.settings import CodegenSettings
from .codegen.sandbox import DockerSandbox, SandboxUnavailable
from .deployment import check_frontend


async def preflight(frontend):
    if sys.version_info < (3,10):
        raise RuntimeError('Python 3.10+ is required')
    node=shutil.which('node')
    if node is None:raise RuntimeError('Node.js 22.12+ is required; install it and reopen the terminal')
    result=await run_process([node,'--version'],Path.cwd(),deadline=asyncio.get_running_loop().time()+10)
    match=re.fullmatch(r'v(\d+)\.(\d+)\.\d+\s*',result.stdout)
    if result.returncode or not match or (int(match[1]),int(match[2])) < (22,12):
        raise RuntimeError('Node.js 22.12+ is required for this frontend build')
    check_frontend(Path(frontend))
    result=await diagnose(Settings.from_env())
    # Read-only engine/image probe; never start or remove unrelated containers.
    await DockerSandbox(CodegenSettings.from_env()).probe()
    return {**result,'python':'.'.join(map(str,sys.version_info[:3])),'node':match[0].strip(),'docker':'ready'}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file',default='.env')
    parser.add_argument('--data-dir')
    parser.add_argument('--frontend-dist',default='frontend/dist')
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--check-only',action='store_true')
    args=parser.parse_args(argv)
    from dotenv import load_dotenv
    load_dotenv(args.env_file,override=False)
    if args.data_dir:
        data=Path(args.data_dir).resolve()
        os.environ.update(PROVERYALKA_DATABASE_PATH=str(data/'proveryalka.sqlite3'),
                          PROVERYALKA_ARTIFACTS_PATH=str(data/'artifacts'),PROVERYALKA_CHECK_CACHE=str(data/'check-cache'))
    try:
        result=asyncio.run(preflight(args.frontend_dist))
    except (EngineUnavailable,RuntimeError,ValueError,OSError,SandboxUnavailable,asyncio.TimeoutError) as error:
        # Diagnostic errors from fixed local probes, no environment dump.
        print(json.dumps({'status':'not_ready','reason':str(error)[:500]},ensure_ascii=False))
        return 1
    print(json.dumps({'status':'ready',**result},ensure_ascii=False),flush=True)
    if args.check_only:return 0
    from .deployment import main as serve
    forwarded=['--env-file',args.env_file,'--frontend-dist',args.frontend_dist,'--port',str(args.port)]
    if args.data_dir:forwarded.extend(['--data-dir',args.data_dir])
    return serve(forwarded)

if __name__ == '__main__':
    raise SystemExit(main())
