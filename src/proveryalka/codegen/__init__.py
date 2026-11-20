"""Генерация проекта Python/FastAPI/pytest из согласованной версии BehavioralModel 1.0."""
from .project import GeneratedProject, Provenance, code_hash, generate_project
from .scope import GENERATOR_NAME, GENERATOR_VERSION, TARGET, UnsupportedModel, check_supported


__all__ = ["GENERATOR_NAME", "GENERATOR_VERSION", "TARGET", "GeneratedProject", "Provenance", "UnsupportedModel",
           "check_supported", "code_hash", "generate_project"]
