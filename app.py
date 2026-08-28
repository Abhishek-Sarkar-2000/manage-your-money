import os
import json
import secrets
import traceback
import threading
from functools import wraps
import re

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from dotenv import load_dotenv

from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_auth_requests

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_compress import Compress

load_dotenv()

app = Flask(__name__, template_folder="templates", static_folder="static")
Compress(app)

# ---------- Core config ----------
app.secret_key = os.getenv("SECRET_KEY", "default-dev-secret-key")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "true").lower() == "true",
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
    SEND_FILE_MAX_AGE_DEFAULT=31536000,
)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    storage_uri=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
    default_limits=["200 per minute"],
)

# ---------- Database Config ----------
TURSO_URL = os.getenv("TURSO_DATABASE_URL", "data/money.db")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()

_conn_lock = threading.Lock()
_shared_remote_conn = None

def get_db():
    global _shared_remote_conn
    is_remote = TURSO_URL.startswith("libsql://") or TURSO_URL.startswith("https://")
    if is_remote or TURSO_TOKEN:
        if _shared_remote_conn is None:
            with _conn_lock:
                if _shared_remote_conn is None:
                    try:
                        import libsql_experimental as libsql_driver
                    except ImportError:
                        import libsql as libsql_driver
                    _shared_remote_conn = libsql_driver.connect(TURSO_URL, auth_token=TURSO_TOKEN)
        return _shared_remote_conn
    else:
        import sqlite3
        os.makedirs(os.path.dirname(TURSO_URL) or ".", exist_ok=True)
        return sqlite3.connect(TURSO_URL, check_same_thread=False)

def close_db(conn):
    # Never close the shared remote connection — only local sqlite ones opened per-request.
    if conn is not None and conn is not _shared_remote_conn:
        conn.close()

