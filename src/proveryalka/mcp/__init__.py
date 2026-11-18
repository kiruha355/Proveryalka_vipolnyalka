"""Опциональная локальная MCP интеграция; импорт не создаёт БД или сервер."""
from .policy import LocalAccessPolicy
from .server import MCPIntegration

__all__ = ["LocalAccessPolicy", "MCPIntegration"]
