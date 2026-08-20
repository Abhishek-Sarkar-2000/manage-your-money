import os
import json
import secrets
import traceback
from functools import wraps

from flask import Flask, render_template, request, jsonify, session
from dotenv import load_dotenv

from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_auth_requests

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

load_dotenv()

app = Flask(__name__, template_folder="templates", static_folder="static")

# ---------- Core config ----------
app.secret_key = os.getenv("SECRET_KEY", "default-dev-secret-key")

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()

# Cookie / session hardening. COOKIE_SECURE defaults to True (required for
# SameSite handling over real deployments); set COOKIE_SECURE=false in .env
# only for local http:// development on a non-localhost host.
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=os.getenv("COOKIE_SECURE", "true").lower() == "true",
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,  # 30 days
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,             # 2 MB request cap
)

# ---------- Rate limiting ----------
# storage_uri defaults to in-process memory. If you run gunicorn with more
# than one worker in production, limits are per-worker unless you set
# RATELIMIT_STORAGE_URI to a shared backend (e.g. redis://...).
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    storage_uri=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
    default_limits=["200 per minute"],
)

# ---------- Database Config ----------
TURSO_URL = os.getenv("TURSO_DATABASE_URL", "data/money.db")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "").strip()


def get_db():
    """Connects to Turso cloud if URL/Token are configured, else local SQLite."""
    is_remote = TURSO_URL.startswith("libsql://") or TURSO_URL.startswith("https://")

    if is_remote or TURSO_TOKEN:
        try:
            import libsql_experimental as libsql_driver
        except ImportError:
            import libsql as libsql_driver

        return libsql_driver.connect(TURSO_URL, auth_token=TURSO_TOKEN)
    else:
        import sqlite3
        os.makedirs(os.path.dirname(TURSO_URL) or ".", exist_ok=True)
        return sqlite3.connect(TURSO_URL)


def _table_exists(conn, name):
    try:
        cur = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (name,)
        )
        return cur.fetchone() is not None
    except Exception:
        return False


def migrate_legacy_data(conn, user_id):
    """One-time move of pre-auth data (the old global `storage` table) into
    the new per-user `user_storage` table, owned by the very first Google
    account to ever sign in. Safe no-op if the legacy table doesn't exist
    or is empty."""
    if not _table_exists(conn, "storage"):
        return
    try:
        cur = conn.execute("SELECT key, value FROM storage")
        rows = cur.fetchall()
    except Exception as e:
        print(f"Legacy migration read skipped: {e}")
        return

    for key, value in rows:
        try:
            conn.execute(
                """
                INSERT INTO user_storage (user_id, key, value, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id, key) DO NOTHING
                """,
                (user_id, key, value),
            )
        except Exception as e:
            print(f"Legacy migration row skipped ({key}): {e}")
    conn.commit()
    print(f"Legacy migration: moved {len(rows)} row(s) to user {user_id}")


def init_db():
    """Initializes multi-tenant table schema if not present."""
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
        conn.close()


# Initialize database schema once on startup
_db_initialized = False


@app.before_request
def ensure_db_initialized():
    global _db_initialized
    if not _db_initialized:
        try:
            init_db()
            _db_initialized = True
        except Exception as e:
            print(f"Lazy DB Init Warning: {e}")


# ---------- Security headers ----------
@app.after_request
def set_security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://accounts.google.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; "
        "font-src https://fonts.gstatic.com; "
        "img-src 'self' data: https://*.googleusercontent.com; "
        "connect-src 'self' https://accounts.google.com; "
        "frame-src https://accounts.google.com; "
        "frame-ancestors 'none'"
    )
    if request.is_secure:
        resp.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return resp


# ---------- Auth helpers ----------
def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Authentication required"}), 401
        return fn(*args, **kwargs)
    return wrapper


def get_user_row(conn, user_id):
    cur = conn.execute(
        "SELECT user_id, email, name, picture FROM users WHERE user_id = ?", (user_id,)
    )
    row = cur.fetchone()
    if not row:
        return None
    return {"user_id": row[0], "email": row[1], "name": row[2], "picture": row[3]}


# ---------- Frontend Routes ----------
@app.route("/")
def index():
    return render_template("index.html", google_client_id=GOOGLE_CLIENT_ID)


