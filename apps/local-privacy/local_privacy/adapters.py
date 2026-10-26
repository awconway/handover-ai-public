from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
import importlib
import importlib.util
import json
import math
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
from typing import Mapping, Protocol

from local_privacy.config import DEFAULT_PII_CONFIDENCE_THRESHOLD
from local_privacy.environment import (
    model_subprocess_environment,
    sanitize_model_process_environment,
)
from local_privacy.schemas import (
    MAX_DENY_TERM_CHARS,
    MAX_DENY_TERM_TOTAL_CHARS,
    MAX_DENY_TERMS,
)
from local_privacy.source_label_policy import (
    ALLOWED_SOURCE_LABELS,
    REVIEWED_SOURCE_LABEL_MODELS,
    SOURCE_LABEL_POLICY,
    create_source_label_recognizer_type,
    supports_source_label_policy,
)


ACTUAL_STT_BACKENDS = frozenset({"mlx", "nemo", "cpp"})
DEFAULT_MODELS = {
    "mlx": "omi-health/omi-med-stt-v1-mlx-q8",
    "nemo": "omi-health/omi-med-stt-v1",
    "cpp": "omi-health/omi-med-stt-v1-gguf",
}
DEIDENTIFICATION_METHOD = "replace"
OPENMED_BASE_POLICY = "strict_no_leak"
DEIDENTIFICATION_POLICY = "handover_context_v2"
DOWNSTREAM_ALLOWED_ENTITY_TYPES = frozenset(
    {"AGE", "GENDER", "LOCATION", "OCCUPATION", "TIME"}
)
REQUIRED_PROTECTED_ENTITY_TYPES = frozenset(
    {
        "ACCOUNT_NUMBER",
        "API_KEY",
        "BUILDING_NUMBER",
        "CREDIT_CARD",
        "CVV",
        "DATE_OF_BIRTH",
        "EMAIL",
        "FIRST_NAME",
        "GPS_COORDINATES",
        "ID_NUM",
        "LAST_NAME",
        "MIDDLE_NAME",
        "OTHER",
        "PASSWORD",
        "PERSON",
        "PHONE",
        "PIN",
        "SSN",
        "STREET_ADDRESS",
        "USERNAME",
        "ZIPCODE",
    }
)
MAX_PII_FINDING_LABEL_CHARS = 200
MAX_PII_FINDING_ACTION_CHARS = 100
MAX_PII_FINDING_SOURCES = 16
MAX_PII_FINDING_SOURCE_CHARS = 200
MAX_MODEL_IDENTIFIER_CHARS = 2_048
MAX_OPENMED_VERSION_CHARS = 100
PII_FINDING_FIELDS = frozenset(
    {
        "original_text",
        "label",
        "entity_type",
        "canonical_label",
        "start",
        "end",
        "confidence",
        "replacement_text",
        "action",
        "sources",
        "threshold",
    }
)


class AdapterError(RuntimeError):
    """An intentionally detail-free model adapter failure."""


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    duration_ms: int
    model: str
    backend: str


@dataclass(frozen=True)
class PIIFinding:
    """Strict, allowlisted projection of one OpenMed PII entity."""

    original_text: str
    label: str
    entity_type: str
    canonical_label: str | None
    start: int
    end: int
    confidence: float | None
    replacement_text: str
    action: str | None
    sources: tuple[str, ...]
    threshold: float | None


@dataclass(frozen=True)
class DeidentificationResult:
    text: str
    mapping: Mapping[str, str]
    pii_findings: tuple[PIIFinding, ...]
    replacement_count: int
    model: str
    openmed_version: str
    method: str = DEIDENTIFICATION_METHOD
    policy: str = DEIDENTIFICATION_POLICY
    offline: bool = True
    smart_merging: bool = True
    safety_sweep: bool = True
    backend: str | None = None
    model_revision: str | None = None

    def __post_init__(self) -> None:
        if self.replacement_count != len(self.pii_findings):
            raise ValueError("replacement_count must equal the number of PII findings")


class Transcriber(Protocol):
    def is_ready(self) -> bool: ...

    def transcribe(self, audio_path: Path) -> TranscriptionResult: ...


class Deidentifier(Protocol):
    def is_ready(self) -> bool: ...

    def deidentify(
        self,
        text: str,
        *,
        deny_terms: Sequence[Mapping[str, str]] = (),
    ) -> DeidentificationResult: ...

    def reidentify_many(
        self, texts: list[str], mapping: Mapping[str, str]
    ) -> list[str]: ...


