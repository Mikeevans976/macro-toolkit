import json
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from runtime_paths import BACKEND_DIR, state_path

logger = logging.getLogger(__name__)

# Secret key — set SECRET_KEY in any shared/deployed environment. Without it a
# random per-process key is used: safe (nothing forgeable is baked into the
# code) but every restart logs everyone out, and it must not be used with
# multiple worker processes.
SECRET_KEY = os.environ.get("SECRET_KEY") or ""
if not SECRET_KEY:
    SECRET_KEY = secrets.token_urlsafe(48)
    logger.warning("SECRET_KEY is not set; using a random per-process key "
                   "(tokens are invalidated on restart). Set SECRET_KEY in production.")
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
