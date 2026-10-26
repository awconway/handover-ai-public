from __future__ import annotations

from dataclasses import dataclass
import math
import secrets
import threading
import time
from typing import Callable, Mapping


class VaultCapacityError(RuntimeError):
    pass


@dataclass(frozen=True)
class _Entry:
    mapping: dict[str, str]
    expires_at: float


class MappingVault:
    """Bounded, process-local, expiring, one-time mapping storage."""

    def __init__(
        self,
        *,
        ttl_seconds: float,
        max_entries: int,
        clock: Callable[[], float] = time.monotonic,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        if not math.isfinite(ttl_seconds) or ttl_seconds <= 0 or max_entries <= 0:
            raise ValueError("vault limits must be positive")
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))
        self._entries: dict[str, _Entry] = {}
        self._condition = threading.Condition(threading.Lock())
        self._closed = False
        self._reaper: threading.Thread | None = None

    def _purge_expired_locked(self, now: float) -> None:
        expired = [
            token for token, entry in self._entries.items() if entry.expires_at <= now
        ]
        for token in expired:
            del self._entries[token]

    def _ensure_reaper_locked(self) -> None:
        if self._reaper is not None:
            return
        self._reaper = threading.Thread(
            target=self._reap,
            name="local-privacy-mapping-reaper",
            daemon=True,
        )
        self._reaper.start()

    def _reap(self) -> None:
        with self._condition:
            while not self._closed:
                now = self._clock()
                self._purge_expired_locked(now)
                if not self._entries:
                    self._condition.wait()
                    continue
                next_expiry = min(entry.expires_at for entry in self._entries.values())
                self._condition.wait(timeout=max(0.0, next_expiry - now))

    def put(self, mapping: Mapping[str, str]) -> str:
        copied_mapping = dict(mapping)
        now = self._clock()
        with self._condition:
            if self._closed:
                raise VaultCapacityError("mapping vault is closed")
            self._purge_expired_locked(now)
            if len(self._entries) >= self._max_entries:
                raise VaultCapacityError("mapping vault is full")
            for _ in range(8):
                token = self._token_factory()
                if token and token not in self._entries:
                    self._entries[token] = _Entry(
                        mapping=copied_mapping,
                        expires_at=now + self._ttl_seconds,
                    )
                    self._ensure_reaper_locked()
                    self._condition.notify_all()
                    return token
        raise VaultCapacityError("could not allocate mapping token")

    def consume(self, token: str) -> dict[str, str] | None:
        now = self._clock()
        with self._condition:
            self._purge_expired_locked(now)
            entry = self._entries.pop(token, None)
            self._condition.notify_all()
        return dict(entry.mapping) if entry is not None else None

    def delete(self, token: str) -> bool:
        now = self._clock()
        with self._condition:
            self._purge_expired_locked(now)
            removed = self._entries.pop(token, None) is not None
            self._condition.notify_all()
            return removed

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
            self._entries.clear()
            reaper = self._reaper
            self._condition.notify_all()
        if reaper is not None and reaper is not threading.current_thread():
            reaper.join(timeout=1.0)

    def __len__(self) -> int:
        now = self._clock()
        with self._condition:
            self._purge_expired_locked(now)
            return len(self._entries)
