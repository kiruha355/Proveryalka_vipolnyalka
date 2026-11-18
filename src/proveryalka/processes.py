"""Lifecycle of subprocess trees owned by this application, without a shell."""
import asyncio
import os
import signal
import subprocess
from pathlib import Path

IS_WINDOWS = os.name == 'nt'


def process_options():
    return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WINDOWS else {'start_new_session': True}


async def terminate(process, grace=2.0):
    if process.returncode is not None:
        return
    if IS_WINDOWS:
        # Numeric PID from our live Process object, never image names or arbitrary input.
        # taskkill /T confines termination to this parent's descendants; no global kill.
        taskkill = str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'taskkill.exe')
        try:
            killer = await asyncio.create_subprocess_exec(taskkill, '/PID', str(process.pid), '/T', '/F',
                        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL)
            try:
                await asyncio.wait_for(killer.wait(), max(grace, 5.0))
            except asyncio.TimeoutError:
                killer.kill()
                await killer.wait()
        except OSError:
            pass
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        try:
            await asyncio.wait_for(process.wait(), grace)
            return
        except asyncio.TimeoutError:
            continue
    await process.wait()
