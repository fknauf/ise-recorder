""" Authentication backend interface classes, required by all backends """

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    """ An authenticated user """
    username: str
    relative_home_dir: str

    def __init__(self, username: str, home_override: Optional[str] = None) -> None:
        self.username = username
        self.relative_home_dir = home_override or username

yolo_user = User("yolo", home_override=".")

class UserDatabase(ABC):
    # pylint: disable=too-few-public-methods
    """ User database base class """

    @abstractmethod
    def authenticate(self, username: str, password: str) -> Optional[User]:
        """
        Authenticate a user. Returns None if not authenticated
        
        :param username user's name
        :param password user's password
        """
