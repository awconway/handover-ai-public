from __future__ import annotations

from dataclasses import dataclass
import math
import os
import platform
from pathlib import Path
from typing import Final


ALLOWED_STT_RUNTIMES = frozenset({"auto", "mlx", "nemo", "cpp"})
SUPERCLINICAL_LARGE_SOURCE_MODEL: Final = (
    "OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1"
)
SUPERCLINICAL_LARGE_SOURCE_REVISION: Final = (
    "df7af994d39d358e52f929ff1b3a40d894adf022"
)
SUPERCLINICAL_LARGE_MLX_MODEL: Final = (
    "OpenMed/OpenMed-PII-SuperClinical-Large-434M-v1-mlx"
)
SUPERCLINICAL_LARGE_MLX_REVISION: Final = (
    "007fbe157b29d8088c64ffe2c43d00879c18113a"
)
REVIEWED_PII_MODEL_REVISIONS: Final = {
    SUPERCLINICAL_LARGE_SOURCE_MODEL: SUPERCLINICAL_LARGE_SOURCE_REVISION,
    SUPERCLINICAL_LARGE_MLX_MODEL: SUPERCLINICAL_LARGE_MLX_REVISION,
}
DEFAULT_PII_CONFIDENCE_THRESHOLD: Final = 0.5


def _is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine().lower() in {
        "arm64",
        "aarch64",
    }


def _default_pii_model() -> str:
    return (
        SUPERCLINICAL_LARGE_MLX_MODEL
        if _is_apple_silicon()
        else SUPERCLINICAL_LARGE_SOURCE_MODEL
    )


def _optional_env(name: str) -> str | None:
    raw = os.getenv(name)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _positive_float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _probability_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(value) or value < 0.0 or value > 1.0:
        raise ValueError(f"{name} must be between zero and one")
    return value


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _optional_path_env(name: str) -> Path | None:
    value = _optional_env(name)
    return Path(value).expanduser().resolve() if value else None


