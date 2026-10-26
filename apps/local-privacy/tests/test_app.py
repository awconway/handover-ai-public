from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from local_privacy.adapters import (
    AdapterError,
    DEIDENTIFICATION_POLICY,
    DOWNSTREAM_ALLOWED_ENTITY_TYPES,
    DeidentificationResult,
    OmiCliTranscriber,
    OmiNemoProcessTranscriber,
    OpenMedDeidentifier,
    OpenMedProcessDeidentifier,
    PIIFinding,
    TranscriptionResult,
    _derive_deidentification_policy,
    _openmed_config_backend,
    _normalize_deny_terms,
    _resolve_effective_model,
    _resolve_openmed_functions,
)
from local_privacy.app import (
    SCRATCH_LOCK_NAME,
    SCRATCH_REQUEST_PREFIX,
    SCRATCH_ROOT_PREFIX,
    SCRATCH_SESSION_PREFIX,
    _PrivateAudioScratch,
    _secret_matches,
    create_app,
)
from local_privacy.config import (
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
    SUPERCLINICAL_LARGE_MLX_MODEL,
    SUPERCLINICAL_LARGE_MLX_REVISION,
    SUPERCLINICAL_LARGE_SOURCE_MODEL,
    SUPERCLINICAL_LARGE_SOURCE_REVISION,
    Settings,
)
from local_privacy.environment import allowlisted_environment
from local_privacy.source_label_policy import (
    ALLOWED_SOURCE_LABELS,
    SOURCE_LABEL_POLICY,
    create_source_label_recognizer_type,
    supports_source_label_policy,
)
from local_privacy.vault import MappingVault


def application_openmed_policy():
    from openmed.core.policy import load_policy

    return _derive_deidentification_policy(load_policy)


def source_label_recognizer(*, deny_terms=(), allow_source_labels=True):
    from openmed.core.custom_recognizer import CustomMatch, CustomRecognizer
    from openmed.core.labels import normalize_label

    recognizer_type = create_source_label_recognizer_type(
        CustomRecognizer,
        CustomMatch,
        normalize_label,
    )
    return recognizer_type(
        deny_terms=deny_terms,
        allow_source_labels=allow_source_labels,
    )


def run_source_label_fixture(text: str, entities, *, deny_terms=()):
    from openmed.core.pipeline import Pipeline
    from openmed.processing.outputs import PredictionResult

    recognizer = source_label_recognizer(deny_terms=deny_terms)

    def model_detector(_text: str, **_kwargs):
        result = PredictionResult(
            text=text,
            entities=list(entities),
            model_name="fixture-superclinical",
            timestamp="2026-08-27T00:00:00",
        )
        return recognizer.capture_model_result(text, result)

    result = Pipeline(
        model_name="fixture-superclinical",
        policy=application_openmed_policy(),
        model_detector=model_detector,
        use_safety_sweep=True,
        custom_recognizer=recognizer,
    ).run(
        text,
        method="replace",
        keep_mapping=True,
    ).deidentification_result
    return result, recognizer


def pii_finding_for(source_text: str) -> PIIFinding:
    original_text = "Jane Example"
    start = source_text.index(original_text)
    return PIIFinding(
        original_text=original_text,
        label="person",
        entity_type="person",
        canonical_label="PERSON",
        start=start,
        end=start + len(original_text),
        confidence=0.99,
        replacement_text="Person Alpha",
        action="replace",
        sources=("model", "deterministic"),
        threshold=DEFAULT_PII_CONFIDENCE_THRESHOLD,
    )


def pii_finding_payload(source_text: str) -> dict[str, object]:
    finding = pii_finding_for(source_text)
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


