# from . import __all__  # silence linters
from ..extensions import get_db_connection

def list_tables() -> set[str]:
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SHOW TABLES")
    tables = {t[0] for t in cur.fetchall()}
    cur.close(); conn.close()
    return tables
