import os

class BaseConfig:
    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "change-me")
    # MySQL
    DB_HOST = os.getenv("DB_HOST", "localhost")
    DB_USER = os.getenv("DB_USER", "root")
    DB_PASSWORD = os.getenv("DB_PASSWORD", "")
    DB_NAME = os.getenv("DB_NAME", "rta_db")
    # Flask
    TEMPLATES_AUTO_RELOAD = False

class DevConfig(BaseConfig):
    DEBUG = True

class ProdConfig(BaseConfig):
    DEBUG = False
