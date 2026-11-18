import asyncio
import json

from agents import MaxTurnsExceeded, Runner
from agents.exceptions import AgentsException
from openai import APIConnectionError, APIError, APIStatusError, APITimeoutError, RateLimitError


MAX_CONTEXT_CHARS = 400_000
MAX_RUN_SECONDS = 630.0


class AgentError(AgentsException):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def check_context(value, used_chars=0):
    content = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(content) + used_chars > MAX_CONTEXT_CHARS:
        raise AgentError("CONTEXT_LIMIT", "Контекст слишком велик для одного запуска агента")
    return content


async def run_agent(agent, input, **kwargs):
    check_context(input)
    try:
        return await asyncio.wait_for(Runner.run(agent, input=input, **kwargs), timeout=MAX_RUN_SECONDS)
    except APITimeoutError as error:
        raise AgentError("PROVIDER_TIMEOUT", "Провайдер не ответил за отведённое время") from error
    except RateLimitError as error:
        raise AgentError("PROVIDER_RATE_LIMIT", "Провайдер ограничил запрос; проверьте лимит или доступную квоту") from error
    except APIConnectionError as error:
        raise AgentError("PROVIDER_UNAVAILABLE", "Не удалось подключиться к провайдеру") from error
    except APIStatusError as error:
        if error.status_code in (401, 403):
            raise AgentError("PROVIDER_AUTH", "Провайдер не принял ключ или не разрешил доступ") from error
        if error.status_code == 404:
            raise AgentError("PROVIDER_NOT_FOUND", "Модель или адрес API не найдены у провайдера") from error
        if error.status_code >= 500:
            raise AgentError("PROVIDER_UNAVAILABLE", f"Провайдер временно недоступен: код {error.status_code}") from error
        raise AgentError("PROVIDER_ERROR", f"Провайдер отклонил запрос с кодом {error.status_code}") from error
    except APIError as error:
        raise AgentError("PROVIDER_ERROR", "Провайдер вернул ошибку ответа") from error
    except MaxTurnsExceeded as error:
        raise AgentError("TURN_LIMIT", "Агент превысил лимит шагов") from error
    except TimeoutError as error:
        raise AgentError("RUN_TIMEOUT", "Запуск агента превысил допустимое время") from error
