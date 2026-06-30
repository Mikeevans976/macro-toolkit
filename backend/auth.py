import os
import json
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
import bcrypt

# Secret key — set SECRET_KEY env var in production
SECRET_KEY = os.environ.get(
    "SECRET_KEY",
    "dev-secret-key-change-in-production-a1b2c3d4e5f6g7h8i9j0"
)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8

USERS_FILE = os.path.join(os.path.dirname(__file__), "users.json")

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


def load_users() -> dict:
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, "r") as f:
        return json.load(f)


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
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_token(token: str) -> str:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        return username
    except JWTError:
        raise credentials_exception


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
