from .auth_base import User, UserDatabase

yolo_user = User("yolo", home_override=".")

class YoloUserDatabase(UserDatabase):
    def authenticate(self, username: str, password: str) -> User:
        return yolo_user

    def user_exists(self, username: str) -> bool:
        return username == yolo_user.username

yolo_user_db = YoloUserDatabase()
