from typing import Literal

from typing_extensions import TypedDict

import dspy

LabelType = Literal["Unknown fact"]
UNKNOWN_FACT_LABELS = {"Unknown fact"}


class LabelQuote(TypedDict):
    label: LabelType
    quote: str


class LabelHandover(dspy.Signature):
    """
    Extract quotes from a clinical handover transcript that explicitly state
    that a fact is unknown.

    Unknown fact includes direct lack-of-knowledge statements such as:
    - "I don't know his allergies."
    - "Not sure if consent's been signed."

    Instructions
    - Extract each unknown-fact statement as a separate quote.
    - Label every extracted quote as "Unknown fact".
    - Do not extract hedging/vagueness unless the text explicitly states missing knowledge.
    - Do not combine text from different parts of the transcript.
    - Quotes must match the source text exactly (no paraphrasing or corrections).
    - If no unknown-fact statements are present, return an empty list.
    """

    text: str = dspy.InputField()
    pred_spans: list[LabelQuote] = dspy.OutputField()


def build_predictor():
    return dspy.Predict(LabelHandover)
