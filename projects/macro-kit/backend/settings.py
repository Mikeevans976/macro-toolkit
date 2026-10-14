"""
App settings, read once from the environment.

Import this module before anything that reads os.environ: it loads the
project's .env files first (``projects/macro-kit/.env``, then ``backend/.env``)
without overriding variables that are already set, so every module (auth, the
pod, the data fetchers) sees the same configuration.

    MACROKIT_ENV           dev (default) | prod. In prod, SECRET_KEY is required.
    SECRET_KEY             JWT signing key. In dev, a generated key is kept in
                           var/dev_secret_key so restarts don't log everyone out.
    CORS_ORIGINS           comma-separated; defaults to the local Vite dev servers.
    ANALYTICS_DATA_SOURCE  csv (default) | simulation | bloomberg | haver
    HAVER_PATH             Haver DLX database path (haver source only)
    LOG_LEVEL, PORT, PRECOMPUTE_ON_STARTUP
    LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS   failed-login rate limit
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
ENV_FILES = (BACKEND_DIR.parent / ".env", BACKEND_DIR / ".env")

DATA_SOURCES = ("csv", "simulation", "bloomberg", "haver")
_DEFAULT_CORS = ("http://localhost:5173", "http://127.0.0.1:5173",
                 "http://localhost:5174", "http://127.0.0.1:5174")


class SettingsError(RuntimeError):
    """Invalid or missing configuration; raised at startup."""


def load_env_files(paths: tuple[Path, ...] = ENV_FILES) -> None:
    """KEY=VALUE lines into os.environ, never overriding what is already set."""
    for path in paths:
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip().removeprefix("export ").strip()
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def _int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise SettingsError(f"{name} must be an integer, got {raw!r}") from None
    if value < minimum:
        raise SettingsError(f"{name} must be >= {minimum}, got {value}")
    return value


@dataclass(frozen=True)
class Settings:
    env: str
    secret_key: str                 # "" = not configured (auth decides what to do)
    cors_origins: tuple[str, ...]
    data_source: str
    haver_path: str | None
    log_level: str
    port: int
    precompute_on_startup: bool
    login_max_failures: int
    login_window_seconds: int

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"


def from_env() -> Settings:
    env = os.environ.get("MACROKIT_ENV", "dev").strip().lower() or "dev"
    if env not in ("dev", "prod"):
        raise SettingsError(f"MACROKIT_ENV must be 'dev' or 'prod', got {env!r}")

    data_source = os.environ.get("ANALYTICS_DATA_SOURCE", "csv").strip().lower() or "csv"
    if data_source not in DATA_SOURCES:
        raise SettingsError(f"ANALYTICS_DATA_SOURCE must be one of {', '.join(DATA_SOURCES)}; got {data_source!r}")

    secret = os.environ.get("SECRET_KEY", "").strip()
    if env == "prod" and len(secret) < 32:
        raise SettingsError(
            "SECRET_KEY must be set (32+ characters) when MACROKIT_ENV=prod. Generate one with: "
            "python -c \"import secrets; print(secrets.token_urlsafe(48))\"")

    cors = tuple(o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()) or _DEFAULT_CORS

    return Settings(
        env=env,
        secret_key=secret,
        cors_origins=cors,
        data_source=data_source,
        haver_path=os.environ.get("HAVER_PATH") or None,
        log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO",
        port=_int("PORT", 8000, minimum=1),
        precompute_on_startup=os.environ.get("PRECOMPUTE_ON_STARTUP", "1").strip() != "0",
        login_max_failures=_int("LOGIN_MAX_FAILURES", 5, minimum=1),
        login_window_seconds=_int("LOGIN_WINDOW_SECONDS", 300, minimum=1),
    )


load_env_files()
settings = from_env()
