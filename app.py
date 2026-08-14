import os
import json
from flask import Flask, render_template, request, jsonify, send_from_directory
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-key-change-in-production")

# ---------- Database Connection ----------
TURSO_URL = os.getenv("TURSO_DATABASE_URL", "data/money.db")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "")

def get_db():
    """Connects to Turso in the cloud if token is present, 
    otherwise falls back to local SQLite for offline development."""
    if TURSO_TOKEN:
        import libsql_experimental as sqlite3
        conn = sqlite3.connect(TURSO_URL, auth_token=TURSO_TOKEN)
    else:
        import sqlite3
        os.makedirs("data", exist_ok=True)
        conn = sqlite3.connect(TURSO_URL)
    
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()

# Initialize tables on boot
try:
    init_db()
except Exception as e:
    print(f"Database initialization warning: {e}")

# ---------- Frontend Route ----------
@app.route("/")
def index():
    return render_template("index.html")

# ---------- Storage API (Used by app.js) ----------
@app.route("/api/storage/<path:key>", methods=["GET"])
def storage_get(key):
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM storage WHERE key = ?", (key,)).fetchone()
            if not row:
                return jsonify({"error": "Key not found"}), 404
            return jsonify({"key": key, "value": row["value"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/storage/<path:key>", methods=["PUT"])
def storage_set(key):
    try:
        data = request.get_json(force=True)
        value = data.get("value")
        if value is None:
            return jsonify({"error": "Missing 'value' field"}), 400

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO storage (key, value, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (key, value)
            )
            conn.commit()
        return jsonify({"success": True, "key": key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)