from flask import Blueprint, jsonify, request, session, Response, redirect, url_for
from .auth import is_logged_in
from ..services.database import list_tables
from ..services.preprocessing import process_merge_and_save_to_db
from ..services.forecasting import rf_monthly_payload, build_forecast_map_html
from ..extensions import get_db_connection

api_bp = Blueprint("api", __name__)

@api_bp.route("/gender_proportion", methods=["GET"])
def gender_proportion():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # --- Discover columns (avoid 1054 errors) ---
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {row[0] for row in cur.fetchall()}

        # Preferred categorical gender columns
        gender_cat_candidates = ["GENDER", "SEX", "VICTIM_GENDER", "SEX_OF_VICTIM"]
        gender_cat_col = next((c for c in gender_cat_candidates if c in cols), None)

        # Fallback: detect one-hot gender columns (GENDER_Male / SEX_Female / etc.)
        prefixes = ("GENDER_", "SEX_")
        present_onehots = {c for c in cols if c.startswith(prefixes)}
        onehot_male   = next((c for c in present_onehots if c.lower().endswith("male")),   None)
        onehot_female = next((c for c in present_onehots if c.lower().endswith("female")), None)
        onehot_other  = next((c for c in present_onehots if c.lower().endswith("other")),  None)
        onehot_unknown = next((c for c in present_onehots if c.lower().endswith("unknown")), None)

        # -------- Build WHERE filters (mirror other endpoints) --------
        q = request.args
        where = []
        params = []

        # Location (Barangay)
        location = (q.get("location") or "").strip()
        if location and "BARANGAY" in cols:
            where.append("BARANGAY = %s")
            params.append(location)

        # Gender filter (filters the base set, then we count proportions within the filtered set)
        gender_req = (q.get("gender") or "").strip().lower()
        if gender_req:
            if gender_cat_col:
                where.append(f"UPPER(TRIM(`{gender_cat_col}`)) = %s")
                params.append(gender_req.upper())
            else:
                # Try one-hot if available
                gh = {
                    "male": onehot_male,
                    "female": onehot_female,
                    "other": onehot_other
                }.get(gender_req)
                if gh:
                    where.append(f"COALESCE(`{gh}`,0) = 1")
                else:
                    # If we can't map the request to any column, do nothing (avoid 1054)
                    pass

        # Day of Week (accepts "1. Monday", "Monday", or "1")
        day_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        if day_raw:
            if "DATE_COMMITTED" in cols:
                weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"  # 0..6 (Mon..Sun)
            elif "WEEKDAY" in cols:
                weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
            else:
                weekday_expr = None

            if weekday_expr:
                name_to_int = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}
                wd_ints = []
                for item in day_raw:
                    tok = item.split(".", 1)[0].strip()  # "1. Monday" -> "1"
                    if tok.isdigit():
                        n = int(tok)
                        if 1 <= n <= 7:
                            wd_ints.append(n-1)
                    else:
                        wd = name_to_int.get(tok.upper(), None)
                        if wd is not None:
                            wd_ints.append(wd)
                if wd_ints:
                    placeholders = ",".join(["%s"] * len(wd_ints))
                    where.append(f"{weekday_expr} IN ({placeholders})")
                    params.extend(wd_ints)

        # Alcohol filters (support one-hot or categorical)
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]
        if alcohol_raw:
            # One-hot map (ALCOHOL_USED_Yes/No/Unknown) if present
            onehot_yes = "ALCOHOL_USED_Yes" in cols
            onehot_no  = "ALCOHOL_USED_No" in cols
            onehot_unk = "ALCOHOL_USED_Unknown" in cols
            cat_alcohol_col = next((c for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"] if c in cols), None)

            if onehot_yes or onehot_no or onehot_unk:
                pieces = []
                for v in alcohol_raw:
                    col = f"ALCOHOL_USED_{v}"
                    if col in cols:
                        pieces.append(f"COALESCE(`{col}`,0)=1")
                if pieces:
                    where.append("(" + " OR ".join(pieces) + ")")
            elif cat_alcohol_col:
                placeholders = ",".join(["%s"] * len(alcohol_raw))
                where.append(f"UPPER(TRIM(`{cat_alcohol_col}`)) IN ({placeholders})")
                params.extend([v.upper() for v in alcohol_raw])

        # Hour range (from HOUR_COMMITTED / TIME_COMMITTED / DATE_COMMITTED)
        hour_from = q.get("hour_from"); hour_to = q.get("hour_to")
        if hour_from is not None and hour_to is not None:
            if "HOUR_COMMITTED" in cols:
                where.append("CAST(`HOUR_COMMITTED` AS SIGNED) BETWEEN %s AND %s")
                params.extend([hour_from, hour_to])
            elif "TIME_COMMITTED" in cols:
                where.append("HOUR(`TIME_COMMITTED`) BETWEEN %s AND %s")
                params.extend([hour_from, hour_to])
            elif "DATE_COMMITTED" in cols:
                where.append("HOUR(`DATE_COMMITTED`) BETWEEN %s AND %s")
                params.extend([hour_from, hour_to])

        # Age range (detect likely age column)
        age_from = q.get("age_from"); age_to = q.get("age_to")
        age_col = next((c for c in ["AGE","VICTIM_AGE","AGE_OF_VICTIM"] if c in cols), None)
        if age_col and age_from is not None and age_to is not None:
            where.append(f"CAST(`{age_col}` AS SIGNED) BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        where_sql = " WHERE " + " AND ".join(where) if where else ""

        # -------- Compute gender counts within the filtered set --------
        labels = ["Male", "Female", "Unknown"]
        counts = {"Male": 0, "Female": 0, "Unknown": 0}

        if gender_cat_col:
            # Use text values; everything else -> Unknown
            sql = f"""
                SELECT
                  SUM(CASE WHEN UPPER(TRIM(`{gender_cat_col}`)) IN ('MALE','M') THEN 1 ELSE 0 END) AS male_cnt,
                  SUM(CASE WHEN UPPER(TRIM(`{gender_cat_col}`)) IN ('FEMALE','F') THEN 1 ELSE 0 END) AS female_cnt,
                  SUM(CASE WHEN (`{gender_cat_col}` IS NULL OR TRIM(`{gender_cat_col}`) = '' OR
                                UPPER(TRIM(`{gender_cat_col}`)) NOT IN ('MALE','M','FEMALE','F')) THEN 1 ELSE 0 END) AS unk_cnt
                FROM `{table}`
                {where_sql}
            """
            cur.execute(sql, params)
            m, f, u = cur.fetchone()
            counts["Male"] = int(m or 0)
            counts["Female"] = int(f or 0)
            counts["Unknown"] = int(u or 0)
        else:
            # One-hot route; only SUM columns that exist
            pieces = []
            if onehot_male:   pieces.append(f"SUM(COALESCE(`{onehot_male}`,0)) AS male_cnt")
            if onehot_female: pieces.append(f"SUM(COALESCE(`{onehot_female}`,0)) AS female_cnt")
            if onehot_unknown:pieces.append(f"SUM(COALESCE(`{onehot_unknown}`,0)) AS unk_cnt")
            pieces.append("COUNT(*) AS total_rows")

            if len(pieces) == 1:  # nothing to sum and no total_rows
                cur.close(); conn.close()
                return jsonify(success=False, message=(
                    "No gender columns found. Expected one of: "
                    "categorical (GENDER/SEX/VICTIM_GENDER/SEX_OF_VICTIM) or one-hot (GENDER_*/SEX_*)."
                )), 200

            sql = f"SELECT {', '.join(pieces)} FROM `{table}`{where_sql}"
            cur.execute(sql, params)
            row = cur.fetchone()
            desc = [d[0] for d in cur.description]
            row_map = {desc[i]: row[i] for i in range(len(desc))}

            total_rows = int(row_map.get("total_rows", 0) or 0)
            male_cnt = int(row_map.get("male_cnt", 0) or 0)
            female_cnt = int(row_map.get("female_cnt", 0) or 0)
            unk_cnt = int(row_map.get("unk_cnt", 0) or 0)

            # If female column missing, infer from remainder
            if not onehot_female:
                female_cnt = max(total_rows - male_cnt - unk_cnt, 0)

            counts["Male"], counts["Female"], counts["Unknown"] = male_cnt, female_cnt, unk_cnt

        cur.close(); conn.close()

        total = sum(counts.values())
        if total == 0:
            return jsonify(success=True, data={"labels": [], "values": []}), 200

        return jsonify(
            success=True,
            data={"labels": labels, "values": [counts[l] for l in labels]}
        ), 200

    except Exception as e:
        return jsonify(success=False, message=f"{type(e).__name__}: {e}"), 500


@api_bp.route("/kpis", methods=["GET"])
def kpis():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Columns present?
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        # Victim count column (if any)
        victim_candidates = ["VICTIM_COUNT", "VICTIM COUNT", "TOTAL_VICTIMS", "NUM_VICTIMS"]
        victim_col = next((c for c in victim_candidates if c in cols), None)

        # Hour source for BETWEEN filters
        hour_where_col = None
        hour_expr = None
        if "HOUR_COMMITTED" in cols:
            hour_expr = "CAST(`HOUR_COMMITTED` AS SIGNED)"
            hour_where_col = "`HOUR_COMMITTED` IS NOT NULL"
        elif "TIME_COMMITTED" in cols:
            hour_expr = "HOUR(`TIME_COMMITTED`)"
            hour_where_col = "`TIME_COMMITTED` IS NOT NULL"
        elif "DATE_COMMITTED" in cols:
            hour_expr = "HOUR(`DATE_COMMITTED`)"
            hour_where_col = "`DATE_COMMITTED` IS NOT NULL"

        # ---- Build WHERE (same pattern as other endpoints) ----
        q = request.args
        where = []
        params = []

        if hour_where_col:
            where.append(hour_where_col)

        # Location
        location = (q.get("location") or "").strip()
        if location and "BARANGAY" in cols:
            where.append("BARANGAY = %s")
            params.append(location)

        # Gender filter (works even if your chart also filters by gender)
        gender_req = (q.get("gender") or "").strip().lower()
        gender_cat = next((c for c in ["GENDER","SEX","VICTIM_GENDER","SEX_OF_VICTIM"] if c in cols), None)
        # One-hot fallbacks
        present_onehots = {c for c in cols if c.startswith(("GENDER_","SEX_"))}
        onehot_male   = next((c for c in present_onehots if c.lower().endswith("male")),   None)
        onehot_female = next((c for c in present_onehots if c.lower().endswith("female")), None)
        onehot_other  = next((c for c in present_onehots if c.lower().endswith("other")),  None)

        if gender_req:
            if gender_cat:
                where.append(f"UPPER(TRIM(`{gender_cat}`)) = %s")
                params.append(gender_req.upper())
            else:
                gh = {
                    "male": onehot_male,
                    "female": onehot_female,
                    "other": onehot_other
                }.get(gender_req)
                if gh:
                    where.append(f"COALESCE(`{gh}`,0) = 1")

        # Day of Week
        day_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        if day_raw:
            if "DATE_COMMITTED" in cols:
                weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"  # 0..6
            elif "WEEKDAY" in cols:
                weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
            else:
                weekday_expr = None

            if weekday_expr:
                name_to_int = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}
                wd_ints = []
                for item in day_raw:
                    tok = item.split(".", 1)[0].strip()
                    if tok.isdigit():
                        n = int(tok)
                        if 1 <= n <= 7: wd_ints.append(n-1)
                    else:
                        v = name_to_int.get(tok.upper(), None)
                        if v is not None: wd_ints.append(v)
                if wd_ints:
                    placeholders = ",".join(["%s"] * len(wd_ints))
                    where.append(f"{weekday_expr} IN ({placeholders})")
                    params.extend(wd_ints)

        # Alcohol (one-hot or categorical)
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]
        if alcohol_raw:
            onehot_yes = "ALCOHOL_USED_Yes" in cols
            onehot_no  = "ALCOHOL_USED_No" in cols
            onehot_unk = "ALCOHOL_USED_Unknown" in cols
            cat_alcohol_col = next((c for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"] if c in cols), None)

            if onehot_yes or onehot_no or onehot_unk:
                pieces = []
                for v in alcohol_raw:
                    col = f"ALCOHOL_USED_{v}"
                    if col in cols:
                        pieces.append(f"COALESCE(`{col}`,0)=1")
                if pieces:
                    where.append("(" + " OR ".join(pieces) + ")")
            elif cat_alcohol_col:
                placeholders = ",".join(["%s"] * len(alcohol_raw))
                where.append(f"UPPER(TRIM(`{cat_alcohol_col}`)) IN ({placeholders})")
                params.extend([v.upper() for v in alcohol_raw])

        # Hour range
        hour_from = q.get("hour_from"); hour_to = q.get("hour_to")
        if hour_expr and hour_from is not None and hour_to is not None:
            where.append(f"{hour_expr} BETWEEN %s AND %s")
            params.extend([hour_from, hour_to])

        # Age range
        age_from = q.get("age_from"); age_to = q.get("age_to")
        age_col = next((c for c in ["AGE","VICTIM_AGE","AGE_OF_VICTIM"] if c in cols), None)
        if age_col and age_from is not None and age_to is not None:
            where.append(f"CAST(`{age_col}` AS SIGNED) BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        where_sql = " WHERE " + " AND ".join(where) if where else ""

        # ---- Query the KPIs ----
        # 1) Total accidents = row count
        cur.execute(f"SELECT COUNT(*) FROM `{table}`{where_sql}", params)
        total_accidents = int(cur.fetchone()[0] or 0)

        # 2) Total victims = SUM(victim_col) if present, else NULL/0
        total_victims = None
        avg_victims_per_accident = None
        if victim_col:
            cur.execute(
                f"SELECT SUM(NULLIF(CAST(`{victim_col}` AS DECIMAL(18,4)),0)) FROM `{table}`{where_sql}",
                params
            )
            tv = cur.fetchone()[0]
            total_victims = float(tv) if tv is not None else 0.0
            if total_accidents > 0 and total_victims is not None:
                avg_victims_per_accident = float(total_victims) / float(total_accidents)

        # 3) Alcohol involvement = Yes / Total (include Unknown in denominator, to match your BI card)
        alcohol_involvement_rate = None
        # Handle both one-hot and categorical
        if {"ALCOHOL_USED_Yes","ALCOHOL_USED_No","ALCOHOL_USED_Unknown"} & cols or \
           any(c in cols for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"]):
            # Count "Yes"
            if "ALCOHOL_USED_Yes" in cols:
                cur.execute(f"SELECT SUM(COALESCE(`ALCOHOL_USED_Yes`,0)) FROM `{table}`{where_sql}", params)
                yes_cnt = int(cur.fetchone()[0] or 0)
            else:
                cat_alcohol_col = next((c for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"] if c in cols), None)
                if cat_alcohol_col:
                    cur.execute(
                        f"SELECT SUM(CASE WHEN UPPER(TRIM(`{cat_alcohol_col}`))='YES' THEN 1 ELSE 0 END) FROM `{table}`{where_sql}",
                        params
                    )
                    yes_cnt = int(cur.fetchone()[0] or 0)
                else:
                    yes_cnt = None

            if yes_cnt is not None and total_accidents > 0:
                alcohol_involvement_rate = yes_cnt / float(total_accidents)

        cur.close(); conn.close()

        return jsonify(success=True, data={
            "total_accidents": total_accidents,
            "total_victims": total_victims if total_victims is not None else 0,
            "avg_victims_per_accident": avg_victims_per_accident if avg_victims_per_accident is not None else None,
            "alcohol_involvement_rate": alcohol_involvement_rate if alcohol_involvement_rate is not None else None
        }), 200

    except Exception as e:
        return jsonify(success=False, message=str(e)), 500



@api_bp.route("/accidents_by_day", methods=["GET"])
def accidents_by_day():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    if table not in list_tables():
        return jsonify(success=False, message="Table not found"), 404

    victim_cols = ["VICTIM_COUNT", "VICTIM COUNT"]

    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        victim_col = next((c for c in victim_cols if c in cols), None)

        # --- Build WHERE filters ---
        where_clauses = []
        params = []

        location = request.args.get("location")
        if location and "BARANGAY" in cols:
            where_clauses.append("BARANGAY = %s")
            params.append(location)

        gender = request.args.get("gender")
        if gender and "GENDER" in cols:
            where_clauses.append("UPPER(TRIM(GENDER)) = %s")
            params.append(gender.upper())

        alcohol = request.args.get("alcohol")
        if alcohol and "ALCOHOL_USED" in cols:
            values = alcohol.split(",")
            placeholders = ",".join(["%s"] * len(values))
            where_clauses.append(f"ALCOHOL_USED IN ({placeholders})")
            params.extend(values)

        # hours & ages (optional)
        hour_from = request.args.get("hour_from")
        hour_to = request.args.get("hour_to")
        if hour_from and hour_to and "HOUR_COMMITTED" in cols:
            where_clauses.append("HOUR_COMMITTED BETWEEN %s AND %s")
            params.extend([hour_from, hour_to])

        age_from = request.args.get("age_from")
        age_to = request.args.get("age_to")
        if age_from and age_to and "AGE" in cols:
            where_clauses.append("AGE BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        # Combine into WHERE
        where_sql = " AND ".join(where_clauses)
        if where_sql:
            where_sql = "AND " + where_sql

        # --- Run weekday query ---
        weekday_expr = "WEEKDAY(DATE_COMMITTED)" if "DATE_COMMITTED" in cols else "CAST(`WEEKDAY` AS SIGNED)"
        cur.execute(f"""
            SELECT {weekday_expr} AS wd, COUNT(*) AS cnt
            FROM `{table}`
            WHERE {weekday_expr} IS NOT NULL {where_sql}
            GROUP BY wd
            ORDER BY wd
        """, params)
        rows_cnt = cur.fetchall()

        avg_map = {}
        if victim_col:
            cur.execute(f"""
                SELECT {weekday_expr} AS wd, AVG(NULLIF(`{victim_col}`, 0)) AS avg_v
                FROM `{table}`
                WHERE {weekday_expr} IS NOT NULL {where_sql}
                GROUP BY wd
                ORDER BY wd
            """, params)
            for wd, avg_v in cur.fetchall():
                avg_map[int(wd)] = float(avg_v) if avg_v is not None else None

        cur.close()
        conn.close()

        # Format output same as before
        day_labels = ["1. Monday", "2. Tuesday", "3. Wednesday",
                      "4. Thursday", "5. Friday", "6. Saturday", "7. Sunday"]
        counts_by_wd = {int(wd): int(cnt) for wd, cnt in rows_cnt}
        days = day_labels
        counts = [counts_by_wd.get(i, 0) for i in range(7)]
        avg_victims = [round(avg_map.get(i, 0), 2) if avg_map else None for i in range(7)]

        return jsonify(success=True, data={"days": days, "counts": counts, "avg_victims": avg_victims})
    except Exception as e:
        return jsonify(success=False, message=str(e)), 500


@api_bp.route("/top_barangays", methods=["GET"])
def top_barangays():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Inspect columns
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        # Barangay column
        brgy_candidates = ["BARANGAY", "Barangay", "BRGY", "BRGY_NAME", "LOCATION", "STATION"]
        brgy_col = next((c for c in brgy_candidates if c in cols), None)
        if not brgy_col:
            return jsonify(success=False, message="No BARANGAY-like column found"), 200

        # --- Build WHERE filters, mirroring other endpoints ---
        where_clauses = [f"`{brgy_col}` IS NOT NULL AND TRIM(`{brgy_col}`) <> ''"]
        params = []

        q = request.args

        # Location exact match (useful if you later scope "top within a station")
        location = (q.get("location") or "").strip()
        if location and "BARANGAY" in cols:
            where_clauses.append("BARANGAY = %s")
            params.append(location)

        # Gender: categorical or one-hot
        gender_req = (q.get("gender") or "").strip().lower()
        gender_cat = next((c for c in ["GENDER", "SEX", "VICTIM_GENDER", "SEX_OF_VICTIM"] if c in cols), None)
        gender_onehot = {
            "male":   next((c for c in cols if c.upper().endswith("MALE")   and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "female": next((c for c in cols if c.upper().endswith("FEMALE") and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "other":  next((c for c in cols if c.upper().endswith("OTHER")  and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
        }
        if gender_req:
            if gender_cat:
                where_clauses.append(f"UPPER(TRIM(`{gender_cat}`)) = %s")
                params.append(gender_req.upper())
            elif gender_onehot.get(gender_req):
                where_clauses.append(f"COALESCE(`{gender_onehot[gender_req]}`,0) = 1")

        # Day of week (accepts "1. Monday", "Monday", or "1")
        day_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        if day_raw:
            if "DATE_COMMITTED" in cols:
                weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"  # 0=Mon..6=Sun
            elif "WEEKDAY" in cols:
                weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
            else:
                weekday_expr = None

            if weekday_expr:
                # Normalize to ints 0..6
                name_to_int = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}
                wd_ints = []
                for item in day_raw:
                    tok = item.split(".", 1)[0].strip()  # "1. Monday" -> "1"
                    if tok.isdigit():
                        # Your UI labels are 1..7; convert to 0..6
                        n = int(tok)
                        if 1 <= n <= 7: wd_ints.append((n-1))
                    else:
                        wd_ints.append(name_to_int.get(tok.upper(), None))
                wd_ints = [w for w in wd_ints if w is not None]
                if wd_ints:
                    placeholders = ",".join(["%s"] * len(wd_ints))
                    where_clauses.append(f"{weekday_expr} IN ({placeholders})")
                    params.extend(wd_ints)

        # Alcohol (supports one-hot or categorical)
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]
        if alcohol_raw:
            onehot_map = {k: (k and f"ALCOHOL_USED_{k}" in cols) for k in ["Yes","No","Unknown"]}
            cat_col = next((c for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"] if c in cols), None)

            if any(onehot_map.values()):
                pieces = []
                for v in alcohol_raw:
                    col = f"ALCOHOL_USED_{v}"
                    if col in cols:
                        pieces.append(f"COALESCE(`{col}`,0)=1")
                if pieces:
                    where_clauses.append("(" + " OR ".join(pieces) + ")")
            elif cat_col:
                placeholders = ",".join(["%s"] * len(alcohol_raw))
                where_clauses.append(f"UPPER(TRIM(`{cat_col}`)) IN ({placeholders})")
                params.extend([v.upper() for v in alcohol_raw])

        # Hour range
        hour_from = q.get("hour_from"); hour_to = q.get("hour_to")
        if hour_from is not None and hour_to is not None:
            if "HOUR_COMMITTED" in cols:
                where_clauses.append("CAST(`HOUR_COMMITTED` AS SIGNED) BETWEEN %s AND %s")
            elif "TIME_COMMITTED" in cols:
                where_clauses.append("HOUR(`TIME_COMMITTED`) BETWEEN %s AND %s")
            elif "DATE_COMMITTED" in cols:
                where_clauses.append("HOUR(`DATE_COMMITTED`) BETWEEN %s AND %s")
            else:
                pass
            params.extend([hour_from, hour_to])

        # Age range
        age_from = q.get("age_from"); age_to = q.get("age_to")
        age_col = next((c for c in ["AGE","VICTIM_AGE","AGE_OF_VICTIM"] if c in cols), None)
        if age_col and age_from is not None and age_to is not None:
            where_clauses.append(f"CAST(`{age_col}` AS SIGNED) BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        where_sql = " AND ".join(where_clauses)
        if where_sql:
            where_sql = "WHERE " + where_sql

        # Query top 10 with filters applied
        cur.execute(f"""
            SELECT `{brgy_col}` AS brgy, COUNT(*) AS cnt
            FROM `{table}`
            {where_sql}
            GROUP BY brgy
            ORDER BY cnt DESC
            LIMIT 10
        """, params)
        rows = cur.fetchall()
        cur.close(); conn.close()

        names = [r[0] for r in rows]
        counts = [int(r[1]) for r in rows]

        # Optional: echo a small suffix if scoped by Location or Gender etc.
        title_bits = []
        if location: title_bits.append(f" — {location}")
        if gender_req: title_bits.append(f" — {gender_req.capitalize()}")
        title_suffix = "".join(title_bits) if title_bits else ""

        return jsonify(success=True, data={"names": names, "counts": counts, "title_suffix": title_suffix})
    except Exception as e:
        return jsonify(success=False, message=str(e)), 500


@api_bp.route("/alcohol_by_hour", methods=["GET"])
def alcohol_by_hour():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Inspect columns
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        # Hour source
        hour_expr = None; hour_where_col = None
        if "HOUR_COMMITTED" in cols:
            hour_expr = "CAST(`HOUR_COMMITTED` AS SIGNED)"
            hour_where_col = "`HOUR_COMMITTED` IS NOT NULL"
        elif "TIME_COMMITTED" in cols:
            hour_expr = "HOUR(`TIME_COMMITTED`)"
            hour_where_col = "`TIME_COMMITTED` IS NOT NULL"
        elif "DATE_COMMITTED" in cols:
            hour_expr = "HOUR(`DATE_COMMITTED`)"
            hour_where_col = "`DATE_COMMITTED` IS NOT NULL"
        else:
            return jsonify(success=False, message="No hour column found (HOUR_COMMITTED/TIME_COMMITTED/DATE_COMMITTED)"), 200

        # Alcohol schema detection (one-hot or categorical)
        has_yes = "ALCOHOL_USED_Yes" in cols
        has_no  = "ALCOHOL_USED_No" in cols
        has_unk = "ALCOHOL_USED_Unknown" in cols
        one_hot_any = has_yes or has_no or has_unk

        cat_candidates = ["ALCOHOL_USED", "ALCOHOL_INVOLVEMENT", "ALCOHOL", "ALCOHOL_FLAG"]
        cat_col = next((c for c in cat_candidates if c in cols), None)

        if not (one_hot_any or cat_col):
            return jsonify(success=False, message="No alcohol involvement columns found."), 200

        # -------- Build WHERE filters (same as other endpoints) --------
        where = [hour_where_col]
        params = []
        q = request.args

        # Location
        location = (q.get("location") or "").strip()
        if location and "BARANGAY" in cols:
            where.append("BARANGAY = %s")
            params.append(location)

        # Gender (categorical or one-hot)
        gender_req = (q.get("gender") or "").strip().lower()
        gender_cat = next((c for c in ["GENDER", "SEX", "VICTIM_GENDER", "SEX_OF_VICTIM"] if c in cols), None)
        gender_onehot = {
            "male":   next((c for c in cols if c.upper().endswith("MALE")   and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "female": next((c for c in cols if c.upper().endswith("FEMALE") and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "other":  next((c for c in cols if c.upper().endswith("OTHER")  and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
        }
        if gender_req:
            if gender_cat:
                where.append(f"UPPER(TRIM(`{gender_cat}`)) = %s")
                params.append(gender_req.upper())
            elif gender_onehot.get(gender_req):
                where.append(f"COALESCE(`{gender_onehot[gender_req]}`,0) = 1")

        # Day of week (accepts "1. Monday", "Monday", or "1")
        day_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        if day_raw:
            if "DATE_COMMITTED" in cols:
                weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"  # 0=Mon..6=Sun
            elif "WEEKDAY" in cols:
                weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
            else:
                weekday_expr = None

            if weekday_expr:
                name_to_int = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}
                wd_ints = []
                for item in day_raw:
                    tok = item.split(".", 1)[0].strip()
                    if tok.isdigit():
                        n = int(tok)
                        if 1 <= n <= 7: wd_ints.append(n-1)
                    else:
                        wd_ints.append(name_to_int.get(tok.upper(), None))
                wd_ints = [w for w in wd_ints if w is not None]
                if wd_ints:
                    placeholders = ",".join(["%s"] * len(wd_ints))
                    where.append(f"{weekday_expr} IN ({placeholders})")
                    params.extend(wd_ints)

        # Alcohol subset (optional): if user ticks specific statuses, restrict to them
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]
        if alcohol_raw:
            if one_hot_any:
                pieces = []
                for v in alcohol_raw:
                    col = f"ALCOHOL_USED_{v}"
                    if col in cols:
                        pieces.append(f"COALESCE(`{col}`,0) = 1")
                if pieces:
                    where.append("(" + " OR ".join(pieces) + ")")
            elif cat_col:
                placeholders = ",".join(["%s"] * len(alcohol_raw))
                where.append(f"UPPER(TRIM(`{cat_col}`)) IN ({placeholders})")
                params.extend([v.upper() for v in alcohol_raw])

        # Hour range
        hour_from = q.get("hour_from"); hour_to = q.get("hour_to")
        if hour_from is not None and hour_to is not None:
            if "HOUR_COMMITTED" in cols:
                where.append("CAST(`HOUR_COMMITTED` AS SIGNED) BETWEEN %s AND %s")
            elif "TIME_COMMITTED" in cols:
                where.append("HOUR(`TIME_COMMITTED`) BETWEEN %s AND %s")
            elif "DATE_COMMITTED" in cols:
                where.append("HOUR(`DATE_COMMITTED`) BETWEEN %s AND %s")
            params.extend([hour_from, hour_to])

        # Age range
        age_from = q.get("age_from"); age_to = q.get("age_to")
        age_col = next((c for c in ["AGE","VICTIM_AGE","AGE_OF_VICTIM"] if c in cols), None)
        if age_col and age_from is not None and age_to is not None:
            where.append(f"CAST(`{age_col}` AS SIGNED) BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        where_sql = " AND ".join(where)
        if where_sql:
            where_sql = "WHERE " + where_sql

        # ----- Build SELECT for counts per hour (handles one-hot or categorical) -----
        if one_hot_any:
            yes_expr = "SUM(COALESCE(`ALCOHOL_USED_Yes`,0))" if has_yes else "0"
            no_expr  = "SUM(COALESCE(`ALCOHOL_USED_No`,0))"  if has_no  else "0"
            unk_expr = "SUM(COALESCE(`ALCOHOL_USED_Unknown`,0))" if has_unk else "0"
        else:
            # categorical normalization
            yes_expr = f"SUM(CASE WHEN UPPER(TRIM(`{cat_col}`)) IN ('YES','Y','1','TRUE') THEN 1 ELSE 0 END)"
            no_expr  = f"SUM(CASE WHEN UPPER(TRIM(`{cat_col}`)) IN ('NO','N','0','FALSE') THEN 1 ELSE 0 END)"
            unk_expr = f"SUM(CASE WHEN `{cat_col}` IS NULL OR UPPER(TRIM(`{cat_col}`)) NOT IN ('YES','Y','1','TRUE','NO','N','0','FALSE') THEN 1 ELSE 0 END)"

        sql = f"""
            SELECT {hour_expr} AS hr,
                   {yes_expr} AS yes_cnt,
                   {no_expr}  AS no_cnt,
                   {unk_expr} AS unk_cnt
            FROM `{table}`
            {where_sql}
            GROUP BY hr
            ORDER BY hr
        """
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close(); conn.close()

        if not rows:
            return jsonify(success=True, data={"hours": [], "yes": [], "no": [], "unknown": [], "yes_pct": [], "no_pct": [], "unknown_pct": []}), 200

        by_hour = {int(hr): (int(yes), int(no), int(unk)) for hr, yes, no, unk in rows if hr is not None}
        hours = list(range(24))
        yes_pct, no_pct, unk_pct = [], [], []
        for h in hours:
            y, n, u = by_hour.get(h, (0, 0, 0))
            total = y + n + u
            if total > 0:
                yes_pct.append(round(100.0 * y / total, 2))
                no_pct.append(round(100.0 * n / total, 2))
                unk_pct.append(round(100.0 * u / total, 2))
            else:
                yes_pct.append(0.0); no_pct.append(0.0); unk_pct.append(0.0)

        return jsonify(success=True, data={
            "hours": hours,
            "yes_pct": yes_pct, "no_pct": no_pct, "unknown_pct": unk_pct
        })
    except Exception as e:
        return jsonify(success=False, message=str(e)), 500


@api_bp.route("/victims_by_age", methods=["GET"])
def victims_by_age():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # --- detect columns
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        # age columns (numeric first)
        age_num_candidates = ["AGE", "AGE_YEARS", "AGE_OF_VICTIM"]
        age_num_col = next((c for c in age_num_candidates if c in cols), None)

        # age group (categorical) columns
        age_grp_candidates = ["AGE_GROUP", "AGE_BUCKET", "AGE_RANGE"]
        age_grp_col = next((c for c in age_grp_candidates if c in cols), None)

        # victim count logic
        victim_count_col = "VICTIM_COUNT" if "VICTIM_COUNT" in cols else None
        injuries_col      = "INJURIES"     if "INJURIES" in cols else None
        fatalities_col    = "FATALITIES"   if "FATALITIES" in cols else None

        if victim_count_col:
            vic_expr = f"COALESCE(`{victim_count_col}`,0)"
        elif injuries_col or fatalities_col:
            i = f"COALESCE(`{injuries_col}`,0)" if injuries_col else "0"
            f = f"COALESCE(`{fatalities_col}`,0)" if fatalities_col else "0"
            vic_expr = f"({i} + {f})"
        else:
            # Fallback: each row counts as 1 victim
            vic_expr = "1"

        # ---------- WHERE filters (mirror other endpoints) ----------
        where = []
        params = []
        q = request.args

        # Location
        location = (q.get("location") or "").strip()
        if location and "BARANGAY" in cols:
            where.append("BARANGAY = %s")
            params.append(location)

        # Gender (categorical or one-hot)
        gender_req = (q.get("gender") or "").strip().lower()
        gender_cat = next((c for c in ["GENDER", "SEX", "VICTIM_GENDER", "SEX_OF_VICTIM"] if c in cols), None)
        gender_onehot = {
            "male":   next((c for c in cols if c.upper().endswith("MALE")   and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "female": next((c for c in cols if c.upper().endswith("FEMALE") and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "other":  next((c for c in cols if c.upper().endswith("OTHER")  and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
        }
        if gender_req:
            if gender_cat:
                where.append(f"UPPER(TRIM(`{gender_cat}`)) = %s")
                params.append(gender_req.upper())
            elif gender_onehot.get(gender_req):
                where.append(f"COALESCE(`{gender_onehot[gender_req]}`,0) = 1")

        # Day of week
        day_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        if day_raw:
            if "DATE_COMMITTED" in cols:
                weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"  # 0=Mon..6=Sun
            elif "WEEKDAY" in cols:
                weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
            else:
                weekday_expr = None

            if weekday_expr:
                name_to_int = {"MONDAY":0,"TUESDAY":1,"WEDNESDAY":2,"THURSDAY":3,"FRIDAY":4,"SATURDAY":5,"SUNDAY":6}
                wd_ints = []
                for item in day_raw:
                    tok = item.split(".",1)[0].strip()
                    if tok.isdigit():
                        n = int(tok)
                        if 1 <= n <= 7: wd_ints.append(n-1)
                    else:
                        got = name_to_int.get(tok.upper(), None)
                        if got is not None:
                            wd_ints.append(got)
                if wd_ints:
                    placeholders = ",".join(["%s"] * len(wd_ints))
                    where.append(f"{weekday_expr} IN ({placeholders})")
                    params.extend(wd_ints)

        # Alcohol
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]
        if alcohol_raw:
            onehot_map = {k: (f"ALCOHOL_USED_{k}" in cols) for k in ["Yes","No","Unknown"]}
            cat_col = next((c for c in ["ALCOHOL_USED","ALCOHOL_INVOLVEMENT","ALCOHOL","ALCOHOL_FLAG"] if c in cols), None)

            if any(onehot_map.values()):
                pieces = []
                for v in alcohol_raw:
                    col = f"ALCOHOL_USED_{v}"
                    if col in cols:
                        pieces.append(f"COALESCE(`{col}`,0)=1")
                if pieces:
                    where.append("(" + " OR ".join(pieces) + ")")
            elif cat_col:
                placeholders = ",".join(["%s"] * len(alcohol_raw))
                where.append(f"UPPER(TRIM(`{cat_col}`)) IN ({placeholders})")
                params.extend([v.upper() for v in alcohol_raw])

        # Hour range (from HOUR_COMMITTED or time columns)
        hour_from = q.get("hour_from"); hour_to = q.get("hour_to")
        if hour_from is not None and hour_to is not None:
            if "HOUR_COMMITTED" in cols:
                where.append("CAST(`HOUR_COMMITTED` AS SIGNED) BETWEEN %s AND %s")
            elif "TIME_COMMITTED" in cols:
                where.append("HOUR(`TIME_COMMITTED`) BETWEEN %s AND %s")
            elif "DATE_COMMITTED" in cols:
                where.append("HOUR(`DATE_COMMITTED`) BETWEEN %s AND %s")
            params.extend([hour_from, hour_to])

        # Age range (for numeric age only)
        age_from = q.get("age_from"); age_to = q.get("age_to")
        if age_num_col and age_from is not None and age_to is not None:
            where.append(f"CAST(`{age_num_col}` AS SIGNED) BETWEEN %s AND %s")
            params.extend([age_from, age_to])

        where_sql = " AND ".join(where)
        if where_sql:
            where_sql = "WHERE " + where_sql

        # ---------- Grouping ----------
        if age_num_col:
            # numeric binning: 0–9,10–19,...,70–79,80+,Unknown
            age_bin = f"""
                CASE
                  WHEN `{age_num_col}` IS NULL OR `{age_num_col}` < 0 THEN 'Unknown'
                  WHEN CAST(`{age_num_col}` AS SIGNED) >= 80 THEN '80+'
                  ELSE CONCAT(CAST(FLOOR(CAST(`{age_num_col}` AS SIGNED)/10)*10 AS CHAR), '–',
                              CAST(FLOOR(CAST(`{age_num_col}` AS SIGNED)/10)*10 + 9 AS CHAR))
                END
            """
            sql = f"""
                SELECT {age_bin} AS age_bin,
                       SUM({vic_expr}) AS total_victims
                FROM `{table}`
                {where_sql}
                GROUP BY age_bin
            """
        elif age_grp_col:
            sql = f"""
                SELECT COALESCE(NULLIF(TRIM(`{age_grp_col}`),''), 'Unknown') AS age_bin,
                       SUM({vic_expr}) AS total_victims
                FROM `{table}`
                {where_sql}
                GROUP BY age_bin
            """
        else:
            cur.close(); conn.close()
            return jsonify(success=False, message="No age column found (AGE / AGE_GROUP)."), 200

        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close(); conn.close()

        if not rows:
            return jsonify(success=True, data={"labels": [], "values": []}), 200

        # Sort bins nicely: 0–9,10–19,...,80+,Unknown
        def sort_key(lbl):
            if lbl == "Unknown": return (2, 999)
            if lbl.endswith("+"):
                try:
                    return (1, int(lbl[:-1]))
                except:
                    return (1, 999)
            if "–" in lbl:
                try:
                    lo = int(lbl.split("–")[0])
                    return (0, lo)
                except:
                    return (0, 999)
            return (0, 999)

        rows.sort(key=lambda r: sort_key(r[0] or "Unknown"))
        labels = [r[0] or "Unknown" for r in rows]
        values = [int(r[1] or 0) for r in rows]

        return jsonify(success=True, data={"labels": labels, "values": values}), 200

    except Exception as e:
        return jsonify(success=False, message=str(e)), 500


@api_bp.route("/accidents_by_hour", methods=["GET"])
def accidents_by_hour():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized"), 401

    table = session.get("forecast_table", "accidents")
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # --- Discover columns present ---
        cur.execute(f"SHOW COLUMNS FROM `{table}`")
        cols = {r[0] for r in cur.fetchall()}

        # Hour column/expression
        if "HOUR_COMMITTED" in cols:
            hour_expr = "CAST(`HOUR_COMMITTED` AS SIGNED)"
            hour_where = "`HOUR_COMMITTED` IS NOT NULL"
        elif "TIME_COMMITTED" in cols:
            hour_expr = "HOUR(`TIME_COMMITTED`)"
            hour_where = "`TIME_COMMITTED` IS NOT NULL"
        elif "DATE_COMMITTED" in cols:
            hour_expr = "HOUR(`DATE_COMMITTED`)"
            hour_where = "`DATE_COMMITTED` IS NOT NULL"
        else:
            cur.close(); conn.close()
            return jsonify(success=False, message="No hour column found (HOUR_COMMITTED/TIME_COMMITTED/DATE_COMMITTED)"), 200

        # Location column candidates
        brgy_candidates = ["BARANGAY", "Barangay", "BRGY", "BRGY_NAME", "LOCATION", "STATION"]
        brgy_col = next((c for c in brgy_candidates if c in cols), None)

        # Day of week expression (MySQL WEEKDAY: 0=Mon..6=Sun)
        if "DATE_COMMITTED" in cols:
            weekday_expr = "WEEKDAY(`DATE_COMMITTED`)"
        elif "WEEKDAY" in cols:
            weekday_expr = "CAST(`WEEKDAY` AS SIGNED)"
        else:
            weekday_expr = None

        # Gender detection (cat or one-hot)
        gender_cat = next((c for c in ["GENDER", "SEX", "VICTIM_GENDER", "SEX_OF_VICTIM"] if c in cols), None)
        gender_onehot = {
            "male":   next((c for c in cols if c.upper().endswith("MALE")   and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "female": next((c for c in cols if c.upper().endswith("FEMALE") and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
            "other":  next((c for c in cols if c.upper().endswith("OTHER")  and (c.startswith("GENDER_") or c.startswith("SEX_"))), None),
        }

        # Alcohol detection (cat or one-hot)
        alcohol_onehot = {
            "Yes": "ALCOHOL_USED_Yes" in cols,
            "No": "ALCOHOL_USED_No" in cols,
            "Unknown": "ALCOHOL_USED_Unknown" in cols,
        }
        alcohol_cat = next((c for c in ["ALCOHOL_USED", "ALCOHOL_INVOLVEMENT", "ALCOHOL", "ALCOHOL_FLAG"] if c in cols), None)

        # Age detection
        age_col = next((c for c in ["AGE", "VICTIM_AGE", "AGE_OF_VICTIM"] if c in cols), None)

        # --- Read query params ---
        q = request.args
        location = (q.get("location") or "").strip()

        gender = (q.get("gender") or "").strip().lower()           # "male"|"female"|"other"|""
        # day_of_week accepts "1. Monday", "Monday", "1", etc.
        day_of_week_raw = [s.strip() for s in (q.get("day_of_week") or "").split(",") if s.strip()]
        alcohol_raw = [s.strip() for s in (q.get("alcohol") or "").split(",") if s.strip()]  # ["Yes","No","Unknown"]

        def to_int_safe(v, default=None):
            try: return int(v)
            except: return default

        hour_from = to_int_safe(q.get("hour_from"), 0)
        hour_to   = to_int_safe(q.get("hour_to"), 23)
        age_from  = to_int_safe(q.get("age_from"), None)
        age_to    = to_int_safe(q.get("age_to"), None)

        # Normalize hour bounds
        if hour_from is None: hour_from = 0
        if hour_to   is None: hour_to   = 23
        if hour_from > hour_to:
            hour_from, hour_to = hour_to, hour_from
        hour_from = max(0, min(23, hour_from))
        hour_to   = max(0, min(23, hour_to))

        # --- Build WHERE ---
        where = [hour_where, f"({hour_expr} BETWEEN %s AND %s)"]
        params = [hour_from, hour_to]

        # Location
        if brgy_col and location:
            where.append(f"`{brgy_col}` = %s")
            params.append(location)

        # Day of Week
        if weekday_expr and day_of_week_raw:
            wanted = []
            names = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
            for item in day_of_week_raw:
                # "1. Monday" or "1"
                n = to_int_safe(item.split(".")[0], None)
                if n is not None and 1 <= n <= 7:
                    wanted.append(n - 1)  # 0..6
                    continue
                # by name
                low = item.lower()
                for idx, nm in enumerate(names):
                    if nm in low:
                        wanted.append(idx)
                        break
            if wanted:
                where.append(f"{weekday_expr} IN (" + ",".join(["%s"]*len(wanted)) + ")")
                params += wanted

        # Gender
        if gender in ("male", "female", "other"):
            if gender_cat:
                if gender == "male":
                    where.append(f"UPPER(TRIM(`{gender_cat}`)) IN ('M','MALE')")
                elif gender == "female":
                    where.append(f"UPPER(TRIM(`{gender_cat}`)) IN ('F','FEMALE')")
                else:
                    where.append(f"(`{gender_cat}` IS NULL OR UPPER(TRIM(`{gender_cat}`)) NOT IN ('M','MALE','F','FEMALE'))")
            else:
                one = gender_onehot.get(gender)
                if one:
                    where.append(f"COALESCE(`{one}`,0)=1")

        # Alcohol (supports any subset of Yes/No/Unknown)
        if alcohol_raw:
            alc_clauses = []
            for val in alcohol_raw:
                v = val.capitalize()
                if alcohol_onehot.get(v, False):
                    alc_clauses.append(f"COALESCE(`ALCOHOL_USED_{v}`,0)=1")
                elif alcohol_cat:
                    if v == "Yes":
                        alc_clauses.append(f"UPPER(TRIM(`{alcohol_cat}`)) IN ('YES','Y','1','TRUE')")
                    elif v == "No":
                        alc_clauses.append(f"UPPER(TRIM(`{alcohol_cat}`)) IN ('NO','N','0','FALSE')")
                    else:
                        alc_clauses.append(f"(`{alcohol_cat}` IS NULL OR UPPER(TRIM(`{alcohol_cat}`)) NOT IN ('YES','Y','1','TRUE','NO','N','0','FALSE'))")
            if alc_clauses:
                where.append("(" + " OR ".join(alc_clauses) + ")")

        # Age
        if age_col and (age_from is not None or age_to is not None):
            if age_from is not None and age_to is not None:
                where.append(f"CAST(`{age_col}` AS SIGNED) BETWEEN %s AND %s")
                params += [age_from, age_to]
            elif age_from is not None:
                where.append(f"CAST(`{age_col}` AS SIGNED) >= %s")
                params.append(age_from)
            elif age_to is not None:
                where.append(f"CAST(`{age_col}` AS SIGNED) <= %s")
                params.append(age_to)

        where_sql = " AND ".join(where)

        # --- Query ---
        sql = f"""
            SELECT {hour_expr} AS hr, COUNT(*) AS cnt
            FROM `{table}`
            WHERE {where_sql}
            GROUP BY hr
            ORDER BY hr
        """
        cur.execute(sql, tuple(params))
        rows = cur.fetchall()
        cur.close(); conn.close()

        counts_by_hr = {int(hr): int(cnt) for hr, cnt in rows}
        hours = list(range(hour_from, hour_to + 1))
        counts = [counts_by_hr.get(h, 0) for h in hours]

        # Title suffix for UI
        suffix_bits = []
        if location: suffix_bits.append(location)
        if gender:   suffix_bits.append(gender.capitalize())
        if day_of_week_raw: suffix_bits.append(f"DOW={','.join(day_of_week_raw)}")
        if alcohol_raw: suffix_bits.append(f"Alcohol={','.join(alcohol_raw)}")
        suffix_bits.append(f"Hours {hour_from}-{hour_to}")
        if age_from is not None or age_to is not None:
            suffix_bits.append(f"Age {age_from if age_from is not None else 0}-{age_to if age_to is not None else '100+'}")
        title_suffix = " · " + " | ".join(suffix_bits) if suffix_bits else ""

        return jsonify(success=True, data={"hours": hours, "counts": counts, "title_suffix": title_suffix}), 200

    except Exception as e:
        return jsonify(success=False, message=f"{type(e).__name__}: {e}"), 500



@api_bp.route("/barangays")
def barangays():
    table = session.get('forecast_table', 'accidents')
    if table not in list_tables():
        return jsonify(success=True, barangays=[])
    try:
        conn = get_db_connection(); cur = conn.cursor()
        cur.execute(f"SELECT DISTINCT BARANGAY FROM `{table}` WHERE BARANGAY IS NOT NULL AND BARANGAY <> ''")
        rows = [r[0] for r in cur.fetchall()]
        cur.close(); conn.close()
        rows = sorted({str(x).strip() for x in rows if x is not None})
        return jsonify(success=True, barangays=rows)
    except Exception as e:
        return jsonify(success=False, barangays=[], message=str(e)), 500


@api_bp.route("/set_forecast_source", methods=["POST"])
def set_forecast_source():
    if not is_logged_in(): return jsonify(success=False, message="Not authorized."), 401
    data = request.get_json(silent=True) or {}; table = (data.get('table') or "").strip()
    if not table: return jsonify(success=False, message="Missing table."), 400
    if table not in list_tables(): return jsonify(success=False, message=f'Unknown table "{table}".'), 400
    session['forecast_table'] = table
    return jsonify(success=True, message=f'"{table}" set as forecast source.')

@api_bp.route("/rf_monthly_forecast", methods=["GET"])
def rf_monthly_forecast():
    if not is_logged_in(): return jsonify(success=False, message="Not authorized."), 401
    table = (request.args.get("table") or "accidents").strip()
    return jsonify(**rf_monthly_payload(table))

@api_bp.route("/folium_map")
def folium_map():
    start   = (request.args.get("start") or "").strip()      # "YYYY-MM"
    end     = (request.args.get("end") or "").strip()        # "YYYY-MM"
    barangay= (request.args.get("barangay") or "").strip()

    # NEW: time range (HH:MM). Fallback to legacy "time".
    time_from = (request.args.get("time_from") or "").strip()  # "07:00"
    time_to   = (request.args.get("time_to") or "").strip()    # "10:00"
    legacy_time = (request.args.get("time") or "").strip()     # "Live" | "All" | "7" etc.

    table = session.get('forecast_table', 'accidents')
    if table not in list_tables():
        return Response("<h4>No data: table not found.</h4>", mimetype='text/html')

    try:
        html = build_forecast_map_html(
            table=table,
            start_str=start,
            end_str=end,
            time_from=time_from,
            time_to=time_to,
            legacy_time=legacy_time,   # keep compatibility
            barangay_filter=barangay
        )
        return Response(html, mimetype='text/html')
    except Exception:
        return Response("<h4>No data available for the selected filters.</h4>", mimetype='text/html')



@api_bp.route("/upload_files", methods=["POST"])
def upload_files():
    if not is_logged_in():
        return jsonify(success=False, message="Not authorized."), 401
    try:
        file1 = request.files.get("file1")
        file2 = request.files.get("file2")
        custom_name = (request.form.get("file_name") or "").strip() or "accidents_processed"

        append_mode = (request.form.get("append_mode") or "0").strip() == "1"
        append_target = (request.form.get("append_target") or "").strip()

        if not file1 or not file2:
            return jsonify(success=False, message="Please select two files."), 400

        if append_mode:
            if not append_target:
                return jsonify(success=False, message="Please choose a target table to append to."), 400
            table_name = append_target
        else:
            table_name = custom_name

        processed, saved = process_merge_and_save_to_db(
            file1, file2,
            table_name=table_name,
            append=append_mode  # NEW
        )
        verb = "Appended to" if append_mode else "Saved to"
        return jsonify(
            success=True,
            message=f"Files merged and {verb} '{table_name}'.",
            rows_saved=int(saved),
            processed_rows=int(processed)
        )
    except Exception as e:
        return jsonify(success=False, message=str(e)), 500

@api_bp.route("/save_table", methods=["POST"])
def save_table():
    if not is_logged_in(): return jsonify({"message":"Not authorized","success":False}), 401
    try:
        headers = request.json.get('headers', []); data = request.json.get('data', [])
        if not headers or not data:
            return jsonify({"message": "No data to save", "success": False}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        try:
            cursor.execute("TRUNCATE TABLE accidents")
            db_column_mapping = {'STATION':'STATION','BARANGAY':'BARANGAY','DATE_COMMITTED':'DATE_COMMITTED','TIME_COMMITTED':'TIME_COMMITTED','OFFENSE':'OFFENSE','LATITUDE':'LATITUDE','LONGITUDE':'LONGITUDE','VICTIM_COUNT':'VICTIM_COUNT','SUSPECT_COUNT':'SUSPECT_COUNT','VEHICLE_KIND':'VEHICLE_KIND','AGE':'AGE','GENDER':'GENDER','ALCOHOL_USED':'ALCOHOL_USED','YEAR':'YEAR','MONTH':'MONTH','DAY':'DAY','WEEKDAY':'WEEKDAY'}
            db_headers = [db_column_mapping.get(h, h) for h in headers]
            quoted_headers = ", ".join([f"`{h}`" for h in db_headers])
            placeholders = ", ".join(["%s"] * len(db_headers))
            insert_query = f"INSERT INTO accidents ({quoted_headers}) VALUES ({placeholders})"
            processed_data=[]
            for row in data:
                processed_row=[]
                for i, value in enumerate(row):
                    if value is None or value == '':
                        processed_row.append(None)
                    elif db_headers[i] in ['LATITUDE','LONGITUDE','VICTIM_COUNT','SUSPECT_COUNT','AGE','YEAR','MONTH','DAY']:
                        try:
                            processed_row.append(float(value) if db_headers[i] in ['LATITUDE','LONGITUDE'] else int(float(value)))
                        except (ValueError, TypeError):
                            processed_row.append(None)
                    elif db_headers[i] in ['DATE_COMMITTED','TIME_COMMITTED']:
                        processed_row.append(str(value) if value else None)
                    else:
                        processed_row.append(str(value) if value else None)
                processed_data.append(tuple(processed_row))
            cursor.executemany(insert_query, processed_data); conn.commit()
            message = f"Table saved to MySQL successfully! {len(processed_data)} rows updated."
        except Exception as e:
            conn.rollback(); message=f"Error: {e}"; return jsonify({"message":message,"success":False}), 500
        finally:
            cursor.close(); conn.close()
        return jsonify({"message": message, "success": True})
    except Exception as e:
        return jsonify({"message": f"Error processing request: {str(e)}", "success": False}), 500

@api_bp.route("/data")
def data():
    if not is_logged_in(): return jsonify({"error":"Not authenticated"}), 401
    try:
        conn = get_db_connection(); cursor = conn.cursor(dictionary=True)
        cursor.execute("""SELECT ROUND(LATITUDE,6) AS lat, ROUND(LONGITUDE,6) AS lng
                          FROM accidents WHERE LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL""")
        rows = cursor.fetchall(); conn.close()
        if not rows: return jsonify([])
        import pandas as pd
        df = pd.DataFrame(rows)
        grouped = df.groupby(['lat','lng']).size().reset_index(name='count')
        return jsonify(grouped.to_dict(orient='records'))
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@api_bp.route("/delete_file", methods=["POST"])
def delete_file():
    if not is_logged_in(): return jsonify({"success":False,"message":"Not authorized"}), 401
    try:
        table_name = request.json.get('table')
        if not table_name: return jsonify({"success": False, "message": "No table specified"}), 400
        conn = get_db_connection(); cursor = conn.cursor()
        cursor.execute(f"DROP TABLE IF EXISTS `{table_name}`;"); conn.commit()
        cursor.close(); conn.close()
        return jsonify({"success": True, "message": f"Table {table_name} deleted successfully."})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@api_bp.route("/retrain_model", methods=["POST"])
def retrain_model():
    return jsonify({"message":"Model retraining completed successfully!"})