class OmiCliTranscriber:
    """Subprocess boundary around the Omi Med STT v1 JSON CLI."""

    def __init__(
        self,
        *,
        runtime: str,
        executable: str = "omi-med-stt",
        timeout_seconds: float = 900.0,
        offline: bool = True,
    ) -> None:
        self._runtime = runtime
        self._executable = executable
        self._timeout_seconds = timeout_seconds
        self._offline = offline

    def is_ready(self) -> bool:
        return shutil.which(self._executable) is not None

    def _communicate(self, command: list[str]) -> str:
        start_new_session = os.name == "posix"
        environment = model_subprocess_environment(offline=self._offline)
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="strict",
                close_fds=True,
                start_new_session=start_new_session,
                umask=0o077 if start_new_session else -1,
                env=environment,
            )
        except (OSError, ValueError):
            raise AdapterError("transcription adapter unavailable") from None

        try:
            stdout, _ = process.communicate(timeout=self._timeout_seconds)
        except subprocess.TimeoutExpired:
            if start_new_session:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            else:
                process.kill()
            process.wait()
            raise AdapterError("transcription timed out") from None

        if process.returncode != 0:
            raise AdapterError("transcription failed")
        return stdout

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        executable = shutil.which(self._executable)
        if executable is None:
            raise AdapterError("transcription adapter unavailable")

        command = [
            executable,
            str(audio_path),
            "--json",
            "--runtime",
            self._runtime,
        ]
        if self._offline:
            command.append("--no-auto-install")
        stdout = self._communicate(command)
        try:
            payload = json.loads(stdout)
            text = payload["transcript"]
            backend = payload["runtime"]
            duration_seconds = float(payload["duration"])
            model = payload["model"]
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            raise AdapterError("invalid transcription response") from None

        if not isinstance(text, str):
            raise AdapterError("invalid transcription response")
        if backend not in ACTUAL_STT_BACKENDS:
            raise AdapterError("invalid transcription response")
        if self._runtime != "auto" and backend != self._runtime:
            raise AdapterError("invalid transcription response")
        if (
            not isinstance(model, str)
            or not model
            or len(model) > MAX_MODEL_IDENTIFIER_CHARS
            or model != DEFAULT_MODELS[backend]
        ):
            raise AdapterError("invalid transcription response")
        if not math.isfinite(duration_seconds) or duration_seconds < 0:
            raise AdapterError("invalid transcription response")

        return TranscriptionResult(
            text=text,
            language="en",
            duration_ms=round(duration_seconds * 1_000),
            model=model,
            backend=backend,
        )


def _omi_nemo_worker_main(connection, offline: bool) -> None:
    """Load NeMo once, then serve transcription requests over a private pipe."""

    sanitize_model_process_environment(offline=offline)
    try:
        from omi_stt.audio import make_chunks, normalize_to_16k_mono
        from omi_stt.merge import merge_transcripts
        from omi_stt.nemo_runtime import load_nemo_model, transcribe_nemo

        model = DEFAULT_MODELS["nemo"]
        load_nemo_model(repo_id=model, device="cuda")
        connection.send(("ready", None))
    except Exception:
        try:
            connection.send(("error", None))
        except (BrokenPipeError, EOFError, OSError):
            pass
        connection.close()
        return

    try:
        while True:
            try:
                operation, payload = connection.recv()
            except EOFError:
                return
            if operation == "close":
                return
            try:
                if operation != "transcribe" or not isinstance(payload, str):
                    raise ValueError("unsupported operation")
                audio_path = Path(payload)
                with tempfile.TemporaryDirectory(prefix="omi_stt_") as temporary:
                    info = normalize_to_16k_mono(audio_path, temporary)
                    if info.duration > 240.0:
                        chunks = make_chunks(audio_path, 240.0, 5.0, temporary)
                        texts = transcribe_nemo(
                            [chunk.path for chunk in chunks],
                            model,
                        )
                        transcript = merge_transcripts(texts)
                    else:
                        transcript = transcribe_nemo([info.path], model)[0]
                connection.send(("ok", {
                    "transcript": transcript,
                    "runtime": "nemo",
                    "duration": info.duration,
                    "model": model,
                }))
            except Exception:
                connection.send(("error", None))
    finally:
        connection.close()