@app.route("/share/split/<share_id>")
def public_split_page(share_id):
    # Same SPA shell — app.js detects this route and renders the read-only
    # public split viewer via /api/public/split/<share_id>.
    return render_template("index.html", google_client_id=GOOGLE_CLIENT_ID)


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
        idinfo = google_id_token.verify_oauth2_token(
            credential, google_auth_requests.Request(), GOOGLE_CLIENT_ID
        )
    except ValueError:
        return jsonify({"error": "Invalid Google credential"}), 401
    except Exception as e:
        # Network hiccup fetching Google's signing certs, etc.
        print(f"Google token verification failed: {e}")
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

        cur = conn.execute("SELECT COUNT(*) FROM users")
        row = cur.fetchone()
        is_first_user_ever = bool(row and row[0] == 0)

        conn.execute(
            """
            INSERT INTO users (user_id, email, name, picture, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email,
                name = excluded.name,
                picture = excluded.picture,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, email, name, picture),
        )
        conn.commit()

        if is_first_user_ever:
            migrate_legacy_data(conn, user_id)
    except Exception as e:
        print(f"Error in POST /api/auth/google: {e}")
        traceback.print_exc()
        return jsonify({"error": "Could not complete sign-in"}), 500
    finally:
        if conn:
            conn.close()

    session.clear()
    session["user_id"] = user_id
    session["email"] = email
    session.permanent = True

    return jsonify({"user": {"user_id": user_id, "email": email, "name": name, "picture": picture}})

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
    except Exception as e:
        print(f"Error in GET /api/auth/me: {e}")
        return jsonify({"authenticated": False})
    finally:
        if conn:
            conn.close()

    if not user:
        session.clear()
        return jsonify({"authenticated": False})

    return jsonify({"authenticated": True, "user": user})


# ---------- Storage API (scoped to the signed-in user) ----------
@app.route("/api/storage/<path:key>", methods=["GET"])
@login_required
def storage_get(key):
    user_id = session["user_id"]
    conn = None
    try:
        conn = get_db()
        cursor = conn.execute(
            "SELECT value FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key)
        )
        row = cursor.fetchone()
        if not row:
            return jsonify({"error": "Key not found"}), 404
        return jsonify({"key": key, "value": row[0]})
    except Exception as e:
        print(f"Error in GET /api/storage/{key}: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/api/storage/<path:key>", methods=["PUT"])
@login_required
@limiter.limit("120 per minute")
def storage_set(key):
    user_id = session["user_id"]
    conn = None
    try:
        data = request.get_json(force=True, silent=True) or {}
        value = data.get("value")
        if value is None:
            return jsonify({"error": "Missing 'value' field"}), 400

        conn = get_db()
        conn.execute(
            """
            INSERT INTO user_storage (user_id, key, value, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, key) DO UPDATE SET
                value = excluded.value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, key, value),
        )
        conn.commit()
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"Error in PUT /api/storage/{key}: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

@app.route("/api/storage/<path:key>", methods=["DELETE"])
@login_required
def storage_delete(key):
    user_id = session["user_id"]
    conn = None
    try:
        conn = get_db()
        conn.execute(
            "DELETE FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key)
        )
        conn.commit()
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"Error in DELETE /api/storage/{key}: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

            
# ---------- Split sharing API ----------
def _is_split_key(key):
    return isinstance(key, str) and key.startswith("split:") and len(key) > len("split:")


@app.route("/api/split/share", methods=["POST"])
@login_required
@limiter.limit("30 per minute")
def split_share_create():
    user_id = session["user_id"]
    body = request.get_json(silent=True) or {}
    key = body.get("key")
    if not _is_split_key(key):
        return jsonify({"error": "Invalid or missing split 'key'"}), 400

    conn = None
    try:
        conn = get_db()

        # Caller must own this split.
        owns = conn.execute(
            "SELECT 1 FROM user_storage WHERE user_id = ? AND key = ?", (user_id, key)
        ).fetchone()
        if not owns:
            return jsonify({"error": "Split group not found"}), 404

        # Reuse an existing link if one was already generated for this split.
        existing = conn.execute(
            "SELECT share_id FROM public_splits WHERE owner_user_id = ? AND split_key = ?",
            (user_id, key),
        ).fetchone()
        if existing:
            share_id = existing[0]
        else:
            share_id = secrets.token_urlsafe(9)
            # Extremely unlikely, but guard against a share_id collision.
            while conn.execute(
                "SELECT 1 FROM public_splits WHERE share_id = ?", (share_id,)
            ).fetchone():
                share_id = secrets.token_urlsafe(9)

            conn.execute(
                """
                INSERT INTO public_splits (share_id, owner_user_id, split_key, created_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (share_id, user_id, key),
            )
            conn.commit()

        return jsonify({
            "share_id": share_id,
            "url": request.url_root.rstrip("/") + "/share/split/" + share_id,
        })
    except Exception as e:
        print(f"Error in POST /api/split/share: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/api/split/share", methods=["DELETE"])
@login_required
def split_share_revoke():
    """Lets an owner revoke a previously generated public link."""
    user_id = session["user_id"]
    body = request.get_json(silent=True) or {}
    key = body.get("key")
    if not _is_split_key(key):
        return jsonify({"error": "Invalid or missing split 'key'"}), 400

    conn = None
    try:
        conn = get_db()
        conn.execute(
            "DELETE FROM public_splits WHERE owner_user_id = ? AND split_key = ?",
            (user_id, key),
        )
        conn.commit()
        return jsonify({"success": True})
    except Exception as e:
        print(f"Error in DELETE /api/split/share: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


@app.route("/api/public/split/<share_id>", methods=["GET"])
@limiter.limit("60 per minute")
def public_split_get(share_id):
    conn = None
    try:
        conn = get_db()

        link = conn.execute(
            "SELECT owner_user_id, split_key FROM public_splits WHERE share_id = ?",
            (share_id,),
        ).fetchone()
        if not link:
            return jsonify({"error": "This share link is invalid or has been revoked"}), 404
        owner_user_id, split_key = link[0], link[1]

        data_row = conn.execute(
            "SELECT value FROM user_storage WHERE user_id = ? AND key = ?",
            (owner_user_id, split_key),
        ).fetchone()
        if not data_row:
            return jsonify({"error": "This split group no longer exists"}), 404

        owner = get_user_row(conn, owner_user_id)
        owner_name = (owner or {}).get("name") or "The owner"
        owner_picture = (owner or {}).get("picture") or ""

        try:
            group = json.loads(data_row[0])
        except (TypeError, ValueError):
            return jsonify({"error": "Corrupt split data"}), 500

        return jsonify({
            "group": group,
            "owner": {"name": owner_name, "picture": owner_picture},
        })
    except Exception as e:
        print(f"Error in GET /api/public/split/{share_id}: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    app.run(debug=True, port=5000)