def init_db():
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                email TEXT,
                name TEXT,
                picture TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_storage (
                user_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, key)
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS public_splits (
                share_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                split_key TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (owner_user_id, split_key)
            );
            """
        )
        conn.commit()
    finally:
        close_db(conn)

_db_initialized = False

@app.before_request
def ensure_db_initialized():
    global _db_initialized
    if not _db_initialized:
        try:
            init_db()
            _db_initialized = True
        except Exception:
            pass

@app.after_request
def set_security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://accounts.google.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: https://*.googleusercontent.com; "
        "connect-src 'self' https://accounts.google.com; "
        "frame-src https://accounts.google.com; "
        "frame-ancestors 'none'"
    )
    if request.is_secure:
        resp.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return resp

def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Authentication required"}), 401
        return fn(*args, **kwargs)
    return wrapper

def get_user_row(conn, user_id):
    cur = conn.execute("SELECT user_id, email, name, picture FROM users WHERE user_id = ?", (user_id,))
    row = cur.fetchone()
    return {"user_id": row[0], "email": row[1], "name": row[2], "picture": row[3]} if row else None


# ---------- Frontend Routes (MPA Setup) ----------
def _shell_context(active_route):
    return {
        "google_client_id": GOOGLE_CLIENT_ID,
        "active_route": active_route,
        "is_shared": False,
        "static_version": os.getenv("STATIC_VERSION", "1"),
    }

@app.route("/")
@app.route("/home")
def home():
    return render_template("home.html", **_shell_context("home"))

@app.route("/months")
def months_archive():
    return render_template("months.html", **_shell_context("months"))

@app.route("/month/<month_key>")
def month_view(month_key):
    if not re.match(r"^\d{4}-\d{2}$", month_key):
        return redirect(url_for("months_archive"))
    return render_template("month.html", month_key=month_key, **_shell_context("month"))

@app.route("/cards")
def cards_view():
    return render_template("cards.html", **_shell_context("cards"))

@app.route("/sips")
def sips_view():
    return render_template("sips.html", **_shell_context("sips"))

@app.route("/split")
def split_view():
    return render_template("split.html", **_shell_context("split"))

@app.route("/pricetrack")
def pricetrack_view():
    return render_template("pricetrack.html", **_shell_context("pricetrack"))

@app.route("/share/split/<share_id>")
def public_split_page(share_id):
    return render_template(
        "share_split.html",
        share_id=share_id,
        google_client_id=GOOGLE_CLIENT_ID,
        active_route="share-split",
        is_shared=True,
    )

# ---------- Auth API ----------
@app.route("/api/auth/google", methods=["POST"])
@limiter.limit("10 per minute")
def auth_google():
    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "Server missing GOOGLE_CLIENT_ID"}), 500

    body = request.get_json(silent=True) or {}
    credential = body.get("credential")
    if not credential:
        return jsonify({"error": "Missing 'credential'"}), 400

    try:
        idinfo = google_id_token.verify_oauth2_token(credential, google_auth_requests.Request(), GOOGLE_CLIENT_ID)
    except ValueError:
        return jsonify({"error": "Invalid Google credential"}), 401
    except Exception:
        return jsonify({"error": "Could not verify credential right now, try again"}), 503

    if idinfo.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        return jsonify({"error": "Invalid token issuer"}), 401
    if not idinfo.get("email_verified", True):
        return jsonify({"error": "Google email not verified"}), 401

    user_id = idinfo["sub"]
    email = idinfo.get("email", "")
    name = idinfo.get("name") or email or "User"
    picture = idinfo.get("picture", "")

    conn = None
    try:
        conn = get_db()

        # Was this specific user_id already in `users` before this request?
        # This is what tells the frontend whether it's safe to migrate the
        # guest's localStorage data up (brand-new signup) or whether doing
        # so would risk clobbering/duplicating an existing cloud account's
        # data (returning user, signing in on a new/cleared browser).
        existing_user_row = conn.execute(
            "SELECT 1 FROM users WHERE user_id = ?", (user_id,)
        ).fetchone()
        is_new_user = existing_user_row is None

        conn.execute(
            """
            INSERT INTO users (user_id, email, name, picture, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, email, name, picture),
        )
        conn.commit()
    except Exception:
        traceback.print_exc()
        return jsonify({"error": "Could not complete sign-in"}), 500
    finally:
        if conn:
            close_db(conn)

    session.clear()
    session["user_id"] = user_id
    session["email"] = email
    session.permanent = True

    return jsonify({
        "user": {"user_id": user_id, "email": email, "name": name, "picture": picture},
        "isNewUser": is_new_user,
    })

@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"success": True})

@app.route("/api/auth/me", methods=["GET"])
def auth_me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"authenticated": False})

    conn = None
    try:
        conn = get_db()
        user = get_user_row(conn, user_id)
    except Exception:
        return jsonify({"authenticated": False})
    finally:
        if conn:
            close_db(conn)

    if not user:
        session.clear()
        return jsonify({"authenticated": False})

    return jsonify({"authenticated": True, "user": user})


# ---------- Storage API ----------

