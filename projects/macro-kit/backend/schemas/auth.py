"""Response models for the auth routes."""
from pydantic import BaseModel


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class Me(BaseModel):
    username: str
    full_name: str
