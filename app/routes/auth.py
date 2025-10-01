from flask import Blueprint, render_template, request, session, redirect, url_for

auth_bp = Blueprint("auth", __name__)

def is_logged_in():
    return "logged_in" in session and session["logged_in"]

@auth_bp.route("/")
def login():
    return render_template("login.html")

@auth_bp.route("/dashboard", methods=["GET", "POST"])
def dashboard():
    if request.method == "POST":
        username = request.form["username"]; password = request.form["password"]
        if username == "1" and password == "1":
            session["logged_in"] = True; session["username"] = username
        else:
            return "<h3>Login failed. <a href='/'>Try again</a></h3>"
    if not is_logged_in():
        return redirect(url_for("auth.login"))
    import datetime as dt
    now = dt.datetime.now()
    current_date = now.strftime("%B %d, %Y")
    current_time = now.strftime("%I:%M %p").lower()
    forecast_table = session.get("forecast_table", "accidents")
    # do a light table check
    from ..services.database import list_tables
    no_data = True
    if forecast_table in list_tables():
        from ..extensions import get_db_connection
        try:
            conn = get_db_connection(); cur = conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM `{forecast_table}`")
            row_count = cur.fetchone()[0]; no_data = (row_count == 0)
        except Exception:
            no_data = True
        finally:
            try: cur.close(); conn.close()
            except Exception: pass
    no_data_html = None if not no_data else render_no_data("No accident data available. Upload a file to get started.")
    return render_template("index.html", forecast_source=forecast_table, current_date=current_date, current_time=current_time, no_data_html=no_data_html)

@auth_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))

def render_no_data(msg="No data available"):
    return f"""
    <div class="no-data">
      <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" fill="#0437F2" viewBox="0 0 24 24">
        <path d="M12 2C6.486 2 2 6.49 2 12c0 5.51 4.486 10 10 10 s10-4.49 10-10C22 6.49 17.514 2 12 2zm0 15h-1v-6h2v6h-1zm0-8 c-.552 0-1-.447-1-1s.448-1 1-1c.553 0 1 .447 1 1s-.447 1-1 1z"/>
      </svg>
      <p>{msg}</p>
    </div>
    """
