from __future__ import annotations

import os
from typing import Mapping


# Deliberately exclude application/cloud credentials. These are the small set of
# process settings needed to find executables, local model caches, and GPU
# runtimes on the supported Apple Silicon and NVIDIA hosts.
MODEL_ENVIRONMENT_NAMES = frozenset(
    {
        "PATH",
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "VIRTUAL_ENV",
        "HF_HOME",
        "HF_HUB_CACHE",
        "HUGGINGFACE_HUB_CACHE",
        "TRANSFORMERS_CACHE",
        "MLX_METAL_CACHE_DIR",
        "CUDA_HOME",
        "CUDA_VISIBLE_DEVICES",
        "CUDA_MODULE_LOADING",
        "NVIDIA_VISIBLE_DEVICES",
        "NVIDIA_DRIVER_CAPABILITIES",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
        "OMP_NUM_THREADS",
        "TOKENIZERS_PARALLELISM",
        "PYTORCH_CUDA_ALLOC_CONF",
        "TORCH_CUDA_ARCH_LIST",
        "NCCL_P2P_DISABLE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "SYSTEMROOT",
        "WINDIR",
        "PATHEXT",
    }
)


def allowlisted_environment(
    source: Mapping[str, str], *, include_service_settings: bool
) -> dict[str, str]:
    environment = {
        name: value
        for name, value in source.items()
        if name in MODEL_ENVIRONMENT_NAMES
        or (include_service_settings and name.startswith("LOCAL_PRIVACY_"))
    }
    return environment


def model_subprocess_environment(*, offline: bool) -> dict[str, str]:
    environment = allowlisted_environment(
        os.environ, include_service_settings=False
    )
    if offline:
        environment.update(
            {
                "OPENMED_OFFLINE": "1",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "HF_HUB_DISABLE_TELEMETRY": "1",
                "DO_NOT_TRACK": "1",
            }
        )
    return environment


def sanitize_service_environment() -> None:
    """Drop inherited application secrets before the ASGI/model runtime starts."""

    environment = allowlisted_environment(
        os.environ, include_service_settings=True
    )
    os.environ.clear()
    os.environ.update(environment)


def sanitize_model_process_environment(*, offline: bool) -> None:
    """Ensure a spawned model worker cannot inspect the service token either."""

    environment = model_subprocess_environment(offline=offline)
    os.environ.clear()
    os.environ.update(environment)
