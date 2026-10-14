import json
import logging
import os
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from runtime_paths import BACKEND_DIR, state_path
from settings import settings

logger = logging.getLogger(__name__)


def _resolve_secret_key() -> str:
    """SECRET_KEY from settings (required in prod, enforced there). In dev
    without one, a generated key is kept in var/dev_secret_key so restarts
    and --reload don't log everyone out; nothing forgeable is in the code."""
    if settings.secret_key:
        return settings.secret_key
    path = state_path("dev_secret_key")
    try:
        key = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        key = ""
    if len(key) < 32:
        key = secrets.token_urlsafe(48)
        try:
            path.write_text(key, encoding="utf-8")
            os.chmod(path, 0o600)
            logger.warning("SECRET_KEY is not set; generated a development key in %s. "
                           "Set SECRET_KEY (and MACROKIT_ENV=prod) for any shared deployment.", path)
        except OSError:
            logger.warning("SECRET_KEY is not set and %s is not writable; using a per-process key "
                           "(restarts log everyone out).", path)
    return key


SECRET_KEY = _resolve_secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8

USERS_FILE = str(state_path("users.json", legacy=BACKEND_DIR / "users.json"))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def bootstrap_admin() -> None:
    """
    On first deploy, create an admin user from env vars if users.json doesn't exist.
    Set ADMIN_USERNAME, ADMIN_PASSWORD, and optionally ADMIN_NAME before starting.
    No-op if users.json already exists or env vars are unset.
    """
    if os.path.exists(USERS_FILE):
        return
    username = os.environ.get("ADMIN_USERNAME", "").strip()
    password = os.environ.get("ADMIN_PASSWORD", "").strip()
    if not username or not password:
        return
    full_name = os.environ.get("ADMIN_NAME", username).strip()
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    with open(USERS_FILE, "w") as f:
        json.dump({username: {"username": username, "full_name": full_name, "hashed_password": hashed}}, f)


# users.json is re-read only when its mtime changes, so create_user.py edits
# still take effect without a restart.
_users_cache: tuple[float, dict] | None = None


def load_users() -> dict:
    global _users_cache
    try:
        mtime = os.path.getmtime(USERS_FILE)
    except FileNotFoundError:
        _users_cache = None
        return {}
    if _users_cache is None or _users_cache[0] != mtime:
        with open(USERS_FILE, "r") as f:
            _users_cache = (mtime, json.load(f))
    return _users_cache[1]


def get_user(username: str) -> Optional[dict]:
    users = load_users()
    return users.get(username)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())


def authenticate_user(username: str, password: str) -> Optional[dict]:
    user = get_user(username)
    if not user:
        return None
    if not verify_password(password, user["hashed_password"]):
        return None
    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> str:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        raise credentials_exception
    username = payload.get("sub")
    # Scoped tokens (e.g. stream tickets) are not session tokens.
    if not isinstance(username, str) or payload.get("scope") is not None:
        raise credentials_exception
    return username


# Short-lived, run-scoped ticket for the agent SSE stream. EventSource cannot
# send an Authorization header, so the ticket goes in the query string instead
# of the 8-hour session token (which would end up in access logs / history).
STREAM_TICKET_SECONDS = 60


def create_stream_ticket(username: str, run_id: str) -> str:
    return create_access_token({"sub": username, "scope": "stream", "run": run_id},
                               expires_delta=timedelta(seconds=STREAM_TICKET_SECONDS))


def verify_stream_ticket(ticket: str, run_id: str) -> str:
    """Username for a valid ticket issued for ``run_id``; 401 otherwise."""
    try:
        payload = jwt.decode(ticket, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        payload = {}
    username = payload.get("sub")
    if payload.get("scope") != "stream" or payload.get("run") != run_id or not isinstance(username, str):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired stream ticket")
    return username


def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    username = verify_token(token)
    user = get_user(username)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


class LoginRateLimiter:
    """
    Failed-login limiter: after ``max_failures`` failures for a key (client IP
    or username) within ``window_seconds``, further attempts for that key get
    429 until the oldest failure leaves the window. Successful logins are never
    limited and clear the username's failures. In-process only, which matches
    the single-process deployment; behind a reverse proxy the IP key is the
    proxy's, so the username key does the work.
    """

    def __init__(self, max_failures: int, window_seconds: int,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.max_failures = max_failures
        self.window = window_seconds
        self._clock = clock
        self._failures: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> deque[float]:
        q = self._failures.get(key)
        if q is None:
            return deque()
        while q and now - q[0] >= self.window:
            q.popleft()
        if not q:
            del self._failures[key]
        return q

    def retry_after(self, *keys: str) -> int:
        """Seconds until an attempt is allowed for all keys (0 = allowed now)."""
        now = self._clock()
        wait = 0.0
        with self._lock:
            for key in keys:
                q = self._prune(key, now)
                if len(q) >= self.max_failures:
                    wait = max(wait, self.window - (now - q[0]))
        return int(wait) + 1 if wait > 0 else 0

    def record_failure(self, *keys: str) -> None:
        now = self._clock()
        with self._lock:
            for key in keys:
                self._failures.setdefault(key, deque()).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


login_limiter = LoginRateLimiter(settings.login_max_failures, settings.login_window_seconds)