# <-- NEW: BULK FETCH API TO PREVENT N+1 QUERIES -->
@app.route("/api/storage/bulk", methods=["POST"])
@login_required
@limiter.limit("60 per minute")
def storage_get_bulk():
    user_id = session["user_id"]
    data = request.get_json(silent=True) or {}
    keys = data.get("keys", [])
    
    if not keys or not isinstance(keys, list):
        return jsonify({"error": "Missing or invalid 'keys' array"}), 400

    conn = None
    try:
        conn = get_db()
        placeholders = ",".join("?" * len(keys))
        query = f"SELECT key, value FROM user_storage WHERE user_id = ? AND key IN ({placeholders})"
        
        # SQLite parameters must be a single flat list: [user_id, key1, key2...]
        rows = conn.execute(query, [user_id] + keys).fetchall()
        
        result = {}
        for row in rows:
            try:
                result[row[0]] = json.loads(row[1])
            except json.JSONDecodeError:
                pass # Skip corrupt rows safely
                
        return jsonify(result)
    except Exception as e:
        print(f"Error in POST /api/storage/bulk: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            close_db(conn)

@app.route("/api/storage/<path:key>", methods=["GET"])
@login_required
def storage_get(key):
    user_id = session["user_id"]
    conn = None
    try:
        conn = get_db()
        row = conn.execute("SELECT value FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key)).fetchone()
        if not row:
            return jsonify({"error": "Key not found"}), 404
        return jsonify({"key": key, "value": row[0]})
    finally:
        close_db(conn)

@app.route("/api/storage/<path:key>", methods=["PUT"])
@login_required
@limiter.limit("120 per minute")
def storage_set(key):
    user_id = session["user_id"]
    data = request.get_json(force=True, silent=True) or {}
    value = data.get("value")
    if value is None: return jsonify({"error": "Missing 'value' field"}), 400

    conn = None
    try:
        conn = get_db()
        conn.execute(
            """
            INSERT INTO user_storage (user_id, key, value, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, key, value),
        )
        conn.commit()
        return jsonify({"success": True, "key": key})
    finally:
        close_db(conn)

@app.route("/api/storage/<path:key>", methods=["DELETE"])
@login_required
def storage_delete(key):
    user_id = session["user_id"]
    conn = None
    try:
        conn = get_db()
        conn.execute("DELETE FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key))
        conn.commit()
        return jsonify({"success": True, "key": key})
    finally:
        close_db(conn)

# ---------- Split sharing API ----------
def _is_split_key(key):
    return isinstance(key, str) and key.startswith("split:") and len(key) > len("split:")

@app.route("/api/split/share", methods=["POST"])
@login_required
@limiter.limit("30 per minute")
def split_share_create():
    user_id = session["user_id"]
    key = (request.get_json(silent=True) or {}).get("key")
    if not _is_split_key(key): return jsonify({"error": "Invalid split key"}), 400

    conn = None
    try:
        conn = get_db()
        if not conn.execute("SELECT 1 FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key)).fetchone():
            return jsonify({"error": "Split group not found"}), 404

        existing = conn.execute("SELECT share_id FROM public_splits WHERE owner_user_id = ? AND split_key = ?", (user_id, key)).fetchone()
        if existing:
            share_id = existing[0]
        else:
            share_id = secrets.token_urlsafe(9)
            while conn.execute("SELECT 1 FROM public_splits WHERE share_id = ?", (share_id,)).fetchone():
                share_id = secrets.token_urlsafe(9)

            conn.execute("INSERT INTO public_splits (share_id, owner_user_id, split_key) VALUES (?, ?, ?)", (share_id, user_id, key))
            conn.commit()

        return jsonify({"share_id": share_id, "url": request.url_root.rstrip("/") + "/share/split/" + share_id})
    finally:
        close_db(conn)

@app.route("/api/split/share", methods=["DELETE"])
@login_required
def split_share_revoke():
    user_id = session["user_id"]
    key = (request.get_json(silent=True) or {}).get("key")
    if not _is_split_key(key): return jsonify({"error": "Invalid split key"}), 400

    conn = None
    try:
        conn = get_db()
        conn.execute("DELETE FROM public_splits WHERE owner_user_id = ? AND split_key = ?", (user_id, key))
        conn.commit()
        return jsonify({"success": True})
    finally:
        close_db(conn)

@app.route("/api/public/split/<share_id>", methods=["GET"])
@limiter.limit("60 per minute")
def public_split_get(share_id):
    conn = None
    try:
        conn = get_db()
        link = conn.execute("SELECT owner_user_id, split_key FROM public_splits WHERE share_id = ?", (share_id,)).fetchone()
        if not link: return jsonify({"error": "This share link is invalid or revoked"}), 404
        
        data_row = conn.execute("SELECT value FROM user_storage WHERE user_id = ? AND key = ?", (link[0], link[1])).fetchone()
        if not data_row: return jsonify({"error": "This split group no longer exists"}), 404

        owner = get_user_row(conn, link[0])
        return jsonify({
            "group": json.loads(data_row[0]),
            "owner": {"name": (owner or {}).get("name") or "The owner", "picture": (owner or {}).get("picture") or ""},
        })
    finally:
        close_db(conn)

if __name__ == "__main__":
    app.run(debug=True, port=5000)