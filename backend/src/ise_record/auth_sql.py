""" Authentication module for the SQL user-database backend """

import logging
from typing import Optional

from pwdlib import PasswordHash
from sqlmodel import Field, Session, SQLModel, create_engine

from .auth_base import User, UserDatabase

logger = logging.Logger(__name__)

class SqlUser(SQLModel, table=True):
    """ Describes a user's entry in the SQL database """
    username: str = Field(primary_key = True)
    password_hash: str

class SqlUserDatabase(UserDatabase):
    """ SQL-backed user database with facilities for user authentication and user management """

    def __init__(self, sql_url: str) -> None:
        logger.warning("opening db %s", sql_url)

        self._engine = create_engine(sql_url)
        self._pw_hash = PasswordHash.recommended()

    def authenticate(self, username: str, password: str) -> Optional[User]:
        with Session(self._engine) as session:
            sql_user = session.get(SqlUser, username)

            if sql_user is None or not self._pw_hash.verify(password, sql_user.password_hash):
                return None

            return User(username=username)

    def create_user(self, username: str, password: str) -> None:
        """
        Create a user

        :param username the new user's handle
        :param password password, will be stored as argon2 hash in the database
        """

        SQLModel.metadata.create_all(self._engine)

        with Session(self._engine) as session:
            pw_hash = self._pw_hash.hash(password)

            sql_user = session.get(SqlUser, username)

            if sql_user is not None:
                sql_user.password_hash = pw_hash
            else:
                sql_user = SqlUser(
                    username=username,
                    password_hash=pw_hash
                )

            session.add(sql_user)
            session.commit()

    def delete_user(self, username: str) -> None:
        """
        Delete a user
        
        :param username user to delete
        """

        with Session(self._engine) as session:
            sql_user = session.get(SqlUser, username)

            if sql_user is not None:
                session.delete(sql_user)
                session.commit()