class OmiNemoProcessTranscriber:
    """Persistent, killable NeMo worker with a hard per-operation timeout."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 900.0,
        offline: bool = True,
        worker_target=_omi_nemo_worker_main,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._offline = offline
        self._worker_target = worker_target
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._process = None
        self._connection = None

    def is_ready(self) -> bool:
        return importlib.util.find_spec("omi_stt") is not None

    def start(self) -> None:
        with self._lock:
            self._ensure_started_locked()

    def _ensure_started_locked(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        self._stop_locked(graceful=False)
        parent_connection, child_connection = self._context.Pipe(duplex=True)
        process = self._context.Process(
            target=self._worker_target,
            args=(child_connection, self._offline),
            name="local-privacy-omi-nemo",
            daemon=True,
        )
        try:
            process.start()
        except Exception:
            parent_connection.close()
            child_connection.close()
            raise AdapterError("transcription worker unavailable") from None
        child_connection.close()
        self._process = process
        self._connection = parent_connection
        try:
            if not parent_connection.poll(self._timeout_seconds):
                raise AdapterError("transcription worker timed out")
            status, _ = parent_connection.recv()
            if status != "ready":
                raise AdapterError("transcription worker unavailable")
        except AdapterError:
            self._stop_locked(graceful=False)
            raise
        except (BrokenPipeError, EOFError, OSError, TypeError, ValueError):
            self._stop_locked(graceful=False)
            raise AdapterError("transcription worker unavailable") from None

    def _stop_locked(self, *, graceful: bool) -> None:
        process = self._process
        connection = self._connection
        self._process = None
        self._connection = None
        if process is None:
            if connection is not None:
                connection.close()
            return
        if graceful and process.is_alive() and connection is not None:
            try:
                connection.send(("close", None))
            except (BrokenPipeError, EOFError, OSError):
                pass
        if connection is not None:
            connection.close()
        process.join(timeout=2.0 if graceful else 0.0)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2.0)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=2.0)
        try:
            process.close()
        except ValueError:
            pass

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        with self._lock:
            self._ensure_started_locked()
            try:
                self._connection.send(("transcribe", str(audio_path)))
                if not self._connection.poll(self._timeout_seconds):
                    self._stop_locked(graceful=False)
                    raise AdapterError("transcription timed out")
                status, payload = self._connection.recv()
            except AdapterError:
                raise
            except (BrokenPipeError, EOFError, OSError, TypeError, ValueError):
                self._stop_locked(graceful=False)
                raise AdapterError("transcription worker failed") from None
        if status != "ok" or not isinstance(payload, Mapping):
            raise AdapterError("transcription failed")
        try:
            text = payload["transcript"]
            backend = payload["runtime"]
            duration_seconds = float(payload["duration"])
            model = payload["model"]
        except (KeyError, TypeError, ValueError):
            raise AdapterError("invalid transcription response") from None
        if (
            not isinstance(text, str)
            or backend != "nemo"
            or model != DEFAULT_MODELS["nemo"]
            or not math.isfinite(duration_seconds)
            or duration_seconds < 0
        ):
            raise AdapterError("invalid transcription response")
        return TranscriptionResult(
            text=text,
            language="en",
            duration_ms=round(duration_seconds * 1_000),
            model=model,
            backend=backend,
        )

    def close(self) -> None:
        with self._lock:
            self._stop_locked(graceful=True)


def _bounded_string(value, *, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise AdapterError("invalid de-identification response")
    return value


def _optional_bounded_string(value, *, maximum: int) -> str | None:
    if value is None:
        return None
    return _bounded_string(value, maximum=maximum)


def _optional_probability(value) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise AdapterError("invalid de-identification response")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise AdapterError("invalid de-identification response") from None
    if not math.isfinite(number) or number < 0.0 or number > 1.0:
        raise AdapterError("invalid de-identification response")
    return number


def _normalize_deny_terms(
    deny_terms: Sequence[Mapping[str, str]],
) -> tuple[dict[str, str], ...]:
    if (
        not isinstance(deny_terms, Sequence)
        or isinstance(deny_terms, (str, bytes, bytearray))
        or len(deny_terms) > MAX_DENY_TERMS
    ):
        raise AdapterError("invalid de-identification request")

    normalized: list[dict[str, str]] = []
    labels_by_term: dict[str, str] = {}
    total_characters = 0
    for deny_term in deny_terms:
        if not isinstance(deny_term, Mapping) or set(deny_term) != {"term", "label"}:
            raise AdapterError("invalid de-identification request")
        term = _bounded_string(
            deny_term.get("term"),
            maximum=MAX_DENY_TERM_CHARS,
        )
        label = _bounded_string(
            deny_term.get("label"),
            maximum=MAX_PII_FINDING_LABEL_CHARS,
        )
        if label not in REQUIRED_PROTECTED_ENTITY_TYPES:
            raise AdapterError("invalid de-identification request")
        prior_label = labels_by_term.get(term)
        if prior_label is not None:
            if prior_label != label:
                raise AdapterError("invalid de-identification request")
            continue
        labels_by_term[term] = label
        total_characters += len(term)
        if total_characters > MAX_DENY_TERM_TOTAL_CHARS:
            raise AdapterError("invalid de-identification request")
        normalized.append({"term": term, "label": label})
    return tuple(normalized)


def _resolve_effective_model(
    *,
    requested_model: str,
    requested_revision: str | None,
    offline: bool,
    cache_dir: Path | None,
    select_backend,
    resolve_model,
) -> tuple[str, str, str, str | None]:
    """Resolve and pin the actual artifact before enabling any label policy."""

    reviewed_model = REVIEWED_SOURCE_LABEL_MODELS.get(requested_model)
    backend = reviewed_model[0] if reviewed_model is not None else select_backend(
        requested_model
    )
    if backend not in {"mlx", "torch"}:
        raise AdapterError("de-identification adapter unavailable")
    effective_model = resolve_model(requested_model, backend)
    if effective_model != requested_model:
        raise AdapterError("de-identification adapter unavailable")

    model_reference = effective_model
    local_path = Path(effective_model).expanduser()
    is_explicit_local_path = (
        reviewed_model is None
        and (
            local_path.is_absolute()
            or effective_model.startswith(("./", "../", "~/"))
            or effective_model in {".", ".."}
        )
    )
    if requested_revision is not None and not is_explicit_local_path:
        try:
            huggingface_hub = importlib.import_module("huggingface_hub")
            snapshot_download = getattr(huggingface_hub, "snapshot_download")
            model_reference = snapshot_download(
                repo_id=effective_model,
                revision=requested_revision,
                cache_dir=str(cache_dir) if cache_dir is not None else None,
                local_files_only=offline,
            )
        except Exception:
            raise AdapterError("de-identification adapter unavailable") from None
        if select_backend(model_reference) != backend:
            raise AdapterError("de-identification adapter unavailable")

    return effective_model, model_reference, backend, requested_revision


def _openmed_config_backend(backend: str) -> str:
    if backend == "mlx":
        return "mlx"
    if backend == "torch":
        return "hf"
    raise AdapterError("de-identification adapter unavailable")


def _derive_deidentification_policy(load_policy):
    """Use OpenMed policy actions to keep selected handover context downstream.

    Direct identifiers, specific addresses, and OpenMed's broad OTHER bucket
    retain the base strict-no-leak actions, arbitration, and mandatory sweep.
    """

    base_policy = load_policy(OPENMED_BASE_POLICY)
    actions = dict(getattr(base_policy, "actions", {}))
    if not actions or any(
        label not in actions for label in DOWNSTREAM_ALLOWED_ENTITY_TYPES
    ):
        raise AdapterError("de-identification adapter unavailable")
    for label in DOWNSTREAM_ALLOWED_ENTITY_TYPES:
        actions[label] = "keep"
    try:
        derived_policy = base_policy.derive(
            name=DEIDENTIFICATION_POLICY,
            actions=actions,
            metadata={
                "application_allowed_entity_types": sorted(
                    DOWNSTREAM_ALLOWED_ENTITY_TYPES
                ),
                "application_allowed_source_labels": dict(
                    sorted(ALLOWED_SOURCE_LABELS.items())
                ),
                "application_source_label_policy": SOURCE_LABEL_POLICY,
            },
        )
    except Exception:
        raise AdapterError("de-identification adapter unavailable") from None

    if DOWNSTREAM_ALLOWED_ENTITY_TYPES & REQUIRED_PROTECTED_ENTITY_TYPES:
        raise AdapterError("de-identification adapter unavailable")
    if any(
        derived_policy.action_for(label) == "keep"
        for label in REQUIRED_PROTECTED_ENTITY_TYPES
    ):
        raise AdapterError("de-identification adapter unavailable")
    if any(
        derived_policy.action_for(label) != "keep"
        for label in DOWNSTREAM_ALLOWED_ENTITY_TYPES
    ):
        raise AdapterError("de-identification adapter unavailable")
    return derived_policy


def _finding_value(entity, name: str):
    if isinstance(entity, Mapping):
        return entity.get(name)
    return getattr(entity, name, None)


def _coerce_pii_findings(
    source_text: str,
    raw_entities,
    *,
    require_exact_mapping: bool = False,
) -> tuple[PIIFinding, ...]:
    if (
        not isinstance(raw_entities, Sequence)
        or isinstance(raw_entities, (str, bytes, bytearray))
    ):
        raise AdapterError("invalid de-identification response")

    findings: list[PIIFinding] = []
    for entity in raw_entities:
        if require_exact_mapping:
            if not isinstance(entity, Mapping) or set(entity) != PII_FINDING_FIELDS:
                raise AdapterError("invalid de-identification response")

        start = _finding_value(entity, "start")
        end = _finding_value(entity, "end")
        if (
            type(start) is not int
            or type(end) is not int
            or start < 0
            or end <= start
            or end > len(source_text)
        ):
            raise AdapterError("invalid de-identification response")

        raw_original_text = _finding_value(entity, "original_text")
        if raw_original_text is None and not isinstance(entity, Mapping):
            raw_original_text = _finding_value(entity, "text")
        if not isinstance(raw_original_text, str) or not raw_original_text:
            raise AdapterError("invalid de-identification response")
        if source_text[start:end] != raw_original_text:
            raise AdapterError("invalid de-identification response")

        raw_sources = _finding_value(entity, "sources")
        if raw_sources is None:
            raw_sources = ()
        if (
            not isinstance(raw_sources, Sequence)
            or isinstance(raw_sources, (str, bytes, bytearray))
            or len(raw_sources) > MAX_PII_FINDING_SOURCES
        ):
            raise AdapterError("invalid de-identification response")
        sources = tuple(
            _bounded_string(source, maximum=MAX_PII_FINDING_SOURCE_CHARS)
            for source in raw_sources
        )

        replacement_field = (
            "replacement_text" if isinstance(entity, Mapping) else "redacted_text"
        )
        replacement_text = _finding_value(entity, replacement_field)
        if not isinstance(replacement_text, str):
            raise AdapterError("invalid de-identification response")

        findings.append(
            PIIFinding(
                original_text=raw_original_text,
                label=_bounded_string(
                    _finding_value(entity, "label"),
                    maximum=MAX_PII_FINDING_LABEL_CHARS,
                ),
                entity_type=_bounded_string(
                    _finding_value(entity, "entity_type"),
                    maximum=MAX_PII_FINDING_LABEL_CHARS,
                ),
                canonical_label=_optional_bounded_string(
                    _finding_value(entity, "canonical_label"),
                    maximum=MAX_PII_FINDING_LABEL_CHARS,
                ),
                start=start,
                end=end,
                confidence=_optional_probability(
                    _finding_value(entity, "confidence")
                ),
                replacement_text=replacement_text,
                action=_optional_bounded_string(
                    _finding_value(entity, "action"),
                    maximum=MAX_PII_FINDING_ACTION_CHARS,
                ),
                sources=sources,
                threshold=_optional_probability(_finding_value(entity, "threshold")),
            )
        )

    # strict_no_leak uses OpenMed's high-recall union and can intentionally
    # retain overlapping detector/model evidence. Preserve every validated
    # final finding in a deterministic order for the local audit.
    return tuple(
        sorted(
            findings,
            key=lambda finding: (
                finding.start,
                finding.end,
                finding.label,
                finding.entity_type,
                finding.original_text,
                finding.replacement_text,
            ),
        )
    )


def _serialize_pii_finding(finding: PIIFinding) -> dict[str, object]:
    return {
        "original_text": finding.original_text,
        "label": finding.label,
        "entity_type": finding.entity_type,
        "canonical_label": finding.canonical_label,
        "start": finding.start,
        "end": finding.end,
        "confidence": finding.confidence,
        "replacement_text": finding.replacement_text,
        "action": finding.action,
        "sources": list(finding.sources),
        "threshold": finding.threshold,
    }


class OpenMedDeidentifier:
    """Lazy, serialized local OpenMed de-identification adapter."""

    def __init__(
        self,
        *,
        model_name: str,
        model_revision: str | None = None,
        confidence_threshold: float = DEFAULT_PII_CONFIDENCE_THRESHOLD,
        offline: bool = True,
        cache_dir: Path | None = None,
    ) -> None:
        self._model_name = model_name
        self._requested_model_revision = model_revision
        validated_threshold = _optional_probability(confidence_threshold)
        if validated_threshold is None:
            raise ValueError("confidence_threshold must be between zero and one")
        self._confidence_threshold = validated_threshold
        self._offline = offline
        self._cache_dir = cache_dir
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._deidentify_function = None
        self._reidentify_function = None
        self._config = None
        self._loader = None
        self._openmed_version = None
        self._backend = None
        self._policy = None
        self._pipeline_type = None
        self._extract_pii_function = None
        self._source_label_recognizer_type = None
        self._effective_model_id = None
        self._effective_model_reference = None
        self._model_revision = None
        self._model_preloaded = False

    def is_ready(self) -> bool:
        return importlib.util.find_spec("openmed") is not None

    def _ensure_runtime(self) -> None:
        if self._deidentify_function is not None and self._policy is not None:
            return
        with self._load_lock:
            if self._deidentify_function is not None and self._policy is not None:
                return
            try:
                openmed = importlib.import_module("openmed")
                openmed_core = importlib.import_module("openmed.core")
                openmed_pii = importlib.import_module("openmed.core.pii")
                openmed_backends = importlib.import_module("openmed.core.backends")
                openmed_custom = importlib.import_module(
                    "openmed.core.custom_recognizer"
                )
                openmed_labels = importlib.import_module("openmed.core.labels")
                openmed_pipeline = importlib.import_module("openmed.core.pipeline")
                openmed_policy = importlib.import_module("openmed.core.policy")
                config_type = getattr(openmed_core, "OpenMedConfig")
                loader_type = getattr(openmed_core, "ModelLoader")
                select_backend = getattr(
                    openmed_backends,
                    "select_privacy_filter_backend",
                )
                resolve_model = getattr(
                    openmed_backends,
                    "resolve_privacy_filter_model",
                )
                load_policy = getattr(openmed_policy, "load_policy")
                pipeline_type = getattr(openmed_pipeline, "Pipeline")
                extract_pii_function = getattr(openmed_pii, "extract_pii")
                source_label_recognizer_type = create_source_label_recognizer_type(
                    getattr(openmed_custom, "CustomRecognizer"),
                    getattr(openmed_custom, "CustomMatch"),
                    getattr(openmed_labels, "normalize_label"),
                )
                deidentify_function, reidentify_function = (
                    _resolve_openmed_functions(openmed, openmed_pii)
                )
                openmed_version = _bounded_string(
                    getattr(openmed, "__version__", None),
                    maximum=MAX_OPENMED_VERSION_CHARS,
                )
                (
                    effective_model_id,
                    effective_model_reference,
                    backend,
                    model_revision,
                ) = _resolve_effective_model(
                    requested_model=self._model_name,
                    requested_revision=self._requested_model_revision,
                    offline=self._offline,
                    cache_dir=self._cache_dir,
                    select_backend=select_backend,
                    resolve_model=resolve_model,
                )
                config_kwargs: dict[str, object] = {
                    "backend": _openmed_config_backend(backend),
                    "local_only": self._offline,
                    "pii_model": effective_model_reference,
                    "pii_model_revision": model_revision,
                }
                if self._cache_dir is not None:
                    config_kwargs["cache_dir"] = str(self._cache_dir)
                config = config_type(**config_kwargs)
                loader = loader_type(config=config)
                policy = _derive_deidentification_policy(load_policy)
            except Exception:
                raise AdapterError("de-identification adapter unavailable") from None

            self._config = config
            self._loader = loader
            self._deidentify_function = deidentify_function
            self._reidentify_function = reidentify_function
            self._openmed_version = openmed_version
            self._backend = backend
            self._policy = policy
            self._pipeline_type = pipeline_type
            self._extract_pii_function = extract_pii_function
            self._source_label_recognizer_type = source_label_recognizer_type
            self._effective_model_id = effective_model_id
            self._effective_model_reference = effective_model_reference
            self._model_revision = model_revision

    def preload(self) -> None:
        """Load and cache the exact OpenMed pipeline used by PII inference."""

        self._ensure_runtime()
        with self._inference_lock:
            if self._model_preloaded:
                return
            effective_model_reference = (
                self._effective_model_reference or self._model_name
            )
            try:
                self._loader.create_pipeline(
                    effective_model_reference,
                    task="token-classification",
                    aggregation_strategy="simple",
                    use_fast_tokenizer=True,
                )
            except Exception:
                raise AdapterError(
                    "de-identification adapter unavailable"
                ) from None
            self._model_preloaded = True

    def deidentify(
        self,
        text: str,
        *,
        deny_terms: Sequence[Mapping[str, str]] = (),
    ) -> DeidentificationResult:
        normalized_deny_terms = _normalize_deny_terms(deny_terms)
        self._ensure_runtime()
        effective_model_id = self._effective_model_id or self._model_name
        effective_model_reference = self._effective_model_reference or self._model_name
        allow_source_labels = supports_source_label_policy(
            effective_model_id,
            backend=self._backend,
            model_revision=self._model_revision,
        )
        request_options: dict[str, object] = {
            "method": DEIDENTIFICATION_METHOD,
            "model_name": effective_model_reference,
            "confidence_threshold": self._confidence_threshold,
            "policy": self._policy,
            "keep_mapping": True,
            "config": self._config,
            "loader": self._loader,
            "use_smart_merging": True,
            "use_safety_sweep": True,
            "cache_results": False,
        }
        try:
            with self._inference_lock:
                if (
                    self._pipeline_type is not None
                    and self._extract_pii_function is not None
                    and self._source_label_recognizer_type is not None
                ):
                    recognizer = self._source_label_recognizer_type(
                        deny_terms=normalized_deny_terms,
                        allow_source_labels=allow_source_labels,
                    )

                    def model_detector(model_text: str, **model_options):
                        raw_result = self._extract_pii_function(
                            model_text,
                            **model_options,
                        )
                        return recognizer.capture_model_result(
                            model_text,
                            raw_result,
                        )

                    pipeline = self._pipeline_type(
                        model_name=effective_model_reference,
                        confidence_threshold=self._confidence_threshold,
                        config=self._config,
                        loader=self._loader,
                        use_smart_merging=True,
                        use_safety_sweep=True,
                        policy=self._policy,
                        model_detector=model_detector,
                        custom_recognizer=recognizer,
                    )
                    result = pipeline.run(
                        text,
                        method=DEIDENTIFICATION_METHOD,
                        keep_mapping=True,
                    ).deidentification_result
                else:
                    if normalized_deny_terms:
                        request_options["custom_recognizer"] = {
                            "case_sensitive": True,
                            "deny": {
                                "terms": [
                                    dict(item) for item in normalized_deny_terms
                                ]
                            },
                        }
                    result = self._deidentify_function(
                        text,
                        **request_options,
                    )
        except Exception:
            raise AdapterError("de-identification failed") from None

        deidentified_text = getattr(result, "deidentified_text", None)
        raw_mapping = getattr(result, "mapping", None) or {}
        raw_entities = getattr(result, "pii_entities", None) or ()
        if not isinstance(deidentified_text, str) or not isinstance(
            raw_mapping, Mapping
        ):
            raise AdapterError("invalid de-identification response")

        mapping: dict[str, str] = {}
        for key, value in raw_mapping.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise AdapterError("invalid de-identification response")
            mapping[key] = value

        pii_findings = _coerce_pii_findings(text, raw_entities)
        if any(
            finding.threshold != self._confidence_threshold
            for finding in pii_findings
        ):
            raise AdapterError("invalid de-identification response")
        model = _bounded_string(
            effective_model_id,
            maximum=MAX_MODEL_IDENTIFIER_CHARS,
        )
        openmed_version = _bounded_string(
            self._openmed_version,
            maximum=MAX_OPENMED_VERSION_CHARS,
        )

        return DeidentificationResult(
            text=deidentified_text,
            mapping=mapping,
            pii_findings=pii_findings,
            replacement_count=len(pii_findings),
            model=model,
            openmed_version=openmed_version,
            method=DEIDENTIFICATION_METHOD,
            policy=DEIDENTIFICATION_POLICY,
            offline=self._offline,
            smart_merging=True,
            safety_sweep=True,
            backend=self._backend,
            model_revision=self._model_revision,
        )

    def reidentify_many(
        self, texts: list[str], mapping: Mapping[str, str]
    ) -> list[str]:
        self._ensure_runtime()
        results: list[str] = []
        try:
            with self._inference_lock:
                for text in texts:
                    result = self._reidentify_function(text, mapping)
                    if not isinstance(result, str):
                        raise TypeError("invalid re-identification response")
                    results.append(result)
        except Exception:
            raise AdapterError("re-identification failed") from None
        return results


def _resolve_openmed_functions(openmed_module, pii_module):
    """Prefer OpenMed's documented top-level API without eager fallback lookup."""

    deidentify_function = getattr(openmed_module, "deidentify", None)
    if deidentify_function is None:
        deidentify_function = getattr(pii_module, "deidentify")
    reidentify_function = getattr(openmed_module, "reidentify", None)
    if reidentify_function is None:
        reidentify_function = getattr(pii_module, "reidentify")
    if not callable(deidentify_function) or not callable(reidentify_function):
        raise TypeError("OpenMed PII API is unavailable")
    return deidentify_function, reidentify_function


