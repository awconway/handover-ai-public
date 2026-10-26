"""Production ASGI application, kept separate from the injectable app factory."""

from local_privacy.app import create_app


app = create_app()
