import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
from proveryalka import processes
from proveryalka.checker import runner


def test_cancel_owned_process_preserves_unrelated_process(tmp_path):
    async def scenario():
        unrelated=await asyncio.create_subprocess_exec(sys.executable,'-c','import time; time.sleep(60)',**processes.process_options())
        stop=asyncio.Event()
        async def cancel():
            await asyncio.sleep(.2);stop.set()
        timer=asyncio.create_task(cancel())
        try:
            result=await runner.run_process([sys.executable,'-c','import time; time.sleep(60)'],tmp_path,stop=stop)
            assert result.stopped=='cancelled' and result.returncode is not None
            assert unrelated.returncode is None
        finally:
            await timer
            await processes.terminate(unrelated)
    asyncio.run(scenario())


def test_arguments_with_spaces_are_not_interpreted(tmp_path):
    folder=tmp_path/'folder with spaces';folder.mkdir()
    literal='hello $(never-run) & ; world'
    result=asyncio.run(runner.run_process([sys.executable,'-c','import sys; print(sys.argv[1])',literal],folder))
    assert result.returncode==0 and result.stdout.strip()==literal


def test_windows_termination_uses_only_owned_pid(monkeypatch):
    calls=[]
    class Process:
        pid=12345
        returncode=None
        async def wait(self):self.returncode=0;return 0
        def kill(self):self.returncode=-1
    async def spawn(*args,**kwargs):
        calls.append((args,kwargs));return Process()
    monkeypatch.setattr(processes,'IS_WINDOWS',True)
    monkeypatch.setattr(processes.asyncio,'create_subprocess_exec',spawn)
    process=Process();asyncio.run(processes.terminate(process))
    assert calls[0][0][1:]==('/PID','12345','/T','/F')
    assert not calls[0][1].get('shell')
    assert process.returncode is not None


def test_java_home_and_explicit_java_precede_path(monkeypatch,tmp_path):
    jar=tmp_path/'tlc.jar';jar.write_bytes(b'fixture')
    java_home=tmp_path/'Java 21';monkeypatch.setenv('JAVA_HOME',str(java_home))
    monkeypatch.delenv('PROVERYALKA_JAVA',raising=False)
    selected=[]
    monkeypatch.setattr(runner.shutil,'which',lambda path:selected.append(path) or path)
    async def probe(command,*args,**kwargs):
        text='openjdk version "21.0.1"' if command[-1]=='-version' and '-cp' not in command else 'TLC2 Version 2.20'
        return runner.ProcessResult(command,0,text,'',0)
    monkeypatch.setattr(runner,'run_process',probe)
    asyncio.run(runner.detect_engine('java',jar))
    assert Path(selected[-1]).parent==java_home/'bin'
    asyncio.run(runner.detect_engine('/explicit Java/bin/java',jar))
    assert selected[-1]=='/explicit Java/bin/java'
    async def old(command,*args,**kwargs):return runner.ProcessResult(command,0,'','java version "1.8.0_402"',0)
    monkeypatch.setattr(runner,'run_process',old)
    with pytest.raises(runner.EngineUnavailable,match='PROVERYALKA_JAVA'):
        asyncio.run(runner.detect_engine('java',jar))


def test_launcher_reports_docker_failure_without_starting_server(monkeypatch,capsys):
    from proveryalka import launch
    from proveryalka.codegen.sandbox import SandboxUnavailable
    async def fail(*args):raise SandboxUnavailable('Docker daemon unavailable')
    monkeypatch.setattr(launch,'preflight',fail)
    assert launch.main(['--check-only','--env-file','absent.env'])==1
    assert 'Docker daemon unavailable' in capsys.readouterr().out
