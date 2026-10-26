from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
import hashlib
import hmac
import re
import secrets
from types import MappingProxyType
from typing import Any

from local_privacy.config import (
    SUPERCLINICAL_LARGE_MLX_MODEL,
    SUPERCLINICAL_LARGE_MLX_REVISION,
    SUPERCLINICAL_LARGE_SOURCE_MODEL,
    SUPERCLINICAL_LARGE_SOURCE_REVISION,
)


# OpenMed 2.2 preserves these model labels on spans but canonicalizes them to
# OTHER. Keep the application distinctions explicit while leaving OTHER masked.
ALLOWED_SOURCE_LABELS: Mapping[str, str] = MappingProxyType(
    {
        "blood_type": "BLOOD_TYPE",
        "company_name": "COMPANY_NAME",
        "date_time": "DATE_TIME",
        "education_level": "EDUCATION_LEVEL",
        "employment_status": "EMPLOYMENT_STATUS",
        "language": "LANGUAGE",
        "political_view": "POLITICAL_VIEW",
        "race_ethnicity": "RACE_ETHNICITY",
        "religious_belief": "RELIGIOUS_BELIEF",
        "sexuality": "SEXUALITY",
    }
)
SOURCE_LABEL_POLICY = "exact_model_source_labels_v1"
MAX_ALLOWED_SOURCE_SPANS = 4_096
MAX_EXACT_DENY_MATCHES = 100_000
REVIEWED_SOURCE_LABEL_MODELS = MappingProxyType(
    {
        SUPERCLINICAL_LARGE_MLX_MODEL: (
            "mlx",
            SUPERCLINICAL_LARGE_MLX_REVISION,
        ),
        SUPERCLINICAL_LARGE_SOURCE_MODEL: (
            "torch",
            SUPERCLINICAL_LARGE_SOURCE_REVISION,
        ),
    }
)
_DATE_TIME_SWEEP_LABELS = frozenset({"DATE", "TIME"})
_SAFETY_SWEEP_SOURCE = "safety_sweep"
_DOB_MARKER_PATTERN = (
    r"(?:\bdate\s+of\s+birth\b|\bbirth\s*date\b|\bbirth\s*day\b|"
    r"\bbirthday\b|\bbirthdate\b|"
    r"\bd\.?\s*o\.?\s*b(?:\.|\b)|\bborn\b)"
)
_DOB_MARKER = re.compile(_DOB_MARKER_PATTERN, flags=re.IGNORECASE)
_DOB_PREFIX = re.compile(
    _DOB_MARKER_PATTERN
    + r"(?:\s+(?:is|was|on|in|the))*[\s:;=\-–—,]*$",
    flags=re.IGNORECASE,
)
_DOB_SUFFIX = re.compile(
    r"^[\s:;=\-–—,()\[\]]*"
    r"(?:(?:is|was)\s+)?(?:(?:the|his|her|their|patient(?:'s)?)\s+)?"
    + _DOB_MARKER_PATTERN,
    flags=re.IGNORECASE,
)
_PARENTHESIZED_DOB_AFTER_STOP = re.compile(
    r"^\s*\.\s*\(\s*" + _DOB_MARKER_PATTERN,
    flags=re.IGNORECASE,
)


@dataclass(frozen=True)
class AllowedSourceSpan:
    """One offset-scoped application allow decision without source text."""

    start: int
    end: int
    source_label: str
    application_label: str


def supports_source_label_policy(
    model_name: str,
    *,
    backend: str | None = None,
    model_revision: str | None = None,
) -> bool:
    """Allow source labels only for the exact reviewed artifact revision."""

    reviewed = REVIEWED_SOURCE_LABEL_MODELS.get(model_name)
    return (
        reviewed is not None
        and backend == reviewed[0]
        and model_revision == reviewed[1]
    )


