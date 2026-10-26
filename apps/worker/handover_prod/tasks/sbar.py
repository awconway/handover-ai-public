from typing import Literal

from typing_extensions import TypedDict

import dspy

LabelType = Literal["SITUATION", "BACKGROUND", "ASSESSMENT", "RECOMMENDATION"]
SBAR_LABELS = {
    "SITUATION",
    "BACKGROUND",
    "ASSESSMENT",
    "RECOMMENDATION",
}


class LabelQuote(TypedDict):
    label: LabelType
    quote: str


class LabelHandover(dspy.Signature):
    """
    The task is to extract quotes from the text of a clinical handover transcript that aligns with the SBAR framework (SITUATION, BACKGROUND, ASSESSMENT, RECOMMENDATION) and label them accordingly.

    Instructions
    - If the transcript contains multiple different pieces of information within the same SBAR category from different sections of the text, extract each as a separate quote.
    - **Do not combine parts from different sections of the text into a single quote.**
    - Extracted quotes must appear **exactly as written in the original transcript**, preserving spelling, capitalization, punctuation, and phrasing. Do not paraphrase. Do not summarize. Do not correct incorrectly spelled words. Do not correct errors. Do not rephrase.
    - Assign quotes to the correct SBAR label based on its content, regardless of its position in the transcript.
    - If parts of the text do not fit into any SBAR category, do not extract it.
    - Quotes should only be assigned to one of the SBAR labels.
    """

    text: str = dspy.InputField()
    pred_spans: list[LabelQuote] = dspy.OutputField()


def build_predictor():
    return dspy.Predict(LabelHandover)
