from __future__ import annotations

import uvicorn

from local_privacy.config import Settings
from local_privacy.environment import sanitize_service_environment


def main() -> None:
    settings = Settings.from_env()
    # Defense in depth for direct/manual launches: retain only local-privacy and
    # model-runtime settings before Uvicorn imports the ASGI application.
    sanitize_service_environment()
    uvicorn.run(
        "local_privacy.asgi:app",
        host="127.0.0.1",
        port=settings.port,
        access_log=False,
        server_header=False,
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