def openmed_entity_for(source_text: str, **overrides) -> SimpleNamespace:
    finding = pii_finding_for(source_text)
    values = {
        "text": finding.original_text,
        "original_text": finding.original_text,
        "label": finding.label,
        "entity_type": finding.entity_type,
        "canonical_label": finding.canonical_label,
        "start": finding.start,
        "end": finding.end,
        "confidence": finding.confidence,
        "redacted_text": finding.replacement_text,
        "action": finding.action,
        "sources": list(finding.sources),
        "threshold": finding.threshold,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def fake_openmed_response(
    source_text: str,
    model_name: str,
    model_revision: str | None,
    confidence_threshold: float,
    offline: bool,
):
    finding = pii_finding_payload(source_text)
    finding["threshold"] = confidence_threshold
    return {
        "text": source_text.replace("Jane Example", "Person Alpha"),
        "mapping": {"Person Alpha": "Jane Example"},
        "pii_findings": [finding],
        "replacement_count": 1,
        "model": model_name,
        "openmed_version": "2.2.0-test",
        "method": "replace",
        "policy": DEIDENTIFICATION_POLICY,
        "offline": offline,
        "smart_merging": True,
        "safety_sweep": True,
        "backend": None,
        "model_revision": model_revision,
    }


def fake_openmed_worker(
    connection,
    model_name,
    model_revision,
    confidence_threshold,
    offline,
    cache_dir,
) -> None:
    try:
        connection.send(("ready", None))
        while True:
            operation, payload = connection.recv()
            if operation == "close":
                return
            if operation == "deidentify":
                source_text = (
                    payload["text"] if isinstance(payload, dict) else payload
                )
                connection.send(
                    (
                        "ok",
                        fake_openmed_response(
                            source_text,
                            model_name,
                            model_revision,
                            confidence_threshold,
                            offline,
                        ),
                    )
                )
            elif operation == "reidentify_many":
                texts, mapping = payload
                connection.send(
                    (
                        "ok",
                        [
                            text.replace("Person Alpha", mapping["Person Alpha"])
                            for text in texts
                        ],
                    )
                )
    finally:
        connection.close()


def malformed_openmed_worker(
    connection,
    model_name,
    model_revision,
    confidence_threshold,
    offline,
    cache_dir,
) -> None:
    try:
        connection.send(("ready", None))
        while True:
            operation, payload = connection.recv()
            if operation == "close":
                return
            source_text = payload["text"] if isinstance(payload, dict) else payload
            response = fake_openmed_response(
                source_text,
                model_name,
                model_revision,
                confidence_threshold,
                offline,
            )
            response["pii_findings"][0]["confidence"] = float("nan")
            connection.send(("ok", response))
    finally:
        connection.close()


def hanging_openmed_worker(
    connection,
    model_name,
    model_revision,
    confidence_threshold,
    offline,
    cache_dir,
) -> None:
    try:
        connection.send(("ready", None))
        connection.recv()
        time.sleep(60)
    finally:
        connection.close()


def fake_omi_nemo_worker(connection, offline: bool) -> None:
    request_count = 0
    try:
        connection.send(("ready", None))
        while True:
            operation, _ = connection.recv()
            if operation == "close":
                return
            request_count += 1
            connection.send(("ok", {
                "transcript": f"request {request_count}",
                "runtime": "nemo",
                "duration": 1.25,
                "model": "omi-health/omi-med-stt-v1",
            }))
    finally:
        connection.close()


def hanging_omi_nemo_worker(connection, offline: bool) -> None:
    try:
        connection.send(("ready", None))
        connection.recv()
        time.sleep(60)
    finally:
        connection.close()


class FakeTranscriber:
    def __init__(self, *, ready: bool = True, failure: Exception | None = None) -> None:
        self.ready = ready
        self.failure = failure
        self.path: Path | None = None
        self.mode: int | None = None
        self.audio = b""

    def is_ready(self) -> bool:
        return self.ready

    def transcribe(self, audio_path: Path) -> TranscriptionResult:
        self.path = audio_path
        self.mode = stat.S_IMODE(audio_path.stat().st_mode)
        self.audio = audio_path.read_bytes()
        if self.failure is not None:
            raise self.failure
        return TranscriptionResult(
            text="Patient Jane Example is stable.",
            language="en",
            duration_ms=1_250,
            model="omi-health/omi-med-stt-v1-mlx-q8",
            backend="mlx",
        )


class FakeDeidentifier:
    def __init__(self, *, ready: bool = True, failure: Exception | None = None) -> None:
        self.ready = ready
        self.failure = failure
        self.last_deny_terms: tuple[dict[str, str], ...] = ()

    def is_ready(self) -> bool:
        return self.ready

    def deidentify(
        self,
        text: str,
        *,
        deny_terms: tuple[dict[str, str], ...] = (),
    ) -> DeidentificationResult:
        self.last_deny_terms = deny_terms
        if self.failure is not None:
            raise self.failure
        finding = pii_finding_for(text)
        return DeidentificationResult(
            text=text.replace("Jane Example", "Person Alpha"),
            mapping={"Person Alpha": "Jane Example"},
            pii_findings=(finding,),
            replacement_count=1,
            model="OpenMed/test-model",
            openmed_version="2.2.0-test",
            method="replace",
            policy=DEIDENTIFICATION_POLICY,
            offline=True,
            smart_merging=True,
            safety_sweep=True,
            backend=None,
            model_revision=None,
        )

    def reidentify_many(
        self, texts: list[str], mapping: dict[str, str]
    ) -> list[str]:
        results = []
        for text in texts:
            for replacement, original in mapping.items():
                text = text.replace(replacement, original)
            results.append(text)
        return results


class FailingReidentifier(FakeDeidentifier):
    def reidentify_many(
        self, texts: list[str], mapping: dict[str, str]
    ) -> list[str]:
        raise RuntimeError("Jane Example must not be echoed")


class SerialTrackingDeidentifier(FakeDeidentifier):
    def __init__(self, *, delay_seconds: float = 0.03) -> None:
        super().__init__()
        self.delay_seconds = delay_seconds
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.calls = 0

    def deidentify(self, text: str) -> DeidentificationResult:
        with self._lock:
            self.active += 1
            self.calls += 1
            self.max_active = max(self.max_active, self.active)
        try:
            time.sleep(self.delay_seconds)
            return super().deidentify(text)
        finally:
            with self._lock:
                self.active -= 1


class BlockingDeidentifier(FakeDeidentifier):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def deidentify(self, text: str) -> DeidentificationResult:
        self.entered.set()
        if not self.release.wait(timeout=5.0):
            raise RuntimeError("synthetic test timeout")
        return super().deidentify(text)


class AppTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.transcriber = FakeTranscriber()
        self.deidentifier = FakeDeidentifier()
        self.settings = Settings(temp_root=Path(self.temp_directory.name))
        self.app = create_app(
            self.settings,
            transcriber=self.transcriber,
            deidentifier=self.deidentifier,
        )
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.client.__enter__()

    def tearDown(self) -> None:
        self.client.__exit__(None, None, None)
        self.temp_directory.cleanup()

    def assert_no_request_audio_residue(self) -> None:
        root = Path(self.temp_directory.name)
        self.assertFalse(
            any(
                path.name.startswith(SCRATCH_REQUEST_PREFIX)
                or path.name.startswith("audio")
                for path in root.rglob("*")
            )
        )

    def test_health_and_readiness(self) -> None:
        self.assertEqual(self.client.get("/livez").json(), {"status": "ok"})
        self.assertEqual(self.client.get("/readyz").json(), {"status": "ready"})

    def test_readiness_is_503_when_a_dependency_is_missing(self) -> None:
        app = create_app(
            self.settings,
            transcriber=FakeTranscriber(ready=False),
            deidentifier=self.deidentifier,
        )
        with TestClient(app) as client:
            response = client.get("/readyz")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "not_ready"})

    def test_app_passes_configured_confidence_threshold_to_openmed_worker(
        self,
    ) -> None:
        settings = Settings(
            temp_root=Path(self.temp_directory.name),
            pii_confidence_threshold=0.35,
        )
        with patch(
            "local_privacy.app.OpenMedProcessDeidentifier"
        ) as deidentifier_type:
            create_app(settings, transcriber=self.transcriber)

        self.assertEqual(
            deidentifier_type.call_args.kwargs["confidence_threshold"],
            0.35,
        )

    def test_binary_transcription_uses_private_file_and_always_removes_it(self) -> None:
        response = self.client.post(
            "/v1/transcriptions",
            content=b"synthetic audio bytes",
            headers={"content-type": "audio/wav", "x-audio-suffix": ".bin"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        transcription_elapsed_ms = payload.pop("transcription_elapsed_ms")
        self.assertIsInstance(transcription_elapsed_ms, int)
        self.assertGreaterEqual(transcription_elapsed_ms, 0)
        self.assertEqual(
            payload,
            {
                "text": "Patient Jane Example is stable.",
                "language": "en",
                "duration_ms": 1250,
                "model": "omi-health/omi-med-stt-v1-mlx-q8",
                "backend": "mlx",
            },
        )
        self.assertEqual(self.transcriber.audio, b"synthetic audio bytes")
        self.assertEqual(self.transcriber.mode, 0o600)
        self.assertEqual(self.transcriber.path.suffix, ".bin")
        self.assertFalse(self.transcriber.path.exists())
        self.assert_no_request_audio_residue()

    def test_transcription_failure_is_generic_and_cleans_audio(self) -> None:
        transcriber = FakeTranscriber(failure=RuntimeError("Jane Example secret"))
        app = create_app(
            self.settings,
            transcriber=transcriber,
            deidentifier=self.deidentifier,
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.post("/v1/transcriptions", content=b"audio")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["error"]["code"], "transcription_failed")
        self.assertNotIn("Jane Example", response.text)
        self.assertFalse(transcriber.path.exists())

    def test_audio_limit_is_enforced_and_temp_file_is_removed(self) -> None:
        settings = Settings(
            temp_root=Path(self.temp_directory.name),
            max_audio_bytes=3,
        )
        app = create_app(
            settings,
            transcriber=self.transcriber,
            deidentifier=self.deidentifier,
        )
        with TestClient(app) as client:
            response = client.post("/v1/transcriptions", content=b"four")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["error"]["code"], "audio_too_large")
        self.assert_no_request_audio_residue()

    def test_transcription_admission_rejects_before_creating_a_temp_file(self) -> None:
        self.assertTrue(self.app.state.transcription_slots.acquire(blocking=False))
        try:
            response = self.client.post("/v1/transcriptions", content=b"audio")
        finally:
            self.app.state.transcription_slots.release()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "service_busy")
        self.assert_no_request_audio_residue()

    def test_startup_scavenges_only_safe_unlocked_crash_residue(self) -> None:
        service_root = (
            Path(self.temp_directory.name)
            / f"{SCRATCH_ROOT_PREFIX}{os.getuid()}"
        )
        stale_session = service_root / f"{SCRATCH_SESSION_PREFIX}stale"
        stale_request = stale_session / f"{SCRATCH_REQUEST_PREFIX}stale"
        stale_request.mkdir(parents=True, mode=0o700)
        (stale_session / SCRATCH_LOCK_NAME).write_bytes(b"")
        os.chmod(stale_session / SCRATCH_LOCK_NAME, 0o600)
        (stale_request / "audio.wav").write_bytes(b"patient audio")
        os.chmod(stale_request / "audio.wav", 0o600)
        unrelated = service_root / "unrelated"
        unrelated.mkdir()
        symlink = service_root / f"{SCRATCH_SESSION_PREFIX}symlink"
        symlink.symlink_to(unrelated, target_is_directory=True)

        app = create_app(
            self.settings,
            transcriber=FakeTranscriber(),
            deidentifier=FakeDeidentifier(),
        )
        with TestClient(app):
            self.assertFalse(stale_session.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(symlink.is_symlink())

    def test_startup_does_not_scavenge_an_active_service_session(self) -> None:
        active = _PrivateAudioScratch(Path(self.temp_directory.name))
        active.start()
        active_session = active.session
        try:
            app = create_app(
                self.settings,
                transcriber=FakeTranscriber(),
                deidentifier=FakeDeidentifier(),
            )
            with TestClient(app):
                self.assertIsNotNone(active_session)
                self.assertTrue(active_session.exists())
        finally:
            active.close()

    def test_openmed_admission_wait_is_finite_and_fail_closed(self) -> None:
        deidentifier = BlockingDeidentifier()
        settings = Settings(
            temp_root=Path(self.temp_directory.name),
            max_concurrent_openmed_requests=1,
            openmed_admission_timeout_seconds=0.05,
        )
        app = create_app(
            settings,
            transcriber=self.transcriber,
            deidentifier=deidentifier,
        )
        with TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(
                client.post,
                "/v1/deidentifications",
                json={"text": "Patient Jane Example is stable."},
            )
            self.assertTrue(deidentifier.entered.wait(timeout=1.0))
            rejected = client.post(
                "/v1/deidentifications",
                json={"text": "Patient Jane Example is stable."},
            )
            deidentifier.release.set()
            first_response = first.result(timeout=2.0)

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(rejected.status_code, 503)
        self.assertEqual(rejected.json()["error"]["code"], "service_busy")

    def test_nine_concurrent_deidentifications_queue_and_run_serially(self) -> None:
        deidentifier = SerialTrackingDeidentifier()
        settings = Settings(
            temp_root=Path(self.temp_directory.name),
            max_concurrent_openmed_requests=1,
            openmed_admission_timeout_seconds=2.0,
        )
        app = create_app(
            settings,
            transcriber=self.transcriber,
            deidentifier=deidentifier,
        )
        barrier = threading.Barrier(9)

        with TestClient(app) as client, ThreadPoolExecutor(max_workers=9) as pool:
            def submit(index: int):
                barrier.wait(timeout=2.0)
                return client.post(
                    "/v1/deidentifications",
                    json={"text": f"Patient Jane Example case {index}."},
                )

            responses = list(pool.map(submit, range(9)))

        self.assertEqual([response.status_code for response in responses], [200] * 9)
        self.assertEqual(deidentifier.calls, 9)
        self.assertEqual(deidentifier.max_active, 1)
        for response in responses:
            self.assertEqual(
                set(response.json()),
                {
                    "text",
                    "token",
                    "pii_findings",
                    "replacement_count",
                    "model",
                    "openmed_version",
                    "method",
                    "policy",
                    "offline",
                    "smart_merging",
                    "safety_sweep",
                    "backend",
                    "model_revision",
                },
            )

    def test_deidentify_then_recursively_reidentify_consumes_token(self) -> None:
        deidentified = self.client.post(
            "/v1/deidentifications",
            json={"text": "Patient Jane Example is stable."},
        )
        self.assertEqual(deidentified.status_code, 200)
        body = deidentified.json()
        self.assertEqual(body["text"], "Patient Person Alpha is stable.")
        self.assertEqual(body["replacement_count"], 1)
        self.assertEqual(body["replacement_count"], len(body["pii_findings"]))
        self.assertEqual(
            body["pii_findings"],
            [
                {
                    "original_text": "Jane Example",
                    "label": "person",
                    "entity_type": "person",
                    "canonical_label": "PERSON",
                    "start": 8,
                    "end": 20,
                    "confidence": 0.99,
                    "replacement_text": "Person Alpha",
                    "action": "replace",
                    "sources": ["model", "deterministic"],
                    "threshold": DEFAULT_PII_CONFIDENCE_THRESHOLD,
                }
            ],
        )
        self.assertEqual(body["model"], "OpenMed/test-model")
        self.assertEqual(body["openmed_version"], "2.2.0-test")
        self.assertEqual(body["method"], "replace")
        self.assertEqual(body["policy"], DEIDENTIFICATION_POLICY)
        self.assertIs(body["offline"], True)
        self.assertIs(body["smart_merging"], True)
        self.assertIs(body["safety_sweep"], True)
        self.assertIsNone(body["backend"])
        self.assertIsNone(body["model_revision"])
        self.assertNotIn("mapping", body)

        value = {
            "summary": "Person Alpha is stable.",
            "nested": ["Call Person Alpha", 7, True, None],
        }
        restored = self.client.post(
            "/v1/reidentifications",
            json={"token": body["token"], "value": value},
        )
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(
            restored.json()["value"],
            {
                "summary": "Jane Example is stable.",
                "nested": ["Call Jane Example", 7, True, None],
            },
        )

        consumed = self.client.post(
            "/v1/reidentifications",
            json={"token": body["token"], "value": "Person Alpha"},
        )
        self.assertEqual(consumed.status_code, 404)
        self.assertEqual(consumed.json()["error"]["code"], "token_invalid")

    def test_deidentification_forwards_bounded_openmed_deny_terms(self) -> None:
        response = self.client.post(
            "/v1/deidentifications",
            json={
                "text": 'Patient context: {"patientKey":"587322"}. Jane Example.',
                "deny_terms": [{"term": "587322", "label": "ID_NUM"}],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.deidentifier.last_deny_terms,
            ({"term": "587322", "label": "ID_NUM"},),
        )

        many_terms = self.client.post(
            "/v1/deidentifications",
            json={
                "text": "Jane Example patient-64",
                "deny_terms": [
                    {"term": f"patient-{index}", "label": "ID_NUM"}
                    for index in range(65)
                ],
            },
        )
        self.assertEqual(many_terms.status_code, 200)
        self.assertEqual(len(self.deidentifier.last_deny_terms), 65)

        oversized = self.client.post(
            "/v1/deidentifications",
            json={
                "text": "Jane Example",
                "deny_terms": [
                    {"term": f"patient-{index}", "label": "ID_NUM"}
                    for index in range(10_001)
                ],
            },
        )
        self.assertEqual(oversized.status_code, 400)

        oversized_term = self.client.post(
            "/v1/deidentifications",
            json={
                "text": "Jane Example",
                "deny_terms": [{"term": "x" * 513, "label": "ID_NUM"}],
            },
        )
        self.assertEqual(oversized_term.status_code, 400)

        oversized_label = self.client.post(
            "/v1/deidentifications",
            json={
                "text": "Jane Example",
                "deny_terms": [{"term": "587322", "label": "x" * 201}],
            },
        )
        self.assertEqual(oversized_label.status_code, 400)

    def test_delete_is_idempotent_and_releases_mapping(self) -> None:
        body = self.client.post(
            "/v1/deidentifications", json={"text": "Jane Example"}
        ).json()
        first = self.client.delete(f"/v1/deidentifications/{body['token']}")
        second = self.client.delete(f"/v1/deidentifications/{body['token']}")
        self.assertEqual(first.status_code, 204)
        self.assertEqual(second.status_code, 204)
        restored = self.client.post(
            "/v1/reidentifications",
            json={"token": body["token"], "value": "Person Alpha"},
        )
        self.assertEqual(restored.status_code, 404)

    def test_reidentification_failure_is_generic_and_still_consumes_token(self) -> None:
        app = create_app(
            self.settings,
            transcriber=self.transcriber,
            deidentifier=FailingReidentifier(),
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            body = client.post(
                "/v1/deidentifications", json={"text": "Jane Example"}
            ).json()
            failed = client.post(
                "/v1/reidentifications",
                json={"token": body["token"], "value": "Person Alpha"},
            )
            retried = client.post(
                "/v1/reidentifications",
                json={"token": body["token"], "value": "Person Alpha"},
            )
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(failed.json()["error"]["code"], "reidentification_failed")
        self.assertNotIn("Jane Example", failed.text)
        self.assertEqual(retried.status_code, 404)

    def test_optional_shared_secret_uses_stable_generic_error(self) -> None:
        settings = Settings(
            temp_root=Path(self.temp_directory.name),
            shared_secret="test-secret",
        )
        app = create_app(
            settings,
            transcriber=self.transcriber,
            deidentifier=self.deidentifier,
        )
        with TestClient(app) as client:
            missing = client.post(
                "/v1/deidentifications", json={"text": "Jane Example"}
            )
            allowed = client.post(
                "/v1/deidentifications",
                json={"text": "Jane Example"},
                headers={"x-local-privacy-token": "test-secret"},
            )
            health = client.get("/livez")
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing.json()["error"]["code"], "unauthorized")
        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(health.status_code, 200)

    def test_non_ascii_auth_input_is_a_stable_mismatch(self) -> None:
        self.assertFalse(_secret_matches("\u00ff", "test-secret"))

    def test_validation_errors_do_not_echo_input(self) -> None:
        response = self.client.post(
            "/v1/deidentifications",
            json={"text": ["Jane Example should not be echoed"]},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_request")
        self.assertNotIn("Jane Example", response.text)


class VaultTests(unittest.TestCase):
    def test_mapping_expires_and_is_consumed_once(self) -> None:
        now = [10.0]
        tokens = iter(["first-token", "second-token"])
        vault = MappingVault(
            ttl_seconds=5.0,
            max_entries=2,
            clock=lambda: now[0],
            token_factory=lambda: next(tokens),
        )
        first = vault.put({"Person Alpha": "Jane Example"})
        self.assertEqual(vault.consume(first), {"Person Alpha": "Jane Example"})
        self.assertIsNone(vault.consume(first))

        second = vault.put({"Person Beta": "John Example"})
        now[0] = 15.0
        self.assertIsNone(vault.consume(second))
        self.assertEqual(len(vault), 0)
        vault.close()

    def test_reaper_actively_removes_idle_expired_mapping(self) -> None:
        vault = MappingVault(ttl_seconds=0.02, max_entries=1)
        token = vault.put({"Person Alpha": "Jane Example"})
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            with vault._condition:
                if token not in vault._entries:
                    break
            time.sleep(0.01)
        with vault._condition:
            self.assertNotIn(token, vault._entries)
        vault.close()

    def test_injected_empty_vault_is_not_replaced(self) -> None:
        vault = MappingVault(
            ttl_seconds=60,
            max_entries=1,
            token_factory=lambda: "deterministic-token",
        )
        settings = Settings(temp_root=Path(tempfile.gettempdir()))
        app = create_app(
            settings,
            transcriber=FakeTranscriber(),
            deidentifier=FakeDeidentifier(),
            vault=vault,
        )
        with TestClient(app) as client:
            response = client.post(
                "/v1/deidentifications", json={"text": "Jane Example"}
            )
        self.assertEqual(response.json()["token"], "deterministic-token")


class AdapterTests(unittest.TestCase):
    def test_model_resolution_rejects_openmed_artifact_substitution(self) -> None:
        with self.assertRaises(AdapterError):
            _resolve_effective_model(
                requested_model=SUPERCLINICAL_LARGE_MLX_MODEL,
                requested_revision=None,
                offline=True,
                cache_dir=None,
                select_backend=lambda _model: "torch",
                resolve_model=lambda _model, _backend: "openai/privacy-filter",
            )

        self.assertEqual(
            _resolve_effective_model(
                requested_model=SUPERCLINICAL_LARGE_SOURCE_MODEL,
                requested_revision=None,
                offline=True,
                cache_dir=None,
                select_backend=lambda _model: "torch",
                resolve_model=lambda model, _backend: model,
            ),
            (
                SUPERCLINICAL_LARGE_SOURCE_MODEL,
                SUPERCLINICAL_LARGE_SOURCE_MODEL,
                "torch",
                None,
            ),
        )
        self.assertEqual(_openmed_config_backend("torch"), "hf")
        self.assertEqual(_openmed_config_backend("mlx"), "mlx")

    def test_reviewed_hub_model_cannot_be_shadowed_by_relative_directory(
        self,
    ) -> None:
        snapshot_calls: list[dict[str, object]] = []

        def snapshot_download(**kwargs):
            snapshot_calls.append(kwargs)
            return "/model-cache/reviewed-snapshot"

        with patch(
            "local_privacy.adapters.Path.exists",
            return_value=True,
        ), patch(
            "local_privacy.adapters.importlib.import_module",
            return_value=SimpleNamespace(snapshot_download=snapshot_download),
        ):
            resolved = _resolve_effective_model(
                requested_model=SUPERCLINICAL_LARGE_MLX_MODEL,
                requested_revision=SUPERCLINICAL_LARGE_MLX_REVISION,
                offline=True,
                cache_dir=Path("/model-cache"),
                select_backend=lambda _model: "mlx",
                resolve_model=lambda model, _backend: model,
            )

        self.assertEqual(
            resolved,
            (
                SUPERCLINICAL_LARGE_MLX_MODEL,
                "/model-cache/reviewed-snapshot",
                "mlx",
                SUPERCLINICAL_LARGE_MLX_REVISION,
            ),
        )
        self.assertEqual(
            snapshot_calls,
            [
                {
                    "repo_id": SUPERCLINICAL_LARGE_MLX_MODEL,
                    "revision": SUPERCLINICAL_LARGE_MLX_REVISION,
                    "cache_dir": "/model-cache",
                    "local_files_only": True,
                }
            ],
        )

    def test_model_resolution_preserves_explicit_custom_local_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch(
            "local_privacy.adapters.importlib.import_module"
        ) as import_module:
            resolved = _resolve_effective_model(
                requested_model=directory,
                requested_revision="local-artifact-revision",
                offline=True,
                cache_dir=None,
                select_backend=lambda _model: "torch",
                resolve_model=lambda model, _backend: model,
            )

            self.assertEqual(
                resolved,
            (directory, directory, "torch", "local-artifact-revision"),
            )
            import_module.assert_not_called()

    def test_model_resolution_preserves_explicit_relative_custom_local_path(
        self,
    ) -> None:
        with patch(
            "local_privacy.adapters.importlib.import_module"
        ) as import_module:
            resolved = _resolve_effective_model(
                requested_model="./models/custom-openmed",
                requested_revision="local-artifact-revision",
                offline=True,
                cache_dir=None,
                select_backend=lambda _model: "torch",
                resolve_model=lambda model, _backend: model,
            )

        self.assertEqual(
            resolved,
            (
                "./models/custom-openmed",
                "./models/custom-openmed",
                "torch",
                "local-artifact-revision",
            ),
        )
        import_module.assert_not_called()

    def test_openmed_process_boundary_round_trips_without_dependencies(self) -> None:
        adapter = OpenMedProcessDeidentifier(
            model_name="test-model",
            timeout_seconds=5,
            worker_target=fake_openmed_worker,
        )
        try:
            deidentified = adapter.deidentify(
                "Patient Jane Example is stable.",
                deny_terms=({"term": "587322", "label": "ID_NUM"},),
            )
            restored = adapter.reidentify_many(
                [deidentified.text, "Call Person Alpha"],
                deidentified.mapping,
            )
        finally:
            adapter.close()
        self.assertEqual(deidentified.text, "Patient Person Alpha is stable.")
        self.assertEqual(deidentified.replacement_count, 1)
        self.assertEqual(
            deidentified.replacement_count,
            len(deidentified.pii_findings),
        )
        self.assertEqual(deidentified.pii_findings[0].original_text, "Jane Example")
        self.assertEqual(
            (
                deidentified.pii_findings[0].start,
                deidentified.pii_findings[0].end,
            ),
            (8, 20),
        )
        self.assertEqual(deidentified.model, "test-model")
        self.assertEqual(deidentified.openmed_version, "2.2.0-test")
        self.assertEqual(deidentified.method, "replace")
        self.assertEqual(deidentified.policy, DEIDENTIFICATION_POLICY)
        self.assertIs(deidentified.offline, True)
        self.assertIs(deidentified.smart_merging, True)
        self.assertIs(deidentified.safety_sweep, True)
        self.assertEqual(
            deidentified.pii_findings[0].threshold,
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )
        self.assertIsNone(deidentified.backend)
        self.assertIsNone(deidentified.model_revision)
        self.assertEqual(
            restored,
            ["Patient Jane Example is stable.", "Call Jane Example"],
        )

    def test_openmed_process_boundary_rejects_non_finite_finding_metadata(self) -> None:
        adapter = OpenMedProcessDeidentifier(
            model_name="test-model",
            timeout_seconds=5,
            worker_target=malformed_openmed_worker,
        )
        try:
            with self.assertRaises(AdapterError):
                adapter.deidentify("Patient Jane Example is stable.")
        finally:
            adapter.close()

    def test_openmed_process_timeout_terminates_hung_worker(self) -> None:
        adapter = OpenMedProcessDeidentifier(
            model_name="test-model",
            timeout_seconds=0.05,
            worker_target=hanging_openmed_worker,
        )
        try:
            with self.assertRaises(AdapterError):
                adapter.deidentify("Patient Jane Example is stable.")
            self.assertIsNone(adapter._process)
        finally:
            adapter.close()

    def test_omi_nemo_worker_reuses_one_resident_process(self) -> None:
        adapter = OmiNemoProcessTranscriber(
            timeout_seconds=5,
            worker_target=fake_omi_nemo_worker,
        )
        try:
            first = adapter.transcribe(Path("/private/first.wav"))
            process_id = adapter._process.pid
            second = adapter.transcribe(Path("/private/second.wav"))
            self.assertEqual(adapter._process.pid, process_id)
        finally:
            adapter.close()

        self.assertEqual(first.text, "request 1")
        self.assertEqual(second.text, "request 2")

    def test_omi_nemo_worker_timeout_terminates_hung_process(self) -> None:
        adapter = OmiNemoProcessTranscriber(
            timeout_seconds=0.05,
            worker_target=hanging_omi_nemo_worker,
        )
        try:
            with self.assertRaises(AdapterError):
                adapter.transcribe(Path("/private/input.wav"))
            self.assertIsNone(adapter._process)
        finally:
            adapter.close()

    def test_omi_adapter_uses_matching_subprocess_model_provenance(self) -> None:
        adapter = OmiCliTranscriber(runtime="auto")
        commands: list[list[str]] = []

        def communicate(command: list[str]) -> str:
            commands.append(command)
            return json.dumps(
                {
                    "transcript": "Patient Jane Example is stable.",
                    "runtime": "mlx",
                    "duration": 1.25,
                    "model": "omi-health/omi-med-stt-v1-mlx-q8",
                    "audio": "/private/Patient-Jane-Example/audio.wav",
                    "chunks": [{"transcript": "Patient Jane Example"}],
                }
            )

        adapter._communicate = communicate
        with patch(
            "local_privacy.adapters.shutil.which", return_value="/usr/bin/omi-med-stt"
        ):
            result = adapter.transcribe(Path("/private/input.bin"))
        self.assertEqual(result.text, "Patient Jane Example is stable.")
        self.assertEqual(result.language, "en")
        self.assertEqual(result.duration_ms, 1_250)
        self.assertEqual(result.backend, "mlx")
        self.assertEqual(result.model, "omi-health/omi-med-stt-v1-mlx-q8")
        self.assertIn("--no-auto-install", commands[0])

    def test_omi_adapter_rejects_mismatched_subprocess_model_provenance(
        self,
    ) -> None:
        adapter = OmiCliTranscriber(runtime="auto")
        adapter._communicate = lambda _command: json.dumps(
            {
                "transcript": "Patient Jane Example is stable.",
                "runtime": "mlx",
                "duration": 1.25,
                "model": "omi-health/unreviewed-stt-weights",
            }
        )

        with patch(
            "local_privacy.adapters.shutil.which",
            return_value="/usr/bin/omi-med-stt",
        ), self.assertRaises(AdapterError):
            adapter.transcribe(Path("/private/input.bin"))

    def test_omi_adapter_rejects_backend_different_from_configured_runtime(
        self,
    ) -> None:
        adapter = OmiCliTranscriber(runtime="mlx")
        adapter._communicate = lambda _command: json.dumps(
            {
                "transcript": "Patient Jane Example is stable.",
                "runtime": "nemo",
                "duration": 1.25,
                "model": "omi-health/omi-med-stt-v1",
            }
        )

        with patch(
            "local_privacy.adapters.shutil.which",
            return_value="/usr/bin/omi-med-stt",
        ), self.assertRaises(AdapterError):
            adapter.transcribe(Path("/private/input.bin"))

    def test_omi_offline_mode_forces_cache_only_subprocess_environment(self) -> None:
        captured: dict[str, object] = {}

        class FakeProcess:
            returncode = 0

            def communicate(self, *, timeout: float):
                return ("{}", None)

        def fake_popen(command, **kwargs):
            captured["command"] = command
            captured.update(kwargs)
            return FakeProcess()

        adapter = OmiCliTranscriber(runtime="mlx", offline=True)
        with patch.dict(os.environ, {
            "HF_HUB_OFFLINE": "0",
            "OPENAI_API_KEY": "must-not-reach-omi",
            "DATABASE_URL": "must-not-reach-omi",
            "LOCAL_PRIVACY_SHARED_SECRET": "must-not-reach-models",
        }), patch(
            "local_privacy.adapters.subprocess.Popen", side_effect=fake_popen
        ):
            adapter._communicate(["omi-med-stt", "audio.bin"])

        environment = captured["env"]
        self.assertEqual(environment["HF_HUB_OFFLINE"], "1")
        self.assertEqual(environment["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(environment["HF_DATASETS_OFFLINE"], "1")
        self.assertEqual(environment["HF_HUB_DISABLE_TELEMETRY"], "1")
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("DATABASE_URL", environment)
        self.assertNotIn("LOCAL_PRIVACY_SHARED_SECRET", environment)

    def test_service_and_model_environment_allowlists_drop_cloud_secrets(self) -> None:
        source = {
            "PATH": "/usr/bin:/bin",
            "HF_HOME": "/private/model-cache",
            "LOCAL_PRIVACY_SHARED_SECRET": "local-only-token",
            "LOCAL_PRIVACY_STT_RUNTIME": "mlx",
            "OPENAI_API_KEY": "cloud-secret",
            "ASSEMBLYAI_API_KEY": "cloud-secret",
            "DATABASE_URL": "postgres://cloud-secret",
            "SESSION_SECRET": "cloud-secret",
            "HANDOVER_DSPY_SHARED_SECRET": "cloud-secret",
        }

        service = allowlisted_environment(source, include_service_settings=True)
        model = allowlisted_environment(source, include_service_settings=False)

        self.assertEqual(service["LOCAL_PRIVACY_SHARED_SECRET"], "local-only-token")
        self.assertEqual(service["LOCAL_PRIVACY_STT_RUNTIME"], "mlx")
        self.assertEqual(service["HF_HOME"], "/private/model-cache")
        self.assertNotIn("OPENAI_API_KEY", service)
        self.assertNotIn("DATABASE_URL", service)
        self.assertNotIn("SESSION_SECRET", service)
        self.assertEqual(model, {
            "PATH": "/usr/bin:/bin",
            "HF_HOME": "/private/model-cache",
        })

    def test_openmed_adapter_enforces_the_privacy_policy(self) -> None:
        captured: dict[str, object] = {}

        def fake_deidentify(text: str, **kwargs):
            captured["text"] = text
            captured.update(kwargs)
            return SimpleNamespace(
                deidentified_text="Patient Person Alpha is stable.",
                mapping={"Person Alpha": "Jane Example"},
                pii_entities=[openmed_entity_for(text)],
            )

        adapter = OpenMedDeidentifier(model_name="test-model", offline=True)
        adapter._deidentify_function = fake_deidentify
        adapter._reidentify_function = lambda text, mapping: text
        adapter._config = object()
        adapter._loader = object()
        adapter._openmed_version = "2.2.0-test"
        adapter._policy = application_openmed_policy()
        result = adapter.deidentify(
            "Patient Jane Example with identifier 587322 is stable.",
            deny_terms=({"term": "587322", "label": "ID_NUM"},),
        )

        self.assertEqual(result.replacement_count, 1)
        self.assertEqual(result.replacement_count, len(result.pii_findings))
        self.assertEqual(result.pii_findings[0].original_text, "Jane Example")
        self.assertEqual(result.pii_findings[0].replacement_text, "Person Alpha")
        self.assertEqual(
            result.pii_findings[0].threshold,
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )
        self.assertEqual(result.model, "test-model")
        self.assertEqual(result.openmed_version, "2.2.0-test")
        self.assertIsNone(result.backend)
        self.assertIsNone(result.model_revision)
        self.assertEqual(captured["method"], "replace")
        self.assertEqual(
            captured["confidence_threshold"],
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )
        policy = captured["policy"]
        self.assertEqual(policy.name, DEIDENTIFICATION_POLICY)
        self.assertIs(policy.strict_no_leak, True)
        self.assertEqual(policy.arbitration_mode, "high_recall_union")
        self.assertIs(policy.safety_sweep_mandatory, True)
        from openmed.core.policy import load_policy

        base_policy = load_policy("strict_no_leak")
        for label, base_action in base_policy.actions.items():
            expected_action = (
                "keep"
                if label in DOWNSTREAM_ALLOWED_ENTITY_TYPES
                else base_action
            )
            self.assertEqual(policy.action_for(label), expected_action)
        self.assertEqual(
            {
                label
                for label, action in policy.actions.items()
                if action == "keep"
            },
            set(DOWNSTREAM_ALLOWED_ENTITY_TYPES),
        )
        for protected_label in (
            "PERSON",
            "FIRST_NAME",
            "STREET_ADDRESS",
            "BUILDING_NUMBER",
            "ZIPCODE",
            "DATE_OF_BIRTH",
            "ID_NUM",
            "PIN",
            "OTHER",
        ):
            self.assertNotEqual(policy.action_for(protected_label), "keep")
        self.assertIs(captured["keep_mapping"], True)
        self.assertIs(captured["use_smart_merging"], True)
        self.assertIs(captured["use_safety_sweep"], True)
        self.assertIs(captured["cache_results"], False)
        self.assertEqual(
            captured["custom_recognizer"],
            {
                "case_sensitive": True,
                "deny": {
                    "terms": [{"term": "587322", "label": "ID_NUM"}],
                },
            },
        )

    def test_openmed_adapter_preloads_inference_pipeline_once(self) -> None:
        calls: list[tuple[str, dict[str, object]]] = []

        class FakeLoader:
            def create_pipeline(self, model_name: str, **kwargs):
                calls.append((model_name, kwargs))
                return object()

        adapter = OpenMedDeidentifier(model_name="test-model", offline=True)
        adapter._deidentify_function = lambda text, **kwargs: None
        adapter._policy = application_openmed_policy()
        adapter._loader = FakeLoader()
        adapter._effective_model_reference = "/models/test-model-snapshot"

        adapter.preload()
        adapter.preload()

        self.assertEqual(
            calls,
            [
                (
                    "/models/test-model-snapshot",
                    {
                        "task": "token-classification",
                        "aggregation_strategy": "simple",
                        "use_fast_tokenizer": True,
                    },
                )
            ],
        )

    def test_openmed_adapter_runs_source_labels_before_arbitration(self) -> None:
        from openmed.core import OpenMedConfig
        from openmed.core.custom_recognizer import CustomMatch, CustomRecognizer
        from openmed.core.labels import normalize_label
        from openmed.core.pipeline import Pipeline
        from openmed.processing.outputs import EntityPrediction, PredictionResult

        text = "Company Acme Health. Patient Jane Example."
        company = "Acme Health"
        person = "Jane Example"
        company_start = text.index(company)
        person_start = text.index(person)
        calls: list[dict[str, object]] = []

        def fake_extract(model_text: str, **kwargs):
            calls.append(kwargs)
            return PredictionResult(
                text=model_text,
                entities=[
                    EntityPrediction(
                        text=company,
                        label="company_name",
                        confidence=0.99,
                        start=company_start,
                        end=company_start + len(company),
                    ),
                    EntityPrediction(
                        text=person,
                        label="PERSON",
                        confidence=0.99,
                        start=person_start,
                        end=person_start + len(person),
                    ),
                ],
                model_name="fixture-superclinical",
                timestamp="2026-08-27T00:00:00",
            )

        adapter = OpenMedDeidentifier(
            model_name=SUPERCLINICAL_LARGE_MLX_MODEL,
            model_revision=SUPERCLINICAL_LARGE_MLX_REVISION,
            offline=True,
        )
        adapter._deidentify_function = lambda *_args, **_kwargs: self.fail(
            "top-level deidentify must not run for the source-label bridge"
        )
        adapter._reidentify_function = lambda value, mapping: value
        adapter._config = OpenMedConfig(local_only=True)
        adapter._loader = object()
        adapter._openmed_version = "2.2.0-test"
        adapter._backend = "mlx"
        adapter._effective_model_id = SUPERCLINICAL_LARGE_MLX_MODEL
        adapter._effective_model_reference = SUPERCLINICAL_LARGE_MLX_MODEL
        adapter._model_revision = SUPERCLINICAL_LARGE_MLX_REVISION
        adapter._policy = application_openmed_policy()
        adapter._pipeline_type = Pipeline
        adapter._extract_pii_function = fake_extract
        adapter._source_label_recognizer_type = create_source_label_recognizer_type(
            CustomRecognizer,
            CustomMatch,
            normalize_label,
        )

        result = adapter.deidentify(text)

        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0]["confidence_threshold"],
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )
        self.assertIn(company, result.text)
        self.assertNotIn(person, result.text)
        self.assertEqual(
            [finding.original_text for finding in result.pii_findings],
            [person],
        )
        self.assertEqual(
            [finding.threshold for finding in result.pii_findings],
            [DEFAULT_PII_CONFIDENCE_THRESHOLD],
        )
        self.assertEqual(result.policy, "handover_context_v2")

    def test_openmed_policy_keeps_context_but_masks_specific_identifiers(
        self,
    ) -> None:
        from openmed.core.pipeline import Pipeline
        from openmed.processing.outputs import EntityPrediction

        text = (
            "Jane Example, age 72, male respiratory physician from Brisbane, "
            "reviewed at 14:30. DOB 4 November 1982. Lives at 12 Smith Street, "
            "Brisbane QLD 4000. MRN 587322."
        )
        fixtures = {
            "Jane Example": "PERSON",
            "72": "AGE",
            "male": "GENDER",
            "respiratory physician": "OCCUPATION",
            "Brisbane": "LOCATION",
            "14:30": "TIME",
            "4 November 1982": "DATE_OF_BIRTH",
            "12 Smith Street": "STREET_ADDRESS",
            "4000": "ZIPCODE",
            "587322": "ID_NUM",
        }
        entities = []
        for surface, label in fixtures.items():
            start = text.index(surface)
            entities.append(
                EntityPrediction(
                    surface,
                    label,
                    0.99,
                    start,
                    start + len(surface),
                    metadata={"source": "fixture"},
                )
            )

        def model_detector(_text: str, **_kwargs):
            return SimpleNamespace(
                entities=entities,
                model_name="fixture",
                metadata={},
            )

        pipeline = Pipeline(
            model_name="fixture",
            policy=application_openmed_policy(),
            model_detector=model_detector,
            use_safety_sweep=True,
        )
        result = pipeline.run(
            text,
            method="replace",
            keep_mapping=True,
        ).deidentification_result

        allowed_surfaces = {
            "72",
            "male",
            "respiratory physician",
            "Brisbane",
            "14:30",
        }
        for surface in allowed_surfaces:
            self.assertIn(surface, result.deidentified_text)
        self.assertTrue(
            all(
                entity.canonical_label not in DOWNSTREAM_ALLOWED_ENTITY_TYPES
                for entity in result.pii_entities
            )
        )
        self.assertTrue(
            all(
                original not in allowed_surfaces
                for original in result.mapping.values()
            )
        )

        for surface in (
            "Jane Example",
            "4 November 1982",
            "12 Smith Street",
            "4000",
            "587322",
        ):
            self.assertNotIn(surface, result.deidentified_text)
        self.assertTrue(
            {
                "PERSON",
                "DATE_OF_BIRTH",
                "STREET_ADDRESS",
                "ZIPCODE",
                "ID_NUM",
            }
            <= {entity.canonical_label for entity in result.pii_entities}
        )

    def test_openmed_source_label_policy_allows_only_the_ten_exact_labels(
        self,
    ) -> None:
        from openmed.processing.outputs import EntityPrediction

        allowed = [
            ("O positive", "blood_type"),
            ("Acme Health", "company_name"),
            ("2026-08-27T15:45:00Z", "date_time"),
            ("Bachelor of Nursing", "education_level"),
            ("full-time", "employment_status"),
            ("English", "language"),
            ("centrist", "political_view"),
            ("European", "race_ethnicity"),
            ("Buddhist", "religious_belief"),
            ("bisexual", "sexuality"),
        ]
        protected_labels = [
            "bank_routing_number",
            "biometric_identifier",
            "certificate_license_number",
            "coordinate",
            "customer_id",
            "device_identifier",
            "employee_id",
            "fax_number",
            "health_plan_beneficiary_number",
            "http_cookie",
            "ipv4",
            "ipv6",
            "swift_bic",
            "tax_id",
            "unique_id",
            "vehicle_identifier",
        ]
        protected = [
            (f"protected-{index}-token", label)
            for index, label in enumerate(protected_labels)
        ]
        fixtures = [*allowed, *protected]
        text = " | ".join(surface for surface, _label in fixtures)
        entities = []
        cursor = 0
        for surface, label in fixtures:
            start = text.index(surface, cursor)
            cursor = start + len(surface)
            entities.append(
                EntityPrediction(
                    text=surface,
                    label=label,
                    confidence=0.99,
                    start=start,
                    end=cursor,
                )
            )

        result, recognizer = run_source_label_fixture(text, entities)

        for surface, _label in allowed:
            self.assertIn(surface, result.deidentified_text)
            self.assertNotIn(surface, result.mapping.values())
        for surface, _label in protected:
            self.assertNotIn(surface, result.deidentified_text)
            self.assertIn(surface, result.mapping.values())
        self.assertEqual(
            {span.source_label for span in recognizer.allowed_source_spans},
            set(ALLOWED_SOURCE_LABELS),
        )
        self.assertEqual(
            {span.application_label for span in recognizer.allowed_source_spans},
            set(ALLOWED_SOURCE_LABELS.values()),
        )
        self.assertTrue(
            set(protected_labels)
            <= {entity.entity_type for entity in result.pii_entities}
        )

    def test_source_label_policy_fails_closed_before_other_arbitration(
        self,
    ) -> None:
        from openmed.processing.outputs import EntityPrediction

        text = "Acme 123456 | BloodAlias | CompanyAlias | UnknownAlias"
        shared = "Acme 123456"
        fixtures = [
            EntityPrediction(
                text=shared,
                label="company_name",
                confidence=0.99,
                start=0,
                end=len(shared),
            ),
            EntityPrediction(
                text=shared,
                label="bank_routing_number",
                confidence=0.98,
                start=0,
                end=len(shared),
            ),
        ]
        for surface, label in (
            ("BloodAlias", "Blood_Type"),
            ("CompanyAlias", "company-name"),
            ("UnknownAlias", "unknown_other"),
        ):
            start = text.index(surface)
            fixtures.append(
                EntityPrediction(
                    text=surface,
                    label=label,
                    confidence=0.99,
                    start=start,
                    end=start + len(surface),
                )
            )

        result, recognizer = run_source_label_fixture(text, fixtures)

        for surface in (shared, "BloodAlias", "CompanyAlias", "UnknownAlias"):
            self.assertNotIn(surface, result.deidentified_text)
        self.assertEqual(recognizer.allowed_source_spans, ())
        self.assertNotEqual(application_openmed_policy().action_for("OTHER"), "keep")

    def test_source_label_policy_preserves_explicit_deny_and_dob_evidence(
        self,
    ) -> None:
        from openmed.processing.outputs import EntityPrediction

        text = (
            "Language English. Event 2026-08-27T15:45:00Z. "
            "DOB 1982-11-04T09:15:00Z. Mixed 1970-01-02T03:04:05Z."
        )
        entities = []
        for surface, label, metadata in (
            ("English", "language", None),
            ("2026-08-27T15:45:00Z", "date_time", None),
            ("1982-11-04T09:15:00Z", "date_time", None),
            (
                "1970-01-02T03:04:05Z",
                "date_time",
                {
                    "semantic_merge": {
                        "source_labels": ["date_time", "date_of_birth"],
                        "mixed_label_union": False,
                    }
                },
            ),
        ):
            start = text.index(surface)
            entities.append(
                EntityPrediction(
                    text=surface,
                    label=label,
                    confidence=0.99,
                    start=start,
                    end=start + len(surface),
                    metadata=metadata,
                )
            )

        result, recognizer = run_source_label_fixture(
            text,
            entities,
            deny_terms=({"term": "English", "label": "PERSON"},),
        )

        self.assertNotIn("English", result.deidentified_text)
        self.assertIn("2026-08-27T15:45:00Z", result.deidentified_text)
        self.assertNotIn("1982-11-04T09:15:00Z", result.deidentified_text)
        self.assertNotIn("1970-01-02T03:04:05Z", result.deidentified_text)
        self.assertEqual(
            [span.source_label for span in recognizer.allowed_source_spans],
            ["date_time"],
        )

    def test_date_time_source_label_never_allows_birth_context_variants(self) -> None:
        from openmed.processing.outputs import EntityPrediction

        for text, surface in (
            ("The patient was born in 1987.", "1987"),
            ("The patient was born on 5 November 1987.", "5 November 1987"),
            ("Birthday is 5 November 1987.", "5 November 1987"),
            ("The patient's birthday is 1982-11-04.", "1982-11-04"),
            ("Birth day: 12 January 1974.", "12 January 1974"),
            ("D.O.B. 1982-11-04.", "1982-11-04"),
            ("Birth date: 1982-11-04T09:15:00Z.", "1982-11-04T09:15:00Z"),
            ("DOB 1982-11-04", "DOB 1982-11-04"),
            ("1982-11-04 (DOB)", "1982-11-04"),
        ):
            with self.subTest(text=text):
                start = text.index(surface)
                entity = EntityPrediction(
                    text=surface,
                    label="date_time",
                    confidence=0.99,
                    start=start,
                    end=start + len(surface),
                )
                result, recognizer = run_source_label_fixture(text, [entity])
                self.assertNotIn(surface, result.deidentified_text)
                self.assertEqual(recognizer.allowed_source_spans, ())

        event = "Reviewed at 2026-08-27T15:45:00Z."
        surface = "2026-08-27T15:45:00Z"
        start = event.index(surface)
        result, recognizer = run_source_label_fixture(
            event,
            [
                EntityPrediction(
                    text=surface,
                    label="date_time",
                    confidence=0.99,
                    start=start,
                    end=start + len(surface),
                )
            ],
        )
        self.assertIn(surface, result.deidentified_text)
        self.assertEqual(len(recognizer.allowed_source_spans), 1)

    def test_source_label_policy_is_versioned_and_model_family_gated(self) -> None:
        policy = application_openmed_policy()

        self.assertEqual(policy.name, "handover_context_v2")
        self.assertEqual(
            policy.metadata["application_allowed_source_labels"],
            dict(sorted(ALLOWED_SOURCE_LABELS.items())),
        )
        self.assertEqual(
            policy.metadata["application_source_label_policy"],
            SOURCE_LABEL_POLICY,
        )
        self.assertTrue(
            supports_source_label_policy(
                SUPERCLINICAL_LARGE_MLX_MODEL,
                backend="mlx",
                model_revision=SUPERCLINICAL_LARGE_MLX_REVISION,
            )
        )
        self.assertTrue(
            supports_source_label_policy(
                SUPERCLINICAL_LARGE_SOURCE_MODEL,
                backend="torch",
                model_revision=SUPERCLINICAL_LARGE_SOURCE_REVISION,
            )
        )
        self.assertFalse(
            supports_source_label_policy(
                "OpenMed/OpenMed-PII-SuperClinical-Large-fixture",
                backend="mlx",
                model_revision=SUPERCLINICAL_LARGE_MLX_REVISION,
            )
        )

    def test_request_local_exact_deny_matcher_supports_ten_thousand_terms(self) -> None:
        deny_terms = tuple(
            {"term": f"PatientKey-{index:05d}", "label": "ID_NUM"}
            for index in range(10_000)
        )
        recognizer = source_label_recognizer(
            deny_terms=deny_terms,
            allow_source_labels=False,
        )

        matches = recognizer.deny_matches(
            "PatientKey-00000 and PatientKey-09999; patientkey-09999 differs."
        )

        self.assertEqual(
            [(match.start, match.end, match.label) for match in matches],
            [(0, 16, "ID_NUM"), (21, 37, "ID_NUM")],
        )

    def test_exact_deny_terms_have_an_aggregate_character_budget(self) -> None:
        over_budget = tuple(
            {
                "term": f"{index:04d}" + ("x" * 508),
                "label": "ID_NUM",
            }
            for index in range(3_907)
        )
        with self.assertRaises(AdapterError):
            _normalize_deny_terms(over_budget)
        self.assertFalse(
            supports_source_label_policy(
                SUPERCLINICAL_LARGE_MLX_MODEL,
                backend="torch",
                model_revision=SUPERCLINICAL_LARGE_MLX_REVISION,
            )
        )

    def test_openmed_findings_use_codepoint_offsets_and_are_sorted(self) -> None:
        source_text = "🩺 Jane Example called 5555."
        phone_start = source_text.index("5555")
        entities = [
            SimpleNamespace(
                text="5555",
                original_text="5555",
                label="phone",
                entity_type="phone",
                canonical_label="PHONE",
                start=phone_start,
                end=phone_start + 4,
                confidence=0.97,
                redacted_text="Phone Alpha",
                action="replace",
                sources=["model"],
                threshold=DEFAULT_PII_CONFIDENCE_THRESHOLD,
            ),
            openmed_entity_for(source_text),
        ]

        adapter = OpenMedDeidentifier(model_name="test-model", offline=True)
        adapter._deidentify_function = lambda text, **kwargs: SimpleNamespace(
            deidentified_text="🩺 Person Alpha called Phone Alpha.",
            mapping={
                "Person Alpha": "Jane Example",
                "Phone Alpha": "5555",
            },
            pii_entities=entities,
        )
        adapter._reidentify_function = lambda text, mapping: text
        adapter._config = object()
        adapter._loader = object()
        adapter._openmed_version = "2.2.0-test"
        adapter._policy = application_openmed_policy()

        result = adapter.deidentify(source_text)

        self.assertEqual(
            [
                (finding.original_text, finding.start, finding.end)
                for finding in result.pii_findings
            ],
            [("Jane Example", 2, 14), ("5555", phone_start, phone_start + 4)],
        )

    def test_openmed_invalid_finding_metadata_fails_closed(self) -> None:
        source_text = "Patient Jane Example is stable."
        invalid_entity_groups = {
            "source slice mismatch": [
                openmed_entity_for(
                    source_text,
                    original_text="John Example",
                )
            ],
            "out of bounds": [
                openmed_entity_for(
                    source_text,
                    end=len(source_text) + 1,
                )
            ],
            "non-finite confidence": [
                openmed_entity_for(
                    source_text,
                    confidence=float("nan"),
                )
            ],
            "non-finite threshold": [
                openmed_entity_for(
                    source_text,
                    threshold=float("inf"),
                )
            ],
            "too many sources": [
                openmed_entity_for(
                    source_text,
                    sources=[f"source-{index}" for index in range(17)],
                )
            ],
        }

        for label, entities in invalid_entity_groups.items():
            with self.subTest(label=label):
                adapter = OpenMedDeidentifier(model_name="test-model", offline=True)
                adapter._deidentify_function = lambda text, **kwargs: SimpleNamespace(
                    deidentified_text="Patient Person Alpha is stable.",
                    mapping={"Person Alpha": "Jane Example"},
                    pii_entities=entities,
                )
                adapter._reidentify_function = lambda text, mapping: text
                adapter._config = object()
                adapter._loader = object()
                adapter._openmed_version = "2.2.0-test"
                adapter._policy = application_openmed_policy()

                with self.assertRaises(AdapterError):
                    adapter.deidentify(source_text)

    def test_openmed_preserves_overlapping_high_recall_findings(self) -> None:
        source_text = "Patient Jane Example is stable."
        adapter = OpenMedDeidentifier(model_name="test-model", offline=True)
        adapter._deidentify_function = lambda text, **kwargs: SimpleNamespace(
            deidentified_text="Patient Person Alpha is stable.",
            mapping={"Person Alpha": "Jane Example"},
            pii_entities=[
                openmed_entity_for(source_text),
                openmed_entity_for(
                    source_text,
                    label="given_name",
                    entity_type="given_name",
                ),
            ],
        )
        adapter._reidentify_function = lambda text, mapping: text
        adapter._config = object()
        adapter._loader = object()
        adapter._openmed_version = "2.2.0-test"
        adapter._policy = application_openmed_policy()

        result = adapter.deidentify(source_text)

        self.assertEqual(len(result.pii_findings), 2)
        self.assertEqual(result.replacement_count, 2)

    def test_openmed_lookup_prefers_documented_top_level_exports(self) -> None:
        def top_deidentify():
            return "top deidentify"

        def top_reidentify():
            return "top reidentify"

        def fallback_deidentify():
            return "fallback deidentify"

        def fallback_reidentify():
            return "fallback reidentify"

        resolved = _resolve_openmed_functions(
            SimpleNamespace(
                deidentify=top_deidentify,
                reidentify=top_reidentify,
            ),
            SimpleNamespace(
                deidentify=fallback_deidentify,
                reidentify=fallback_reidentify,
            ),
        )
        self.assertEqual(resolved, (top_deidentify, top_reidentify))

    def test_openmed_lookup_uses_core_fallback_when_top_level_is_absent(self) -> None:
        def fallback_deidentify():
            return "fallback deidentify"

        def fallback_reidentify():
            return "fallback reidentify"

        resolved = _resolve_openmed_functions(
            SimpleNamespace(),
            SimpleNamespace(
                deidentify=fallback_deidentify,
                reidentify=fallback_reidentify,
            ),
        )
        self.assertEqual(resolved, (fallback_deidentify, fallback_reidentify))


class SettingsTests(unittest.TestCase):
    def test_platform_defaults_pin_superclinical_large_artifacts(self) -> None:
        with patch("local_privacy.config.platform.system", return_value="Darwin"), patch(
            "local_privacy.config.platform.machine",
            return_value="arm64",
        ):
            apple = Settings()
        with patch("local_privacy.config.platform.system", return_value="Linux"), patch(
            "local_privacy.config.platform.machine",
            return_value="aarch64",
        ):
            nvidia = Settings()

        self.assertEqual(apple.pii_model, SUPERCLINICAL_LARGE_MLX_MODEL)
        self.assertEqual(
            apple.pii_model_revision,
            SUPERCLINICAL_LARGE_MLX_REVISION,
        )
        self.assertEqual(nvidia.pii_model, SUPERCLINICAL_LARGE_SOURCE_MODEL)
        self.assertEqual(
            nvidia.pii_model_revision,
            SUPERCLINICAL_LARGE_SOURCE_REVISION,
        )
        self.assertEqual(
            apple.pii_confidence_threshold,
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )
        self.assertEqual(
            nvidia.pii_confidence_threshold,
            DEFAULT_PII_CONFIDENCE_THRESHOLD,
        )

    def test_confidence_threshold_env_override_is_bounded_probability(self) -> None:
        with patch.dict(
            os.environ,
            {"LOCAL_PRIVACY_PII_CONFIDENCE_THRESHOLD": "0.35"},
            clear=True,
        ):
            settings = Settings.from_env()
        self.assertEqual(settings.pii_confidence_threshold, 0.35)

        for invalid in ("-0.1", "1.1", "nan", "inf", "not-a-number"):
            with self.subTest(invalid=invalid), patch.dict(
                os.environ,
                {"LOCAL_PRIVACY_PII_CONFIDENCE_THRESHOLD": invalid},
                clear=True,
            ):
                with self.assertRaises(ValueError):
                    Settings.from_env()

        for invalid in (-0.1, 1.1, float("nan"), float("inf"), True, "0.5"):
            with self.subTest(direct=invalid):
                with self.assertRaises(ValueError):
                    Settings(pii_confidence_threshold=invalid)

    def test_explicit_model_override_is_preserved(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LOCAL_PRIVACY_PII_MODEL": "local/custom-model",
                "LOCAL_PRIVACY_PII_MODEL_REVISION": "sha256:verified",
            },
            clear=False,
        ):
            settings = Settings.from_env()
        self.assertEqual(settings.pii_model, "local/custom-model")
        self.assertEqual(settings.pii_model_revision, "sha256:verified")

    def test_non_finite_timeouts_and_ttls_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Settings(stt_timeout_seconds=float("nan"))
        with self.assertRaises(ValueError):
            Settings(mapping_ttl_seconds=float("inf"))
        with self.assertRaises(ValueError):
            Settings(body_read_timeout_seconds=float("nan"))
        with self.assertRaises(ValueError):
            Settings(openmed_admission_timeout_seconds=float("inf"))
        with self.assertRaises(ValueError):
            Settings(max_json_depth=129)


if __name__ == "__main__":
    unittest.main()
