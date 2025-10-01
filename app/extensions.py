# app/extensions.py
from flask import current_app
import mysql.connector
from sqlalchemy import create_engine

def _cfg(key: str, default):
    return current_app.config.get(key, default)

def get_db_connection():
    """Plain mysql-connector connection for cursor/execute use."""
    return mysql.connector.connect(
        host=_cfg("DB_HOST", "localhost"),
        user=_cfg("DB_USER", "root"),
        password=_cfg("DB_PASSWORD", ""),
        database=_cfg("DB_NAME", "rta_db"),
    )

def get_engine():
    """SQLAlchemy engine for pandas.read_sql_query(...)."""
    user = _cfg("DB_USER", "root")
    pwd  = _cfg("DB_PASSWORD", "")
    host = _cfg("DB_HOST", "localhost")
    db   = _cfg("DB_NAME", "rta_db")
    uri = f"mysql+mysqlconnector://{user}:{pwd}@{host}/{db}"
    # pool_pre_ping avoids stale conns; pool_recycle helps on PythonAnywhere
    return create_engine(uri, pool_pre_ping=True, pool_recycle=280)
