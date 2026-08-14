import os
import traceback
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.getenv("SECRET_KEY", "default-dev-secret-key")

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

def init_db():
    """Ensures the storage table exists."""
    conn = get_db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS storage (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()
    finally:
        conn.close()

# Run table creation on startup
try:
    init_db()
    print("Database table 'storage' initialized successfully.")
except Exception as e:
    print(f"Database startup warning: {e}")
    traceback.print_exc()

# ---------- Frontend Route ----------
@app.route("/")
def index():
    return render_template("index.html")

# ---------- Storage API ----------
@app.route("/api/storage/<path:key>", methods=["GET"])
def storage_get(key):
    try:
        init_db()
        conn = get_db()
        try:
            cursor = conn.execute("SELECT value FROM storage WHERE key = ?", (key,))
            row = cursor.fetchone()
            if not row:
                return jsonify({"error": "Key not found"}), 404
            return jsonify({"key": key, "value": row[0]})
        finally:
            conn.close()
    except Exception as e:
        print(f"Error in GET /api/storage/{key}: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/storage/<path:key>", methods=["PUT"])
def storage_set(key):
    try:
        init_db()
        data = request.get_json(force=True)
        value = data.get("value")
        if value is None:
            return jsonify({"error": "Missing 'value' field"}), 400

        conn = get_db()
        try:
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
        finally:
            conn.close()
            
        return jsonify({"success": True, "key": key})
    except Exception as e:
        print(f"Error in PUT /api/storage/{key}: {e}")
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(debug=True, port=5000)