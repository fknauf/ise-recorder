""" Admin-configurable server settings """

from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Optional

from pydantic import EmailStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AuthBackend(str, Enum):
    """ Authentication backend mechanism. YOLO means no authentication. """
    YOLO = "yolo"
    SQL = "sql"
    LDAP = "ldap"

class Settings(BaseSettings):
    """
        Configuration settings for the server. Options can be set through ISE_RECORD_VARNAME
        environment variables at server startup.
    """
    destdir: Path = Path("./data")

    smtp_server: Optional[str] = None
    smtp_port: Annotated[int, Field(ge=0, lt=65536)] = 0
    smtp_local_hostname: Optional[str] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_sender: Optional[EmailStr] = None
    smtp_starttls: bool = False
    smtp_allowed_domains: tuple[str, ...] = ()

    chunk_file_digits: int = 4

    cors_origins: tuple[str, ...] = ()

    auth_jwt_secret: Optional[str] = None
    auth_backend: AuthBackend = AuthBackend.YOLO
    auth_sql_url: Optional[str] = None

    model_config = SettingsConfigDict(env_prefix="ise_record_", frozen=True)


@lru_cache
def get_settings() -> Settings:
    """ Cached settings loader """
    return Settings()
