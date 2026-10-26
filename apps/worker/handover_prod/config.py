from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

DEFAULT_MODEL = "openai/gpt-5.2"
DEFAULT_REQUEST_TIMEOUT_SECONDS = 120
DEFAULT_SBAR_PROGRAM = "sbar_span_gpt5-2_consensus.json"
DEFAULT_CHECKLIST_PROGRAM = "checklist_gpt_5-2_consensus.json"
DEFAULT_UNKNOWN_FACT_PROGRAM = "unknown_fact_binary_gpt5-2_user2_v2.json"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _compiled_programs_dir() -> Path:
    raw = os.getenv("HANDOVER_COMPILED_PROGRAMS_DIR")
    if raw:
        return Path(raw).expanduser().resolve()
    return (_repo_root() / "compiled_programs").resolve()


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def _env_optional(name: str) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _resolve_program_path(
    env_name: str, default_filename: str, compiled_programs_dir: Path
) -> Path:
    raw = os.getenv(env_name)
    if not raw:
        return (compiled_programs_dir / default_filename).resolve()

    path = Path(raw).expanduser()
    if path.is_absolute():
        return path.resolve()
    if len(path.parts) == 1:
        return (compiled_programs_dir / path).resolve()
    return path.resolve()


@dataclass(frozen=True)
class Settings:
    app_name: str
    app_version: str
    model: str
    reasoning_effort: str | None
    request_timeout_seconds: int
    shared_secret: str | None
    sbar_program_path: Path
    checklist_program_path: Path
    unknown_fact_program_path: Path

    @classmethod
    def from_env(cls) -> "Settings":
        compiled_programs_dir = _compiled_programs_dir()
        return cls(
            app_name="Handover Annotation Inference API",
            app_version="0.1.0",
            model=os.getenv("HANDOVER_MODEL", DEFAULT_MODEL),
            reasoning_effort=_env_optional("HANDOVER_REASONING_EFFORT"),
            request_timeout_seconds=_env_int(
                "HANDOVER_REQUEST_TIMEOUT_SECONDS",
                DEFAULT_REQUEST_TIMEOUT_SECONDS,
            ),
            shared_secret=_env_optional("HANDOVER_DSPY_SHARED_SECRET"),
            sbar_program_path=_resolve_program_path(
                "HANDOVER_SBAR_PROGRAM",
                DEFAULT_SBAR_PROGRAM,
                compiled_programs_dir,
            ),
            checklist_program_path=_resolve_program_path(
                "HANDOVER_CHECKLIST_PROGRAM",
                DEFAULT_CHECKLIST_PROGRAM,
                compiled_programs_dir,
            ),
            unknown_fact_program_path=_resolve_program_path(
                "HANDOVER_UNKNOWN_FACT_PROGRAM",
                DEFAULT_UNKNOWN_FACT_PROGRAM,
                compiled_programs_dir,
            ),
        )

    def task_program_paths(self) -> dict[str, Path]:
        return {
            "sbar": self.sbar_program_path,
            "checklist": self.checklist_program_path,
            "unknown_fact": self.unknown_fact_program_path,
        }
