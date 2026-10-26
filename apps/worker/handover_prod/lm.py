import dspy

from handover_prod.config import Settings


def build_lm(settings: Settings) -> dspy.LM:
    kwargs = {
        "model": settings.model,
        "timeout": settings.request_timeout_seconds,
    }
    if settings.reasoning_effort is not None:
        kwargs["model_type"] = "responses"
        kwargs["reasoning"] = {"effort": settings.reasoning_effort}
    return dspy.LM(**kwargs)


def configure_dspy(settings: Settings) -> None:
    dspy.configure_cache(
        enable_disk_cache=False,
        enable_memory_cache=False,
    )
    dspy.settings.configure(lm=build_lm(settings))
