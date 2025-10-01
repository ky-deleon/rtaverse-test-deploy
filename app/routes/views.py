from flask import Blueprint, render_template, session, redirect, url_for
from .auth import is_logged_in
from ..extensions import get_engine
from ..services.preprocessing import make_display_copy
from ..services.database import list_tables
from ..extensions import get_db_connection
from markupsafe import Markup
from flask import request
import pandas as pd

views_bp = Blueprint("views", __name__)

@views_bp.route("/graphs")
def graphs():
    if not is_logged_in():
        return redirect(url_for("auth.login"))
    return render_template("graphs.html")

@views_bp.route("/database")
def database_page():
    if not is_logged_in():
        return redirect(url_for("auth.login"))
    
    all_tables = list_tables()
    EXCLUDE_PREFIXES = {"sys_","mysql_","tmp_","app_"}
    EXCLUDE_EXACT = {"app_settings","schema_migrations"}
    available_tables = sorted([t for t in all_tables if t not in EXCLUDE_EXACT and not any(t.startswith(p) for p in EXCLUDE_PREFIXES)])
    
    table = (request.args.get("table") or "").strip()
    if not table or table not in all_tables:
        return render_template("database.html", table_data=None, available_tables=available_tables)
    engine = get_engine()
    df = pd.read_sql_query(f"SELECT * FROM `{table}`", engine)
    if df.empty:
        empty_html = pd.DataFrame({"Info":[f'No rows in "{table}".']}).to_html(classes="data-table", table_id="uploadedTable", index=False)
        return render_template("database.html", table_data=Markup(empty_html), available_tables=available_tables)
    
    display_df = make_display_copy(df)
    hide_cols = ["MONTH_SIN","MONTH_COS","DAYOWEEK_SIN","DAYOWEEK_COS","GENDER_Female","GENDER_Male","GENDER_Unknown","ALCOHOL_USED_No","ALCOHOL_USED_Yes","ALCOHOL_USED_Unknown","TIME_CLUSTER_Midday","TIME_CLUSTER_Midnight","TIME_CLUSTER_Morning", "TIME_CLUSTER_Evening","TIME"]
    display_df = display_df.drop(columns=[c for c in hide_cols if c in display_df.columns])
    preferred_front = [c for c in ["MONTH","DAY_OF_WEEK","TIME","TIME_CLUSTER"] if c in display_df.columns]
    other_cols = [c for c in display_df.columns if c not in preferred_front]
    display_df = display_df[preferred_front + other_cols]
    table_html = display_df.to_html(classes="data-table", table_id="uploadedTable", index=False, border=0)
    return render_template("database.html", table_data=Markup(table_html), available_tables=available_tables)