@dataclass(frozen=True)
class Settings:
    app_name: str = "Handover Local Privacy API"
    app_version: str = "0.1.0"
    shared_secret: str | None = None
    port: int = 8789
    stt_runtime: str = "auto"
    omi_executable: str = "omi-med-stt"
    stt_timeout_seconds: float = 900.0
    max_audio_bytes: int = 250 * 1024 * 1024
    body_read_timeout_seconds: float = 300.0
    temp_root: Path | None = None
    pii_model: str | None = None
    pii_model_revision: str | None = None
    pii_confidence_threshold: float = DEFAULT_PII_CONFIDENCE_THRESHOLD
    offline: bool = True
    openmed_cache_dir: Path | None = None
    openmed_timeout_seconds: float = 300.0
    openmed_admission_timeout_seconds: float = 900.0
    max_text_chars: int = 1_000_000
    mapping_ttl_seconds: float = 900.0
    mapping_max_entries: int = 1_024
    max_json_depth: int = 64
    max_json_nodes: int = 100_000
    max_reidentification_chars: int = 2_000_000
    max_concurrent_transcriptions: int = 1
    max_concurrent_openmed_requests: int = 1

    def __post_init__(self) -> None:
        if self.pii_model is None:
            model = _default_pii_model()
            object.__setattr__(self, "pii_model", model)
            object.__setattr__(
                self,
                "pii_model_revision",
                self.pii_model_revision or REVIEWED_PII_MODEL_REVISIONS[model],
            )
        elif self.pii_model_revision is None:
            object.__setattr__(
                self,
                "pii_model_revision",
                REVIEWED_PII_MODEL_REVISIONS.get(self.pii_model),
            )
        if self.stt_runtime not in ALLOWED_STT_RUNTIMES:
            raise ValueError("stt_runtime must be auto, mlx, nemo, or cpp")
        if self.port > 65_535:
            raise ValueError("port must not exceed 65535")
        if not self.omi_executable or not self.pii_model:
            raise ValueError("model adapter names must not be empty")
        if self.pii_model_revision is not None and not self.pii_model_revision.strip():
            raise ValueError("pii_model_revision must not be empty")
        if (
            isinstance(self.pii_confidence_threshold, bool)
            or not isinstance(self.pii_confidence_threshold, (int, float))
            or not math.isfinite(self.pii_confidence_threshold)
            or self.pii_confidence_threshold < 0.0
            or self.pii_confidence_threshold > 1.0
        ):
            raise ValueError("pii_confidence_threshold must be between zero and one")
        if self.max_json_depth > 128:
            raise ValueError("max_json_depth must not exceed 128")
        positive_values = {
            "port": self.port,
            "stt_timeout_seconds": self.stt_timeout_seconds,
            "max_audio_bytes": self.max_audio_bytes,
            "body_read_timeout_seconds": self.body_read_timeout_seconds,
            "openmed_timeout_seconds": self.openmed_timeout_seconds,
            "openmed_admission_timeout_seconds": (
                self.openmed_admission_timeout_seconds
            ),
            "max_text_chars": self.max_text_chars,
            "mapping_ttl_seconds": self.mapping_ttl_seconds,
            "mapping_max_entries": self.mapping_max_entries,
            "max_json_depth": self.max_json_depth,
            "max_json_nodes": self.max_json_nodes,
            "max_reidentification_chars": self.max_reidentification_chars,
            "max_concurrent_transcriptions": self.max_concurrent_transcriptions,
            "max_concurrent_openmed_requests": self.max_concurrent_openmed_requests,
        }
        for name, value in positive_values.items():
            if value <= 0:
                raise ValueError(f"{name} must be greater than zero")
        finite_values = {
            "stt_timeout_seconds": self.stt_timeout_seconds,
            "body_read_timeout_seconds": self.body_read_timeout_seconds,
            "openmed_timeout_seconds": self.openmed_timeout_seconds,
            "openmed_admission_timeout_seconds": (
                self.openmed_admission_timeout_seconds
            ),
            "mapping_ttl_seconds": self.mapping_ttl_seconds,
        }
        for name, value in finite_values.items():
            if not math.isfinite(value):
                raise ValueError(f"{name} must be finite")

    @classmethod
    def from_env(cls) -> "Settings":
        runtime = os.getenv("LOCAL_PRIVACY_STT_RUNTIME", "auto").strip().lower()
        offline_name = (
            "LOCAL_PRIVACY_OFFLINE"
            if os.getenv("LOCAL_PRIVACY_OFFLINE") is not None
            else "LOCAL_PRIVACY_OPENMED_OFFLINE"
        )
        configured_pii_model = _optional_env("LOCAL_PRIVACY_PII_MODEL")
        pii_model = configured_pii_model or _default_pii_model()
        configured_revision = _optional_env("LOCAL_PRIVACY_PII_MODEL_REVISION")
        return cls(
            shared_secret=_optional_env("LOCAL_PRIVACY_SHARED_SECRET"),
            port=_positive_int_env("LOCAL_PRIVACY_PORT", 8789),
            stt_runtime=runtime,
            omi_executable=os.getenv(
                "LOCAL_PRIVACY_OMI_EXECUTABLE", "omi-med-stt"
            ).strip(),
            stt_timeout_seconds=_positive_float_env(
                "LOCAL_PRIVACY_STT_TIMEOUT_SECONDS", 900.0
            ),
            max_audio_bytes=_positive_int_env(
                "LOCAL_PRIVACY_MAX_AUDIO_BYTES", 250 * 1024 * 1024
            ),
            body_read_timeout_seconds=_positive_float_env(
                "LOCAL_PRIVACY_BODY_READ_TIMEOUT_SECONDS", 300.0
            ),
            temp_root=_optional_path_env("LOCAL_PRIVACY_TEMP_ROOT"),
            pii_model=pii_model,
            pii_model_revision=(
                configured_revision or REVIEWED_PII_MODEL_REVISIONS.get(pii_model)
            ),
            pii_confidence_threshold=_probability_env(
                "LOCAL_PRIVACY_PII_CONFIDENCE_THRESHOLD",
                DEFAULT_PII_CONFIDENCE_THRESHOLD,
            ),
            offline=_bool_env(offline_name, True),
            openmed_cache_dir=_optional_path_env("LOCAL_PRIVACY_OPENMED_CACHE_DIR"),
            openmed_timeout_seconds=_positive_float_env(
                "LOCAL_PRIVACY_OPENMED_TIMEOUT_SECONDS", 300.0
            ),
            openmed_admission_timeout_seconds=_positive_float_env(
                "LOCAL_PRIVACY_OPENMED_ADMISSION_TIMEOUT_SECONDS", 900.0
            ),
            max_text_chars=_positive_int_env(
                "LOCAL_PRIVACY_MAX_TEXT_CHARS", 1_000_000
            ),
            mapping_ttl_seconds=_positive_float_env(
                "LOCAL_PRIVACY_MAPPING_TTL_SECONDS", 900.0
            ),
            mapping_max_entries=_positive_int_env(
                "LOCAL_PRIVACY_MAPPING_MAX_ENTRIES", 1_024
            ),
            max_json_depth=_positive_int_env("LOCAL_PRIVACY_MAX_JSON_DEPTH", 64),
            max_json_nodes=_positive_int_env(
                "LOCAL_PRIVACY_MAX_JSON_NODES", 100_000
            ),
            max_reidentification_chars=_positive_int_env(
                "LOCAL_PRIVACY_MAX_REIDENTIFICATION_CHARS", 2_000_000
            ),
            max_concurrent_transcriptions=_positive_int_env(
                "LOCAL_PRIVACY_MAX_CONCURRENT_TRANSCRIPTIONS", 1
            ),
            max_concurrent_openmed_requests=_positive_int_env(
                "LOCAL_PRIVACY_MAX_CONCURRENT_OPENMED_REQUESTS", 1
            ),
        )
