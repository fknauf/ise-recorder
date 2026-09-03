""" Authentication facilities that are not backend-specific """

from datetime import datetime, timezone, timedelta
from functools import lru_cache
import logging
from typing import Annotated, Optional

from fastapi import Depends, status, HTTPException
from fastapi.security import OAuth2PasswordBearer
import jwt
from jwt.exceptions import InvalidTokenError

from .auth_base import User, UserDatabase, yolo_user
from .auth_sql import SqlUserDatabase
from .settings import AuthBackend, Settings, get_settings

logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token", auto_error=False)

@lru_cache
def get_user_db(
        settings: Annotated[Settings, Depends(get_settings)]
) -> Optional[UserDatabase]:
    """
    Get the user-database matching the configured auth backend

    :param settings server configuration
    """

    if settings.auth_backend == AuthBackend.SQL and settings.auth_sql_url is not None:
        return SqlUserDatabase(settings.auth_sql_url)

    return None

def create_access_token(
        username: str,
        password: str,
        settings: Settings,
        user_db: UserDatabase
) -> Optional[str]:
    """
    Create a JWT from user credentials. The authenticated endpoints expect this token in the
    request headers.

    :param username user to authenticate
    :param password the user's password
    :param settings server settings
    :param user_db the configured user database
    """

    user = user_db.authenticate(username, password)

    if user is None:
        return None

    return jwt.encode(
        {
            "username": user.username,
            "exp": datetime.now(timezone.utc) + timedelta(hours=18)
        },
        settings.auth_jwt_secret,
        "HS384"
    )

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

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, settings.auth_jwt_secret, algorithms=["HS384"])
        username = payload.get("username")
        expiry = payload.get("exp", 0)

        if not isinstance(username, str) or expiry < datetime.now(timezone.utc).timestamp():
            raise credentials_exception

        return User(username=username)
    except InvalidTokenError as exc:
        raise credentials_exception from exc
