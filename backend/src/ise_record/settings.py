"""Admin-configurable server settings"""

from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator, ValidationInfo
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_PREFIX="ise_record_"


class AuthBackend(StrEnum):
    """ Types of authentication backends """
    DISABLED = "disabled"
    OIDC = "oidc"


class SmtpSettings(BaseModel):
    """SMTP settings for reporting"""

    server: str
    sender: EmailStr
    port: Annotated[int | None, Field(ge=0, lt=65536)] = None
    local_hostname: str | None = None
    username: str | None = None
    password: str | None = None
    starttls: bool | None = None
    use_tls: bool = False
    allowed_domains: tuple[str, ...] = ()

    @field_validator("use_tls")
    @classmethod
    def tls_modes_are_exclusive(cls, use_tls: bool, info: ValidationInfo) -> bool:
        """Validate that implicit TLS and STARTTLS aren't both enabled."""
        if use_tls and info.data.get("starttls"):
            raise ValueError("STARTTLS and implicit TLS are mutually exclusive.")
        return use_tls

    @field_validator("allowed_domains")
    @classmethod
    def lower_case_allowed_domains(cls, allowed_domains: tuple[str, ...]) -> tuple[str, ...]:
        """Force allowed domains to lower scale for case-insensitive comparison"""
        return tuple(d.casefold() for d in allowed_domains)


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
        env_ignore_empty=True,
        env_nested_delimiter="_",
        env_nested_max_split=1,
        env_prefix=_ENV_PREFIX,
        frozen=True
    )

    route_prefix: Annotated[str, Field(pattern=r"\A(/.*[^/])?\z")] = ""
    destdir: Path = Path("./data")
    chunk_file_digits: Annotated[int, Field(ge=3, lt=10)] = 4
    cors_origins: tuple[str, ...] = ()
    auth: AuthBackend = AuthBackend.OIDC

    oidc: OidcSettings | None = None
    smtp: SmtpSettings | None = None

    @model_validator(mode="after")
    def auth_backend_matches_settings(self) -> Settings:
        pfx = _ENV_PREFIX.upper()

        if self.auth == AuthBackend.OIDC and self.oidc is None:
            raise ValueError(
                "OpenID auth is enabled, but provider and audience are not set.\n"
                f"Configure {pfx}OIDC_PROVIDER_URL and {pfx}OIDC_AUDIENCE, or set "
                f"{pfx}AUTH=disabled to run without authentication."
            )
        if self.auth == AuthBackend.DISABLED and self.oidc is not None:
            raise ValueError(
                f"Authentication is disabled, but {pfx}OIDC_PROVIDER_URL and "
                f"{pfx}OIDC_AUDIENCE are set."
            )

        return self

    @property
    def auth_required(self) -> bool:
        """Whether clients must present an access token"""
        return self.auth != AuthBackend.DISABLED

@lru_cache
def get_settings() -> Settings:
    """Cached settings loader"""
    return Settings()