def _openmed_worker_main(
    connection,
    model_name: str,
    model_revision: str | None,
    confidence_threshold: float,
    offline: bool,
    cache_dir: str | None,
) -> None:
    # `multiprocessing` has no per-process env argument. Strip everything except
    # local runtime/cache/GPU settings before importing OpenMed or loading a model.
    sanitize_model_process_environment(offline=offline)
    adapter = OpenMedDeidentifier(
        model_name=model_name,
        model_revision=model_revision,
        confidence_threshold=confidence_threshold,
        offline=offline,
        cache_dir=Path(cache_dir) if cache_dir else None,
    )
    try:
        adapter.preload()
        connection.send(("ready", None))
        while True:
            try:
                operation, payload = connection.recv()
            except EOFError:
                return
            if operation == "close":
                return
            response = None
            result = None
            texts = None
            mapping = None
            source_text = None
            deny_terms = None
            try:
                if operation == "deidentify":
                    if isinstance(payload, str):
                        source_text = payload
                        result = adapter.deidentify(source_text)
                    elif isinstance(payload, Mapping) and set(payload) == {
                        "text",
                        "deny_terms",
                    }:
                        source_text = payload.get("text")
                        if not isinstance(source_text, str):
                            raise ValueError("invalid de-identification request")
                        deny_terms = _normalize_deny_terms(payload.get("deny_terms"))
                        result = adapter.deidentify(
                            source_text,
                            deny_terms=deny_terms,
                        )
                    else:
                        raise ValueError("invalid de-identification request")
                    response = {
                        "text": result.text,
                        "mapping": dict(result.mapping),
                        "pii_findings": [
                            _serialize_pii_finding(finding)
                            for finding in result.pii_findings
                        ],
                        "replacement_count": result.replacement_count,
                        "model": result.model,
                        "openmed_version": result.openmed_version,
                        "method": result.method,
                        "policy": result.policy,
                        "offline": result.offline,
                        "smart_merging": result.smart_merging,
                        "safety_sweep": result.safety_sweep,
                        "backend": result.backend,
                        "model_revision": result.model_revision,
                    }
                elif operation == "reidentify_many":
                    texts, mapping = payload
                    response = adapter.reidentify_many(texts, mapping)
                else:
                    raise ValueError("unsupported operation")
                connection.send(("ok", response))
            except Exception:
                connection.send(("error", None))
            finally:
                # Do not retain request text or a second mapping copy while idle.
                operation = None
                payload = None
                response = None
                result = None
                texts = None
                mapping = None
                source_text = None
                deny_terms = None
    finally:
        connection.close()