class _ExactDenyMatcher:
    """Request-local Aho-Corasick matcher for bounded exact deny terms."""

    def __init__(
        self,
        deny_terms: Sequence[Mapping[str, str]],
        custom_match_type: type,
    ) -> None:
        self._custom_match_type = custom_match_type
        self._transitions: list[dict[str, int]] = [{}]
        self._failures: list[int] = [0]
        self._outputs: list[list[tuple[int, str, str]]] = [[]]
        seen: dict[str, str] = {}
        for index, item in enumerate(deny_terms):
            term = item["term"]
            label = item["label"]
            prior_label = seen.get(term)
            if prior_label is not None:
                if prior_label != label:
                    raise ValueError("one deny term cannot have conflicting labels")
                continue
            seen[term] = label
            state = 0
            for character in term:
                next_state = self._transitions[state].get(character)
                if next_state is None:
                    next_state = len(self._transitions)
                    self._transitions[state][character] = next_state
                    self._transitions.append({})
                    self._failures.append(0)
                    self._outputs.append([])
                state = next_state
            self._outputs[state].append((len(term), label, f"deny:{index}"))
        self._term_count = len(seen)
        queue = deque(self._transitions[0].values())
        while queue:
            state = queue.popleft()
            for character, next_state in self._transitions[state].items():
                queue.append(next_state)
                failure = self._failures[state]
                while failure and character not in self._transitions[failure]:
                    failure = self._failures[failure]
                self._failures[next_state] = self._transitions[failure].get(
                    character,
                    0,
                )
                self._outputs[next_state].extend(
                    self._outputs[self._failures[next_state]]
                )

    @property
    def has_terms(self) -> bool:
        return self._term_count > 0

    def matches(self, text: str) -> tuple[Any, ...]:
        matches: list[Any] = []
        state = 0
        for end, character in enumerate(text, start=1):
            while state and character not in self._transitions[state]:
                state = self._failures[state]
            state = self._transitions[state].get(character, 0)
            for length, label, rule_id in self._outputs[state]:
                matches.append(
                    self._custom_match_type(
                        start=end - length,
                        end=end,
                        label=label,
                        kind="deny_term",
                        rule_id=rule_id,
                    )
                )
                if len(matches) > MAX_EXACT_DENY_MATCHES:
                    raise ValueError("too many exact deny matches")
        return tuple(matches)


