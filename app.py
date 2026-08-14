import os
import libsql_experimental as sqlite3

# Reads from environment variable or falls back to local file
TURSO_URL = os.getenv("TURSO_DATABASE_URL", "data/money.db")
TURSO_TOKEN = os.getenv("TURSO_AUTH_TOKEN", "")

def get_db():
    if TURSO_TOKEN:
        return sqlite3.connect(TURSO_URL, auth_token=TURSO_TOKEN)
    return sqlite3.connect(TURSO_URL)