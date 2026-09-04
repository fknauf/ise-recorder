""" Authentication facilities that are not backend-specific """

from datetime import datetime, timezone, timedelta
from functools import lru_cache
import logging
from typing import Annotated, Optional

from fastapi import Depends, status, HTTPException
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
import jwt
from jwt.exceptions import InvalidTokenError

from .auth_base import User, UserDatabase
from .auth_sql import SqlUserDatabase
from .auth_yolo import yolo_user, yolo_user_db
from .settings import AuthBackend, Settings, get_settings

logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token", auto_error=False)

@lru_cache
def get_user_db(
        settings: Annotated[Settings, Depends(get_settings)]
) -> UserDatabase:
    """
    Get the user-database matching the configured auth backend

    :param settings server configuration
    """

    match settings.auth_backend:
        case AuthBackend.SQL:
            if settings.auth_sql_url is None:
                raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR)
            return SqlUserDatabase(settings.auth_sql_url)
        case AuthBackend.LDAP:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR)
        case AuthBackend.YOLO:
            return yolo_user_db

    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR)

def decode_access_token(token: str, jwt_secret: Optional[str]) -> Optional[User]:
    try:
        payload = jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS384"],
            leeway=timedelta(seconds=30)
        )

        username = payload.get("sub")
        expiry = payload.get("exp", 0)

        if not isinstance(username, str) or expiry < datetime.now(timezone.utc).timestamp():
            return None

        return User(username=username)
    except InvalidTokenError:
        return None

def get_current_user(
        token: Annotated[str, Depends(oauth2_scheme)],
        settings: Annotated[Settings, Depends(get_settings)],
) -> User:
    """
    Gets the current user, or throws in case of auth failure

    :param token the sent JWT
    :param settings server settings
    """

    if settings.auth_backend == AuthBackend.YOLO:
        return yolo_user

    user = decode_access_token(token, settings.auth_jwt_secret)

    if user is None:
        raise HTTPException(
           status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return user

class SignedToken(BaseModel):
    access_token: str
    token_type: str
    expires_in: int
    refresh_token: str

def sign_access_token(
        user: User,
        settings: Settings
) -> SignedToken:
    """
    Sign an access token 

    :param user user, presumed to be authenticated
    :param settings server settings
    """
    now = datetime.now(timezone.utc)

    access_token = jwt.encode(
        {
            "sub": user.username,
            "typ": "access",
            "iat": now,
            "exp": now + timedelta(hours=1)
        },
        settings.auth_jwt_secret,
        "HS384"
    )

    refresh_token = jwt.encode(
        {
            "sub": user.username,
            "typ": "refresh",
            "iat": now,
            "exp": now + timedelta(hours=24)
        },
        settings.auth_jwt_secret,
        "HS384"
    )

    return SignedToken(
        access_token=access_token,
        token_type="bearer",
        expires_in=timedelta(hours=18).seconds,
        refresh_token=refresh_token
    )
