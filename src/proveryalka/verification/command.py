import asyncio
from collections.abc import Sequence

from pydantic import ValidationError

from .checker import CheckerError
from .contracts import VerificationReport, VerificationRequest


class CommandChecker:
    def __init__(self, command: Sequence[str]):
        if isinstance(command, str) or not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("Нужна команда проверяющего ядра с отдельными аргументами")
        self.command = tuple(command)

    async def check(self, request: VerificationRequest) -> VerificationReport:
        try:
            process = await asyncio.create_subprocess_exec(
                *self.command, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise CheckerError(f"Не удалось запустить ядро: {error}") from error
        try:
            output, error_output = await process.communicate(request.model_dump_json().encode("utf-8"))
        except asyncio.CancelledError:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode != 0:
            raise CheckerError(f"Ядро завершилось с кодом {process.returncode}: {error_output.decode('utf-8', errors='replace')}")
        try:
            return VerificationReport.model_validate_json(output)
        except ValidationError as error:
            raise CheckerError(f"Ядро вернуло неверный VerificationReport: {error}") from error