def create_source_label_recognizer_type(
    custom_recognizer_type: type,
    custom_match_type: type,
    normalize_label: Callable[..., str],
) -> type:
    """Build the request-local OpenMed recognizer bridge lazily.

    Importing this module never imports OpenMed. The service creates this class
    inside its isolated model worker after loading the pinned OpenMed runtime.
    """

    class SourceLabelContextRecognizer(custom_recognizer_type):
        def __init__(
            self,
            *,
            deny_terms: Sequence[Mapping[str, str]] = (),
            allow_source_labels: bool = False,
        ) -> None:
            super().__init__(case_sensitive=True)
            self._deny_matcher = _ExactDenyMatcher(
                deny_terms,
                custom_match_type,
            )
            self._allow_source_labels = allow_source_labels
            self._fingerprint_key = secrets.token_bytes(32)
            self._text_fingerprint: bytes | None = None
            self._allowed_source_spans: tuple[AllowedSourceSpan, ...] = ()

        @property
        def has_allow_rules(self) -> bool:
            # OpenMed only calls suppress_spans when this property is true. The
            # actual intervals are learned from model spans later in the call.
            return self._allow_source_labels

        @property
        def has_deny_rules(self) -> bool:
            return self._deny_matcher.has_terms

        @property
        def allowed_source_spans(self) -> tuple[AllowedSourceSpan, ...]:
            return self._allowed_source_spans

        def deny_matches(self, text: str):
            return self._deny_matcher.matches(text)

        def allow_matches(self, text: str):
            if self._text_fingerprint != self._fingerprint(text):
                return ()
            return tuple(
                custom_match_type(
                    start=span.start,
                    end=span.end,
                    label=span.application_label,
                    kind="source_label_allow",
                    rule_id=f"source:{span.source_label}",
                )
                for span in self._allowed_source_spans
            )

        def capture_model_result(self, text: str, result: Any):
            """Remove pure allowed model entities before OpenMed arbitration.

            This happens after the single model inference and before canonical
            OTHER spans are deduplicated. It prevents an allowed and protected
            raw label at identical offsets from collapsing into an unsafe allow.
            """

            self._text_fingerprint = self._fingerprint(text)
            self._allowed_source_spans = ()
            if getattr(result, "text", None) != text:
                raise ValueError("source-label model output text mismatch")
            raw_entities = getattr(result, "entities", None)
            if (
                not isinstance(raw_entities, Sequence)
                or isinstance(raw_entities, (str, bytes, bytearray))
            ):
                raise TypeError("source-label model output entities are invalid")
            entities = list(raw_entities)
            if any(not _valid_bounds(entity, len(text)) for entity in entities):
                raise ValueError("source-label model output offsets are invalid")
            if not self._allow_source_labels:
                return result

            deny_intervals = tuple(
                (match.start, match.end)
                for match in self._deny_matcher.matches(text)
            )
            candidate_indexes = [
                index
                for index, entity in enumerate(entities)
                if self._eligible_model_source_entity(entity)
            ]
            if len(candidate_indexes) > MAX_ALLOWED_SOURCE_SPANS:
                return result

            allowed: list[AllowedSourceSpan] = []
            for index in candidate_indexes:
                candidate = entities[index]
                start, end = candidate.start, candidate.end
                if candidate.label == "date_time" and _has_dob_context(text, start, end):
                    # Keep the model span inside OpenMed arbitration, but make
                    # the protected birth-date meaning explicit so an allowed
                    # date_time label cannot suppress the mandatory sweep.
                    candidate.label = "date_of_birth"
                    candidate.metadata = {
                        **dict(getattr(candidate, "metadata", None) or {}),
                        "application_source_label": "date_time",
                        "application_protected_context": "date_of_birth",
                    }
                    continue
                if any(_overlaps(start, end, *interval) for interval in deny_intervals):
                    continue
                if any(
                    other_index != index
                    and _overlaps(start, end, other.start, other.end)
                    for other_index, other in enumerate(entities)
                ):
                    continue
                source_label = candidate.label
                allowed.append(
                    AllowedSourceSpan(
                        start=start,
                        end=end,
                        source_label=source_label,
                        application_label=ALLOWED_SOURCE_LABELS[source_label],
                    )
                )

            filtered_indexes = {
                index
                for index in candidate_indexes
                if any(
                    span.start == entities[index].start
                    and span.end == entities[index].end
                    and span.source_label == entities[index].label
                    for span in allowed
                )
            }
            retained = [
                entity
                for index, entity in enumerate(entities)
                if index not in filtered_indexes
            ]
            result.entities = retained
            if hasattr(result, "num_entities"):
                result.num_entities = len(retained)
            metadata = dict(getattr(result, "metadata", None) or {})
            metadata["application_source_label_policy"] = {
                "name": SOURCE_LABEL_POLICY,
                "allowed_spans": len(allowed),
            }
            result.metadata = metadata
            self._allowed_source_spans = tuple(allowed)
            return result

        def suppress_spans(self, text: str, spans: Sequence[Any]):
            span_list = list(spans)
            if self._text_fingerprint != self._fingerprint(text):
                return tuple(span_list), 0
            suppressed_indexes: set[int] = set()
            for index, span in enumerate(span_list):
                if not _valid_bounds(span, len(text)):
                    continue
                if any(
                    self._authorized_date_time_rule_overlap(text, allowed, span)
                    for allowed in self._allowed_source_spans
                ):
                    suppressed_indexes.add(index)
            retained = tuple(
                span
                for index, span in enumerate(span_list)
                if index not in suppressed_indexes
            )
            return retained, len(span_list) - len(retained)

        def suppress_entities(self, text: str, entities: Sequence[Any]):
            entity_list = list(entities)
            if self._text_fingerprint != self._fingerprint(text):
                return entity_list, 0

            suppressed_indexes: set[int] = set()
            retained_allowed: list[AllowedSourceSpan] = []
            for allowed in self._allowed_source_spans:
                overlapping = [
                    (index, entity)
                    for index, entity in enumerate(entity_list)
                    if _valid_bounds(entity, len(text))
                    and _overlaps(
                        allowed.start,
                        allowed.end,
                        entity.start,
                        entity.end,
                    )
                ]
                authorized_indexes: set[int] = set()
                rejected = False
                for index, entity in overlapping:
                    if not self._authorized_sweep_entity(text, allowed, entity):
                        rejected = True
                        break
                    authorized_indexes.add(index)
                if rejected:
                    continue
                retained_allowed.append(allowed)
                suppressed_indexes.update(authorized_indexes)

            self._allowed_source_spans = tuple(retained_allowed)
            retained = [
                entity
                for index, entity in enumerate(entity_list)
                if index not in suppressed_indexes
            ]
            return retained, len(entity_list) - len(retained)

        @staticmethod
        def _eligible_model_source_entity(entity: Any) -> bool:
            source_label = getattr(entity, "label", None)
            if type(source_label) is not str or source_label not in ALLOWED_SOURCE_LABELS:
                return False
            metadata = getattr(entity, "metadata", None) or {}
            if not isinstance(metadata, Mapping):
                return False
            semantic_merge = metadata.get("semantic_merge")
            if semantic_merge is None:
                return True
            if not isinstance(semantic_merge, Mapping):
                return False
            if bool(semantic_merge.get("mixed_label_union", False)):
                return False
            source_labels = semantic_merge.get("source_labels")
            if (
                not isinstance(source_labels, Sequence)
                or isinstance(source_labels, (str, bytes, bytearray))
                or not source_labels
            ):
                return False
            return all(type(label) is str and label == source_label for label in source_labels)

        @staticmethod
        def _authorized_date_time_rule_overlap(
            text: str,
            allowed: AllowedSourceSpan,
            span: Any,
        ) -> bool:
            if allowed.source_label != "date_time":
                return False
            detector = getattr(span, "detector", None)
            if not isinstance(detector, str) or not detector.startswith("rules:"):
                return False
            if getattr(span, "canonical_label", None) not in _DATE_TIME_SWEEP_LABELS:
                return False
            return (
                not _has_dob_context(text, allowed.start, allowed.end)
                and allowed.start <= span.start
                and span.end <= allowed.end
            )

        @staticmethod
        def _authorized_sweep_entity(
            text: str,
            allowed: AllowedSourceSpan,
            entity: Any,
        ) -> bool:
            if allowed.source_label != "date_time":
                return False
            metadata = getattr(entity, "metadata", None)
            if not isinstance(metadata, Mapping):
                return False
            if metadata.get("source") != _SAFETY_SWEEP_SOURCE:
                return False
            label = getattr(entity, "label", None)
            try:
                canonical = normalize_label(label)
            except Exception:
                return False
            if canonical not in _DATE_TIME_SWEEP_LABELS:
                return False
            return (
                not _has_dob_context(text, allowed.start, allowed.end)
                and allowed.start <= entity.start
                and entity.end <= allowed.end
            )

        def _fingerprint(self, text: str) -> bytes:
            return hmac.new(
                self._fingerprint_key,
                text.encode("utf-8", errors="strict"),
                hashlib.sha256,
            ).digest()

    SourceLabelContextRecognizer.__name__ = "SourceLabelContextRecognizer"
    return SourceLabelContextRecognizer


def _valid_bounds(value: Any, text_length: int) -> bool:
    start = getattr(value, "start", None)
    end = getattr(value, "end", None)
    return (
        type(start) is int
        and type(end) is int
        and 0 <= start < end <= text_length
    )


def _overlaps(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start < right_end and right_start < left_end


def _has_dob_context(text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 96) : start]
    candidate = text[start:end]
    after = text[end : min(len(text), end + 96)]
    return bool(
        _DOB_PREFIX.search(before)
        or _DOB_MARKER.search(candidate)
        or _DOB_SUFFIX.search(after)
        or _PARENTHESIZED_DOB_AFTER_STOP.search(after)
    )


__all__ = [
    "ALLOWED_SOURCE_LABELS",
    "AllowedSourceSpan",
    "SOURCE_LABEL_POLICY",
    "create_source_label_recognizer_type",
    "supports_source_label_policy",
]
