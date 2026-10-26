from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time
from typing import Any, Callable, Literal

import dspy

from handover_prod.config import Settings
from handover_prod.lm import configure_dspy
from handover_prod.tasks.checklist import (
    CHECKLIST_LABELS,
    build_predictor as build_checklist_predictor,
)
from handover_prod.tasks.sbar import (
    SBAR_LABELS,
    build_predictor as build_sbar_predictor,
)
from handover_prod.tasks.unknown_fact import (
    UNKNOWN_FACT_LABELS,
    build_predictor as build_unknown_fact_predictor,
)

TaskName = Literal["checklist", "sbar", "unknown_fact"]


def _coerce_mapping_item(item: Any) -> dict[str, Any]:
    if isinstance(item, dict):
        return item
    out: dict[str, Any] = {}
    for key in ("label", "quote"):
        value = getattr(item, key, None)
        if value is not None:
            out[key] = value
    return out


def _normalize_spans(
    value: Any, *, allowed_labels: set[str], task_name: str
) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(
            f"{task_name} expected a list of span dicts, got {type(value).__name__}"
        )

    normalized: list[dict[str, str]] = []
    for item in value:
        record = _coerce_mapping_item(item)
        label = record.get("label")
        quote = record.get("quote")
        if not isinstance(label, str) or not isinstance(quote, str):
            raise TypeError(
                f"{task_name} predicted an invalid span item: {item!r}"
            )
        if label not in allowed_labels:
            raise ValueError(f"{task_name} predicted unsupported label {label!r}")
        normalized.append({"label": label, "quote": quote})
    return normalized


def _normalize_checklist_labels(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise TypeError(
            f"checklist expected a list of labels, got {type(value).__name__}"
        )

    labels: list[str] = []
    seen: set[str] = set()
    for item in value:
        label = str(item)
        if label not in CHECKLIST_LABELS:
            raise ValueError(f"checklist predicted unsupported label {label!r}")
        if label not in seen:
            seen.add(label)
            labels.append(label)
    return labels


def _prediction_output(prediction: Any, field_name: str) -> Any:
    to_dict = getattr(prediction, "toDict", None)
    if callable(to_dict):
        try:
            value = to_dict().get(field_name)
        except Exception:
            value = None
        if value is not None:
            return value

    if isinstance(prediction, dict):
        return prediction.get(field_name)

    value = getattr(prediction, field_name, None)
    if callable(value):
        return None
    return value


@dataclass(frozen=True)
class PredictionResult:
    task: TaskName
    model: str
    program_path: str
    latency_ms: float
    labels: list[str] | None = None
    pred_spans: list[dict[str, str]] | None = None


@dataclass
class CompiledTask:
    name: TaskName
    predictor: Any
    program_path: Path
    model: str
    output_type: Literal["labels", "pred_spans"]
    allowed_labels: set[str]

    def predict(self, text: str) -> PredictionResult:
        started_at = time.perf_counter()
        prediction = self.predictor(text=text)
        latency_ms = (time.perf_counter() - started_at) * 1000.0

        if self.output_type == "labels":
            labels = _normalize_checklist_labels(
                _prediction_output(prediction, "labels")
            )
            return PredictionResult(
                task=self.name,
                model=self.model,
                program_path=str(self.program_path),
                latency_ms=latency_ms,
                labels=labels,
            )

        spans = _normalize_spans(
            _prediction_output(prediction, "pred_spans"),
            allowed_labels=self.allowed_labels,
            task_name=self.name,
        )
        return PredictionResult(
            task=self.name,
            model=self.model,
            program_path=str(self.program_path),
            latency_ms=latency_ms,
            pred_spans=spans,
        )


def _load_predictor(
    builder: Callable[[], dspy.Module],
    program_path: Path,
) -> Any:
    predictor = builder()
    predictor.load(str(program_path))
    return predictor


class PredictorRegistry:
    def __init__(self, tasks: dict[TaskName, CompiledTask]):
        self._tasks = tasks

    @classmethod
    def from_settings(
        cls,
        settings: Settings,
        *,
        configure_lm: bool = False,
    ) -> "PredictorRegistry":
        if configure_lm:
            configure_dspy(settings)

        for path in settings.task_program_paths().values():
            if not path.exists():
                raise FileNotFoundError(f"Compiled program not found: {path}")

        tasks: dict[TaskName, CompiledTask] = {
            "checklist": CompiledTask(
                name="checklist",
                predictor=_load_predictor(
                    build_checklist_predictor, settings.checklist_program_path
                ),
                program_path=settings.checklist_program_path,
                model=settings.model,
                output_type="labels",
                allowed_labels=set(CHECKLIST_LABELS),
            ),
            "sbar": CompiledTask(
                name="sbar",
                predictor=_load_predictor(build_sbar_predictor, settings.sbar_program_path),
                program_path=settings.sbar_program_path,
                model=settings.model,
                output_type="pred_spans",
                allowed_labels=set(SBAR_LABELS),
            ),
            "unknown_fact": CompiledTask(
                name="unknown_fact",
                predictor=_load_predictor(
                    build_unknown_fact_predictor, settings.unknown_fact_program_path
                ),
                program_path=settings.unknown_fact_program_path,
                model=settings.model,
                output_type="pred_spans",
                allowed_labels=set(UNKNOWN_FACT_LABELS),
            ),
        }
        return cls(tasks)

    def task_metadata(self) -> dict[str, dict[str, str]]:
        return {
            name: {
                "program_path": str(task.program_path),
                "model": task.model,
            }
            for name, task in self._tasks.items()
        }

    def predict(self, task_name: TaskName, text: str) -> PredictionResult:
        return self._tasks[task_name].predict(text)
