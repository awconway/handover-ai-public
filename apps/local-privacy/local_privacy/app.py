from __future__ import annotations

from contextlib import asynccontextmanager
import errno
import fcntl
import hashlib
import math
import os
from pathlib import Path
import secrets
import stat
import tempfile
import threading
import time
from typing import Any, AsyncIterator, Callable, TypeVar

import anyio
from fastapi import Depends, FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from local_privacy.adapters import (
    Deidentifier,
    OmiCliTranscriber,
    OmiNemoProcessTranscriber,
    OpenMedProcessDeidentifier,
    Transcriber,
)
from local_privacy.config import Settings
from local_privacy.schemas import (
    DeidentificationRequest,
    DeidentificationResponse,
    LiveResponse,
    MAX_DENY_TERM_TOTAL_CHARS,
    MAX_DENY_TERMS,
    MAX_PII_LABEL_CHARS,
    PIIFindingResponse,
    ReadyResponse,
    ReidentificationRequest,
    ReidentificationResponse,
    TranscriptionResponse,
)
from local_privacy.vault import MappingVault, VaultCapacityError


AUTH_HEADER = "x-local-privacy-token"
SUFFIX_HEADER = "x-audio-suffix"
ALLOWED_AUDIO_SUFFIXES = frozenset(
    {".bin", ".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".flac"}
)
CONTENT_TYPE_SUFFIXES = {
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
}
SCRATCH_ROOT_PREFIX = ".handover-local-privacy-"
SCRATCH_SESSION_PREFIX = "session-"
SCRATCH_REQUEST_PREFIX = "request-"
SCRATCH_LOCK_NAME = ".active.lock"


class ServiceError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


def _secret_matches(supplied: str, expected: str) -> bool:
    try:
        supplied_digest = hashlib.sha256(supplied.encode("utf-8")).digest()
        expected_digest = hashlib.sha256(expected.encode("utf-8")).digest()
    except UnicodeError:
        return False
    return secrets.compare_digest(supplied_digest, expected_digest)


def _audio_suffix(request: Request) -> str:
    supplied = request.headers.get(SUFFIX_HEADER)
    if supplied:
        normalized = supplied.strip().lower()
        if not normalized.startswith("."):
            normalized = f".{normalized}"
        if normalized not in ALLOWED_AUDIO_SUFFIXES:
            raise ServiceError(400, "invalid_request", "Invalid request")
        return normalized
    content_type = request.headers.get("content-type", "")
    media_type = content_type.split(";", 1)[0].strip().lower()
    return CONTENT_TYPE_SUFFIXES.get(media_type, ".bin")


def _owned_directory(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except OSError:
        return False
    return (
        stat.S_ISDIR(metadata.st_mode)
        and not stat.S_ISLNK(metadata.st_mode)
        and metadata.st_uid == os.getuid()
    )


def _safe_session_entries(session: Path) -> tuple[Path, ...] | None:
    try:
        entries = tuple(session.iterdir())
    except OSError:
        return None
    request_directories: list[Path] = []
    for entry in entries:
        if entry.name == SCRATCH_LOCK_NAME:
            try:
                metadata = entry.lstat()
            except OSError:
                return None
            if (
                not stat.S_ISREG(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or metadata.st_uid != os.getuid()
            ):
                return None
            continue
        if not entry.name.startswith(SCRATCH_REQUEST_PREFIX) or not _owned_directory(
            entry
        ):
            return None
        try:
            children = tuple(entry.iterdir())
        except OSError:
            return None
        if len(children) > 1:
            return None
        for child in children:
            try:
                metadata = child.lstat()
            except OSError:
                return None
            if (
                not child.name.startswith("audio")
                or child.suffix not in ALLOWED_AUDIO_SUFFIXES
                or not stat.S_ISREG(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or metadata.st_uid != os.getuid()
            ):
                return None
        request_directories.append(entry)
    return tuple(request_directories)


def _remove_safe_session(session: Path, lock_path: Path) -> bool:
    request_directories = _safe_session_entries(session)
    if request_directories is None:
        return False
    try:
        for directory in request_directories:
            for child in tuple(directory.iterdir()):
                metadata = child.lstat()
                if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(
                    metadata.st_mode
                ):
                    return False
                child.unlink()
            directory.rmdir()
        metadata = lock_path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            return False
        lock_path.unlink()
        session.rmdir()
    except OSError:
        return False
    return True


class _PrivateAudioScratch:
    """Private process session with lock-based stale-residue scavenging."""

    def __init__(self, base_root: Path | None) -> None:
        base = base_root or Path(tempfile.gettempdir())
        self.root = base / f"{SCRATCH_ROOT_PREFIX}{os.getuid()}"
        self.session: Path | None = None
        self._lock_path: Path | None = None
        self._lock_descriptor: int | None = None

    def start(self) -> None:
        if self.session is not None:
            return
        session: Path | None = None
        lock_path: Path | None = None
        descriptor: int | None = None
        try:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not _owned_directory(self.root):
                raise OSError("unsafe scratch root")
            os.chmod(self.root, 0o700)
            self._scavenge()
            session = Path(
                tempfile.mkdtemp(prefix=SCRATCH_SESSION_PREFIX, dir=str(self.root))
            )
            os.chmod(session, 0o700)
            lock_path = session / SCRATCH_LOCK_NAME
            flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(lock_path, flags, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if session is not None and lock_path is not None:
                _remove_safe_session(session, lock_path)
            raise ServiceError(
                500,
                "temporary_storage_failed",
                "Processing failed",
            ) from None
        self.session = session
        self._lock_path = lock_path
        self._lock_descriptor = descriptor

    def _scavenge(self) -> None:
        for session in tuple(self.root.iterdir()):
            if not session.name.startswith(SCRATCH_SESSION_PREFIX):
                continue
            if not _owned_directory(session):
                continue
            lock_path = session / SCRATCH_LOCK_NAME
            try:
                metadata = lock_path.lstat()
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or stat.S_ISLNK(metadata.st_mode)
                    or metadata.st_uid != os.getuid()
                ):
                    continue
                flags = os.O_RDWR
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(lock_path, flags)
            except OSError:
                continue
            try:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN}:
                        continue
                    continue
                _remove_safe_session(session, lock_path)
            finally:
                os.close(descriptor)

    def close(self) -> None:
        session = self.session
        lock_path = self._lock_path
        descriptor = self._lock_descriptor
        self.session = None
        self._lock_path = None
        self._lock_descriptor = None
        if session is not None and lock_path is not None:
            _remove_safe_session(session, lock_path)
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            self.root.rmdir()
        except OSError:
            pass


def _open_private_audio_file(
    *, suffix: str, scratch_root: Path
) -> tuple[Path, Path, Any]:
    directory: Path | None = None
    path: Path | None = None
    descriptor: int | None = None
    try:
        directory = Path(
            tempfile.mkdtemp(
                prefix=SCRATCH_REQUEST_PREFIX,
                dir=str(scratch_root),
            )
        )
        os.chmod(directory, 0o700)
        path = directory / f"audio{suffix}"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        stream = os.fdopen(descriptor, "wb")
        descriptor = None
        return directory, path, stream
    except Exception:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if path is not None:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        if directory is not None:
            try:
                directory.rmdir()
            except OSError:
                pass
        raise ServiceError(500, "temporary_storage_failed", "Processing failed") from None


def _cleanup_private_audio(path: Path | None, directory: Path | None) -> bool:
    cleaned = True
    if path is not None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            cleaned = False
    if directory is not None:
        try:
            directory.rmdir()
        except OSError:
            cleaned = False
    return cleaned


def _validate_json_value(
    value: Any,
    *,
    max_depth: int,
    max_nodes: int,
    max_string_chars: int,
) -> None:
    nodes = 0
    string_chars = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > max_nodes or depth > max_depth:
            raise ServiceError(413, "payload_too_large", "Payload too large")
        if isinstance(current, str):
            string_chars += len(current)
            if string_chars > max_string_chars:
                raise ServiceError(413, "payload_too_large", "Payload too large")
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, dict):
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, float) and not math.isfinite(current):
            raise ServiceError(400, "invalid_request", "Invalid request")
        elif current is not None and not isinstance(current, (bool, int, float)):
            raise ServiceError(400, "invalid_request", "Invalid request")


def _map_json_strings(
    value: Any, transform: Callable[[list[str]], list[str]]
) -> Any:
    strings: list[str] = []

    def collect(current: Any) -> None:
        if isinstance(current, str):
            strings.append(current)
        elif isinstance(current, list):
            for item in current:
                collect(item)
        elif isinstance(current, dict):
            for item in current.values():
                collect(item)

    collect(value)
    transformed = transform(strings)
    if len(transformed) != len(strings):
        raise ValueError("re-identification result count mismatch")
    replacements = iter(transformed)

    def rebuild(current: Any) -> Any:
        if isinstance(current, str):
            return next(replacements)
        if isinstance(current, list):
            return [rebuild(item) for item in current]
        if isinstance(current, dict):
            return {key: rebuild(item) for key, item in current.items()}
        return current

    return rebuild(value)


RequestModel = TypeVar("RequestModel", bound=BaseModel)


async def _read_json_model(
    request: Request,
    model_type: type[RequestModel],
    *,
    max_bytes: int,
    timeout_seconds: float,
) -> RequestModel:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise ServiceError(413, "payload_too_large", "Payload too large")
        except ValueError:
            pass

    body = bytearray()
    try:
        with anyio.fail_after(timeout_seconds):
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise ServiceError(413, "payload_too_large", "Payload too large")
    except TimeoutError:
        raise ServiceError(408, "request_timeout", "Request timed out") from None
    try:
        return model_type.model_validate_json(bytes(body))
    except (ValidationError, ValueError):
        raise ServiceError(400, "invalid_request", "Invalid request") from None


def create_app(
    settings: Settings | None = None,
    *,
    transcriber: Transcriber | None = None,
    deidentifier: Deidentifier | None = None,
    vault: MappingVault | None = None,
) -> FastAPI:
    app_settings = settings or Settings.from_env()
    app_transcriber = (
        transcriber
        if transcriber is not None
        else (
            OmiNemoProcessTranscriber(
                timeout_seconds=app_settings.stt_timeout_seconds,
                offline=app_settings.offline,
            )
            if app_settings.stt_runtime == "nemo"
            else OmiCliTranscriber(
                runtime=app_settings.stt_runtime,
                executable=app_settings.omi_executable,
                timeout_seconds=app_settings.stt_timeout_seconds,
                offline=app_settings.offline,
            )
        )
    )
    app_deidentifier = (
        deidentifier
        if deidentifier is not None
        else OpenMedProcessDeidentifier(
            model_name=app_settings.pii_model,
            model_revision=app_settings.pii_model_revision,
            confidence_threshold=app_settings.pii_confidence_threshold,
            offline=app_settings.offline,
            cache_dir=app_settings.openmed_cache_dir,
            timeout_seconds=app_settings.openmed_timeout_seconds,
        )
    )
    app_vault = (
        vault
        if vault is not None
        else MappingVault(
            ttl_seconds=app_settings.mapping_ttl_seconds,
            max_entries=app_settings.mapping_max_entries,
        )
    )
    audio_scratch = _PrivateAudioScratch(app_settings.temp_root)
    transcription_slots = threading.BoundedSemaphore(
        app_settings.max_concurrent_transcriptions
    )
    openmed_slots = anyio.Semaphore(
        app_settings.max_concurrent_openmed_requests,
        max_value=app_settings.max_concurrent_openmed_requests,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        audio_scratch.start()
        transcription_starter = getattr(app_transcriber, "start", None)
        if callable(transcription_starter) and app_transcriber.is_ready():
            transcription_starter()
        starter = getattr(app_deidentifier, "start", None)
        if callable(starter) and app_deidentifier.is_ready():
            starter()
        try:
            yield
        finally:
            transcription_closer = getattr(app_transcriber, "close", None)
            if callable(transcription_closer):
                transcription_closer()
            closer = getattr(app_deidentifier, "close", None)
            if callable(closer):
                closer()
            app_vault.close()
            audio_scratch.close()

    app = FastAPI(
        title=app_settings.app_name,
        version=app_settings.app_version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.transcriber = app_transcriber
    app.state.deidentifier = app_deidentifier
    app.state.mapping_vault = app_vault
    app.state.transcription_slots = transcription_slots
    app.state.openmed_slots = openmed_slots
    app.state.audio_scratch = audio_scratch

    @app.exception_handler(ServiceError)
    async def handle_service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return _error_response(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _: Request, __: RequestValidationError
    ) -> JSONResponse:
        return _error_response(400, "invalid_request", "Invalid request")

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(
        _: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        if exc.status_code == 404:
            return _error_response(404, "not_found", "Not found")
        return _error_response(exc.status_code, "request_failed", "Request failed")

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_: Request, __: Exception) -> JSONResponse:
        return _error_response(500, "internal_error", "Processing failed")

    async def require_token(request: Request) -> None:
        expected = app_settings.shared_secret
        if expected is None:
            return
        supplied = request.headers.get(AUTH_HEADER)
        if supplied is None or not _secret_matches(supplied, expected):
            raise ServiceError(401, "unauthorized", "Authentication required")

    async def reserve_transcription_slot() -> AsyncIterator[None]:
        if not transcription_slots.acquire(blocking=False):
            raise ServiceError(503, "service_busy", "Service busy")
        try:
            yield
        finally:
            transcription_slots.release()

    async def reserve_openmed_slot() -> AsyncIterator[None]:
        acquired = False
        try:
            with anyio.fail_after(
                app_settings.openmed_admission_timeout_seconds
            ):
                await openmed_slots.acquire()
            acquired = True
        except TimeoutError:
            raise ServiceError(503, "service_busy", "Service busy")
        try:
            yield
        finally:
            if acquired:
                openmed_slots.release()

    @app.get("/livez", response_model=LiveResponse)
    async def livez() -> LiveResponse:
        return LiveResponse()

    @app.get("/readyz", response_model=ReadyResponse)
    async def readyz() -> Response:
        try:
            ready = app_transcriber.is_ready() and app_deidentifier.is_ready()
        except Exception:
            ready = False
        if not ready:
            return JSONResponse(status_code=503, content={"status": "not_ready"})
        return JSONResponse(status_code=200, content={"status": "ready"})

    @app.post(
        "/v1/transcriptions",
        response_model=TranscriptionResponse,
        dependencies=[Depends(require_token), Depends(reserve_transcription_slot)],
    )
    async def transcribe(request: Request) -> TranscriptionResponse:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > app_settings.max_audio_bytes:
                    raise ServiceError(413, "audio_too_large", "Audio payload too large")
            except ValueError:
                pass

        suffix = _audio_suffix(request)
        transcription_elapsed_ms = 0
        directory: Path | None = None
        audio_path: Path | None = None
        audio_file = None
        result = None
        failure: ServiceError | None = None
        try:
            directory, audio_path, audio_file = _open_private_audio_file(
                suffix=suffix,
                scratch_root=audio_scratch.session,
            )
            received = 0
            try:
                with anyio.fail_after(app_settings.body_read_timeout_seconds):
                    async for chunk in request.stream():
                        if not chunk:
                            continue
                        received += len(chunk)
                        if received > app_settings.max_audio_bytes:
                            raise ServiceError(
                                413, "audio_too_large", "Audio payload too large"
                            )
                        audio_file.write(chunk)
            except TimeoutError:
                raise ServiceError(
                    408, "request_timeout", "Request timed out"
                ) from None
            if received == 0:
                raise ServiceError(400, "empty_audio", "Audio payload is empty")
            audio_file.close()
            audio_file = None
            transcription_started = time.perf_counter_ns()
            result = await run_in_threadpool(app_transcriber.transcribe, audio_path)
            transcription_elapsed_ms = round(
                (time.perf_counter_ns() - transcription_started) / 1_000_000
            )
        except ServiceError as exc:
            failure = exc
        except Exception:
            failure = ServiceError(500, "transcription_failed", "Transcription failed")
        finally:
            if audio_file is not None:
                try:
                    audio_file.close()
                except OSError:
                    pass
            cleaned = _cleanup_private_audio(audio_path, directory)

        if not cleaned:
            raise ServiceError(500, "audio_cleanup_failed", "Processing failed")
        if failure is not None:
            raise failure
        if result is None:
            raise ServiceError(500, "transcription_failed", "Transcription failed")
        return TranscriptionResponse(
            text=result.text,
            language=result.language,
            transcription_elapsed_ms=transcription_elapsed_ms,
            duration_ms=result.duration_ms,
            model=result.model,
            backend=result.backend,
        )

    @app.post(
        "/v1/deidentifications",
        response_model=DeidentificationResponse,
        dependencies=[Depends(require_token), Depends(reserve_openmed_slot)],
    )
    async def deidentify(request: Request) -> DeidentificationResponse:
        body = await _read_json_model(
            request,
            DeidentificationRequest,
            max_bytes=(app_settings.max_text_chars * 12)
            + (
                MAX_DENY_TERM_TOTAL_CHARS
                + (MAX_DENY_TERMS * MAX_PII_LABEL_CHARS)
            )
            * 12
            + 16_384,
            timeout_seconds=app_settings.body_read_timeout_seconds,
        )
        if not body.text:
            raise ServiceError(400, "invalid_request", "Invalid request")
        if len(body.text) > app_settings.max_text_chars:
            raise ServiceError(413, "text_too_large", "Text payload too large")
        try:
            deny_terms = tuple(item.model_dump() for item in body.deny_terms)
            if deny_terms:
                result = await run_in_threadpool(
                    app_deidentifier.deidentify,
                    body.text,
                    deny_terms=deny_terms,
                )
            else:
                # Keep one-argument compatibility for injected adapters and make
                # the no-custom-rules path identical to the prior service API.
                result = await run_in_threadpool(
                    app_deidentifier.deidentify,
                    body.text,
                )
            if result.replacement_count != len(result.pii_findings):
                raise ValueError("PII finding count mismatch")
            response = DeidentificationResponse(
                text=result.text,
                token="pending",
                pii_findings=[
                    PIIFindingResponse(
                        original_text=finding.original_text,
                        label=finding.label,
                        entity_type=finding.entity_type,
                        canonical_label=finding.canonical_label,
                        start=finding.start,
                        end=finding.end,
                        confidence=finding.confidence,
                        replacement_text=finding.replacement_text,
                        action=finding.action,
                        sources=list(finding.sources),
                        threshold=finding.threshold,
                    )
                    for finding in result.pii_findings
                ],
                replacement_count=result.replacement_count,
                model=result.model,
                openmed_version=result.openmed_version,
                method=result.method,
                policy=result.policy,
                offline=result.offline,
                smart_merging=result.smart_merging,
                safety_sweep=result.safety_sweep,
                backend=result.backend,
                model_revision=result.model_revision,
            )
        except Exception:
            raise ServiceError(
                500, "deidentification_failed", "De-identification failed"
            ) from None
        try:
            token = app_vault.put(result.mapping)
        except VaultCapacityError:
            raise ServiceError(503, "vault_unavailable", "Service unavailable") from None
        return response.model_copy(update={"token": token})

    @app.post(
        "/v1/reidentifications",
        response_model=ReidentificationResponse,
        dependencies=[Depends(require_token), Depends(reserve_openmed_slot)],
    )
    async def reidentify(request: Request) -> ReidentificationResponse:
        body = await _read_json_model(
            request,
            ReidentificationRequest,
            max_bytes=(app_settings.max_reidentification_chars * 12)
            + (app_settings.max_json_nodes * 128)
            + 4_096,
            timeout_seconds=app_settings.body_read_timeout_seconds,
        )
        _validate_json_value(
            body.value,
            max_depth=app_settings.max_json_depth,
            max_nodes=app_settings.max_json_nodes,
            max_string_chars=app_settings.max_reidentification_chars,
        )
        mapping = app_vault.consume(body.token)
        if mapping is None:
            raise ServiceError(404, "token_invalid", "Mapping token is invalid")

        def transform(texts: list[str]) -> list[str]:
            return app_deidentifier.reidentify_many(texts, mapping)

        try:
            value = await run_in_threadpool(_map_json_strings, body.value, transform)
        except Exception:
            raise ServiceError(
                500, "reidentification_failed", "Re-identification failed"
            ) from None
        return ReidentificationResponse(value=value)

    @app.delete(
        "/v1/deidentifications/{token}",
        status_code=204,
        dependencies=[Depends(require_token)],
    )
    async def delete_mapping(token: str) -> Response:
        app_vault.delete(token)
        return Response(status_code=204)

    return app