class OpenMedProcessDeidentifier:
    """Persistent, killable OpenMed worker with a hard per-operation timeout."""

    def __init__(
        self,
        *,
        model_name: str,
        model_revision: str | None = None,
        confidence_threshold: float = DEFAULT_PII_CONFIDENCE_THRESHOLD,
        offline: bool = True,
        cache_dir: Path | None = None,
        timeout_seconds: float = 300.0,
        worker_target=_openmed_worker_main,
    ) -> None:
        self._model_name = model_name
        self._model_revision = model_revision
        validated_threshold = _optional_probability(confidence_threshold)
        if validated_threshold is None:
            raise ValueError("confidence_threshold must be between zero and one")
        self._confidence_threshold = validated_threshold
        self._offline = offline
        self._cache_dir = cache_dir
        self._timeout_seconds = timeout_seconds
        self._worker_target = worker_target
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._process = None
        self._connection = None

    def is_ready(self) -> bool:
        return importlib.util.find_spec("openmed") is not None

    def start(self) -> None:
        with self._lock:
            self._ensure_started_locked()

    def _ensure_started_locked(self) -> None:
        if self._process is not None and self._process.is_alive():
            return
        self._stop_locked(graceful=False)
        parent_connection, child_connection = self._context.Pipe(duplex=True)
        process = self._context.Process(
            target=self._worker_target,
            args=(
                child_connection,
                self._model_name,
                self._model_revision,
                self._confidence_threshold,
                self._offline,
                str(self._cache_dir) if self._cache_dir is not None else None,
            ),
            name="local-privacy-openmed",
            daemon=True,
        )
        try:
            process.start()
        except Exception:
            parent_connection.close()
            child_connection.close()
            raise AdapterError("de-identification worker unavailable") from None
        child_connection.close()
        self._process = process
        self._connection = parent_connection
        try:
            if not parent_connection.poll(self._timeout_seconds):
                raise AdapterError("OpenMed worker timed out")
            status, _ = parent_connection.recv()
            if status != "ready":
                raise AdapterError("de-identification worker unavailable")
        except AdapterError:
            self._stop_locked(graceful=False)
            raise
        except (BrokenPipeError, EOFError, OSError, TypeError, ValueError):
            self._stop_locked(graceful=False)
            raise AdapterError("de-identification worker unavailable") from None

    def _stop_locked(self, *, graceful: bool) -> None:
        process = self._process
        connection = self._connection
        self._process = None
        self._connection = None
        if process is None:
            if connection is not None:
                connection.close()
            return
        if graceful and process.is_alive() and connection is not None:
            try:
                connection.send(("close", None))
            except (BrokenPipeError, EOFError, OSError):
                pass
        if connection is not None:
            connection.close()
        process.join(timeout=2.0 if graceful else 0.0)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2.0)
        if process.is_alive() and hasattr(process, "kill"):
            process.kill()
            process.join(timeout=2.0)
        try:
            process.close()
        except ValueError:
            pass

    def _request(self, operation: str, payload):
        with self._lock:
            self._ensure_started_locked()
            try:
                self._connection.send((operation, payload))
                if not self._connection.poll(self._timeout_seconds):
                    self._stop_locked(graceful=False)
                    raise AdapterError("OpenMed worker timed out")
                status, response = self._connection.recv()
            except AdapterError:
                raise
            except (BrokenPipeError, EOFError, OSError, TypeError, ValueError):
                self._stop_locked(graceful=False)
                raise AdapterError("OpenMed worker failed") from None
            if status != "ok":
                raise AdapterError("OpenMed operation failed")
            return response

    def deidentify(
        self,
        text: str,
        *,
        deny_terms: Sequence[Mapping[str, str]] = (),
    ) -> DeidentificationResult:
        normalized_deny_terms = _normalize_deny_terms(deny_terms)
        payload: object = text
        if normalized_deny_terms:
            payload = {
                "text": text,
                "deny_terms": normalized_deny_terms,
            }
        response = self._request("deidentify", payload)
        if not isinstance(response, dict):
            raise AdapterError("invalid de-identification response")
        result_text = response.get("text")
        raw_mapping = response.get("mapping")
        raw_pii_findings = response.get("pii_findings")
        replacement_count = response.get("replacement_count")
        model = response.get("model")
        openmed_version = response.get("openmed_version")
        method = response.get("method")
        policy = response.get("policy")
        offline = response.get("offline")
        smart_merging = response.get("smart_merging")
        safety_sweep = response.get("safety_sweep")
        backend = response.get("backend")
        model_revision = response.get("model_revision")
        if (
            not isinstance(result_text, str)
            or not isinstance(raw_mapping, dict)
            or type(replacement_count) is not int
            or replacement_count < 0
            or method != DEIDENTIFICATION_METHOD
            or policy != DEIDENTIFICATION_POLICY
            or type(offline) is not bool
            or type(self._offline) is not bool
            or offline != self._offline
            or smart_merging is not True
            or safety_sweep is not True
        ):
            raise AdapterError("invalid de-identification response")
        mapping: dict[str, str] = {}
        for key, value in raw_mapping.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise AdapterError("invalid de-identification response")
            mapping[key] = value
        pii_findings = _coerce_pii_findings(
            text,
            raw_pii_findings,
            require_exact_mapping=True,
        )
        if any(
            finding.threshold != self._confidence_threshold
            for finding in pii_findings
        ):
            raise AdapterError("invalid de-identification response")
        if replacement_count != len(pii_findings):
            raise AdapterError("invalid de-identification response")
        validated_model = _bounded_string(
            model,
            maximum=MAX_MODEL_IDENTIFIER_CHARS,
        )
        if validated_model != self._model_name:
            raise AdapterError("invalid de-identification response")
        validated_openmed_version = _bounded_string(
            openmed_version,
            maximum=MAX_OPENMED_VERSION_CHARS,
        )
        validated_backend = _optional_bounded_string(
            backend,
            maximum=MAX_MODEL_IDENTIFIER_CHARS,
        )
        validated_model_revision = _optional_bounded_string(
            model_revision,
            maximum=MAX_MODEL_IDENTIFIER_CHARS,
        )
        if validated_model_revision != self._model_revision:
            raise AdapterError("invalid de-identification response")
        return DeidentificationResult(
            text=result_text,
            mapping=mapping,
            pii_findings=pii_findings,
            replacement_count=replacement_count,
            model=validated_model,
            openmed_version=validated_openmed_version,
            method=method,
            policy=policy,
            offline=offline,
            smart_merging=smart_merging,
            safety_sweep=safety_sweep,
            backend=validated_backend,
            model_revision=validated_model_revision,
        )

    def reidentify_many(
        self, texts: list[str], mapping: Mapping[str, str]
    ) -> list[str]:
        response = self._request("reidentify_many", (texts, dict(mapping)))
        if (
            not isinstance(response, list)
            or len(response) != len(texts)
            or any(not isinstance(item, str) for item in response)
        ):
            raise AdapterError("invalid re-identification response")
        return response

    def close(self) -> None:
        with self._lock:
            self._stop_locked(graceful=True)
