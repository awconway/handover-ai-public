from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

MAX_PREDICTION_TEXT_CHARS = 24_000


class TextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_PREDICTION_TEXT_CHARS)


class PredictRequest(TextRequest):
    task: Literal["checklist", "sbar", "unknown_fact"]


class LabelQuote(BaseModel):
    label: str
    quote: str


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str


class ReadyResponse(BaseModel):
    status: Literal["ready"]
    tasks: dict[str, dict[str, str]]


class ProvenanceResponse(BaseModel):
    service: str
    version: str
    provider: str
    model: str


class GenericPredictionResponse(BaseModel):
    task: Literal["checklist", "sbar", "unknown_fact"]
    model: str
    program_path: str
    latency_ms: float
    labels: list[str] | None = None
    pred_spans: list[LabelQuote] | None = None


class ChecklistPredictionResponse(BaseModel):
    task: Literal["checklist"]
    model: str
    program_path: str
    latency_ms: float
    labels: list[str]


class SpanPredictionResponse(BaseModel):
    task: Literal["sbar", "unknown_fact"]
    model: str
    program_path: str
    latency_ms: float
    pred_spans: list[LabelQuote]
