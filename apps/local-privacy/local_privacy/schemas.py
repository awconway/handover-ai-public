from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


MAX_PII_LABEL_CHARS = 200
PIILabel = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_PII_LABEL_CHARS),
]
PIIAction = Annotated[str, StringConstraints(min_length=1, max_length=100)]
PIISource = Annotated[str, StringConstraints(min_length=1, max_length=200)]
ModelIdentifier = Annotated[
    str,
    StringConstraints(min_length=1, max_length=2_048),
]
OpenMedVersion = Annotated[
    str,
    StringConstraints(min_length=1, max_length=100),
]
MAX_DENY_TERMS = 10_000
MAX_DENY_TERM_CHARS = 512
MAX_DENY_TERM_TOTAL_CHARS = 2_000_000
DenyTerm = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_DENY_TERM_CHARS),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        allow_inf_nan=False,
        strict=True,
    )


class LiveResponse(StrictModel):
    status: Literal["ok"] = "ok"


class ReadyResponse(StrictModel):
    status: Literal["ready", "not_ready"]


class TranscriptionResponse(StrictModel):
    text: str
    language: Literal["en"]
    duration_ms: int
    model: str
    backend: Literal["mlx", "nemo", "cpp"]
    transcription_elapsed_ms: int = Field(ge=0)


class DenyTermRequest(StrictModel):
    term: DenyTerm
    label: PIILabel


class DeidentificationRequest(StrictModel):
    text: str
    deny_terms: list[DenyTermRequest] = Field(
        default_factory=list,
        max_length=MAX_DENY_TERMS,
    )

    @model_validator(mode="after")
    def validate_deny_term_budget(self) -> DeidentificationRequest:
        if sum(len(item.term) for item in self.deny_terms) > MAX_DENY_TERM_TOTAL_CHARS:
            raise ValueError("deny terms exceed the aggregate character budget")
        return self


class PIIFindingResponse(StrictModel):
    original_text: str
    label: PIILabel
    entity_type: PIILabel
    canonical_label: PIILabel | None = None
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    replacement_text: str
    action: PIIAction | None = None
    sources: list[PIISource] = Field(max_length=16)
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_span(self) -> PIIFindingResponse:
        if self.end <= self.start:
            raise ValueError("PII finding end must be after start")
        return self


class DeidentificationResponse(StrictModel):
    text: str
    token: str
    pii_findings: list[PIIFindingResponse]
    replacement_count: int = Field(ge=0)
    model: ModelIdentifier
    openmed_version: OpenMedVersion
    method: Literal["replace"]
    policy: Literal["handover_context_v2"]
    offline: bool
    smart_merging: Literal[True]
    safety_sweep: Literal[True]
    backend: ModelIdentifier | None = None
    model_revision: ModelIdentifier | None = None

    @model_validator(mode="after")
    def validate_replacement_count(self) -> DeidentificationResponse:
        if self.replacement_count != len(self.pii_findings):
            raise ValueError("replacement_count must equal the PII finding count")
        return self


class ReidentificationRequest(StrictModel):
    token: str
    value: Any


class ReidentificationResponse(StrictModel):
    value: Any
