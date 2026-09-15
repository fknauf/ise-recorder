""" Admin-configurable server settings """

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class SmtpSettings(BaseModel):
    """ SMTP settings for reporting """

    server: str
    sender: EmailStr
    port: Annotated[int | None, Field(ge=0, lt=65536)] = None
    local_hostname: str | None = None
    username: str | None = None
    password: str | None = None
    starttls: bool = False
    allowed_domains: tuple[str, ...] = ()


class OidcSettings(BaseModel):
    """
    OpenID Connect settings for authentication (if desired).
    """
    provider_url: str
    audience: str
    leeway_seconds: Annotated[float, Field(ge=0)] = 30.0
    http_timeout_seconds: Annotated[float, Field(gt=0)] = 5.0

class Settings(BaseSettings):
    """
        Configuration settings for the server. Options can be set through ISE_RECORD_VARNAME
        environment variables at server startup.
    """
    model_config = SettingsConfigDict(
        env_prefix="ise_record_",
        env_nested_delimiter="_",
        env_nested_max_split=1,
        frozen=True
    )

    route_prefix: str = "/api"
    destdir: Path = Path("./data")
    chunk_file_digits: Annotated[int, Field(ge=3, lt=10)] = 4
    cors_origins: tuple[str, ...] = ()

    oidc: OidcSettings | None = None
    smtp: SmtpSettings | None = None

    @property
    def auth_required(self) -> bool:
        """ Whether clients must present an access token """
        return self.oidc is not None

@lru_cache
def get_settings() -> Settings:
    """ Cached settings loader """
    return Settings()
