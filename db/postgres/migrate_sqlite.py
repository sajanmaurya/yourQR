#!/usr/bin/env python3
"""Snapshot a Qori SQLite workspace and COPY it transactionally into an EMPTY PostgreSQL database.

Requirements: Python 3 stdlib, psql command-line client, PostgreSQL server.
The running Qori API continues using SQLite until a separate adapter/cutover is built.
"""
import argparse
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from urllib.parse import quote

COLUMNS = {
    "owner": "id name email password_hash created_at",
    "accounts": "id name email password_hash created_at verified_at",
    "sessions": "token_hash owner_id expires_at",
    "account_sessions": "token_hash account_id expires_at",
    "email_verifications": "account_id token_hash expires_at",
    "password_resets": "account_id token_hash expires_at",
    "settings": "key value",
    "folders": "id name color created_at owner_key",
    "assets": "id kind name mime size bytes created_at owner_key",
    "qr_codes": "id name type content_type destination encoded_value slug fg_color bg_color logo_data_url folder_id active created_at updated_at category payload_json asset_id owner_key",
    "scans": "id qr_id scanned_at visitor_hash device referrer",
}


def csv_field(value):
    if value is None:
        return r"\N"
    if isinstance(value, bytes):
        value = r"\x" + value.hex()
    return '"' + str(value).replace('"', '""') + '"'


def snapshot(source, output):
    # SQLite online backup gives one consistent point-in-time image even under WAL.
    uri = "file:" + quote(str(source.resolve()), safe="/") + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as source_db, sqlite3.connect(output) as copy:
        source_db.backup(copy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", required=True, type=Path, help="Existing SQLite database path")
    parser.add_argument("--dry-run", action="store_true", help="Validate source and show row counts only")
    args = parser.parse_args()
    if not args.sqlite.is_file():
        parser.error("SQLite database does not exist. Source will not be created.")
    if not args.dry_run and not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL is required for PostgreSQL import.")
    if not args.dry_run and not shutil.which("psql"):
        parser.error("Install the PostgreSQL psql CLI first.")
    schema = Path(__file__).parent / "schema.sql"
    with tempfile.TemporaryDirectory(prefix="qori-pg-migration-") as temporary:
        directory = Path(temporary)
        db_path = directory / "source.sqlite"
        snapshot(args.sqlite, db_path)
        connection = sqlite3.connect(db_path)
        connection.row_factory = sqlite3.Row
        try:
            errors = connection.execute("PRAGMA foreign_key_check").fetchall()
            if errors:
                raise RuntimeError("Source has foreign key violations. Refusing migration.")
            counts = {}
            for table, column_string in COLUMNS.items():
                cols = column_string.split()
                existing = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
                missing = set(cols) - existing
                if missing and not (table == "accounts" and missing == {"verified_at"}):
                    raise RuntimeError("Missing SQLite fields in " + table + ": " + repr(missing))
                counts[table] = connection.execute("SELECT count(*) FROM " + table).fetchone()[0]
            owners = {row[0] for row in connection.execute("SELECT id FROM accounts")}
            invalid_owners = set()
            for table in ("folders", "assets", "qr_codes"):
                invalid_owners |= {row[0] for row in connection.execute("SELECT DISTINCT owner_key FROM " + table)
                                   if row[0] != "legacy" and row[0] not in owners}
            if invalid_owners:
                raise RuntimeError("Rows reference nonexistent account workspaces. Refusing migration.")
            for table, n in counts.items():
                print(f"{table}: {n} row(s)")
            if args.dry_run:
                print("Dry run passed. PostgreSQL was not touched.")
                return
            # A single psql connection and transaction: any copy/validation failure rolls back.
            script = directory / "import.sql"
            with script.open("w", encoding="utf-8") as instructions:
                instructions.write("BEGIN;\n")
                instructions.write(schema.read_text(encoding="utf-8") + "\n")
                all_tables = ", ".join(COLUMNS) + ", workspaces, workspace_memberships"
                instructions.write("DO $guard$ BEGIN IF EXISTS (SELECT 1 FROM accounts) OR EXISTS (SELECT 1 FROM qr_codes) OR EXISTS (SELECT 1 FROM workspaces) OR EXISTS (SELECT 1 FROM owner) OR EXISTS (SELECT 1 FROM assets) OR EXISTS (SELECT 1 FROM folders) OR EXISTS (SELECT 1 FROM scans) OR EXISTS (SELECT 1 FROM sessions) OR EXISTS (SELECT 1 FROM account_sessions) OR EXISTS (SELECT 1 FROM email_verifications) OR EXISTS (SELECT 1 FROM password_resets) OR EXISTS (SELECT 1 FROM settings) OR EXISTS (SELECT 1 FROM workspace_memberships) THEN RAISE EXCEPTION 'Target database is not empty'; END IF; END $guard$;\n")
                for table, column_string in COLUMNS.items():
                    if table == "folders":
                        instructions.write("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES ('legacy','Personal legacy workspace',NULL,now()::text);\n")
                        instructions.write("INSERT INTO workspaces(id,name,owner_account_id,created_at) SELECT id,name || ' workspace',id,created_at FROM accounts;\n")
                        instructions.write("INSERT INTO workspace_memberships(workspace_id,account_id,role) SELECT id,id,'owner' FROM accounts;\n")
                    cols = column_string.split()
                    existing = {row[1] for row in connection.execute("PRAGMA table_info(" + table + ")")}
                    filename = directory / (table + ".csv")
                    with filename.open("w", encoding="utf-8", newline="") as writer:
                        sql = "SELECT " + ", ".join((col if col in existing else "NULL AS " + col) for col in cols) + " FROM " + table
                        for row in connection.execute(sql):
                            writer.write(",".join(csv_field(item) for item in row) + "\n")
                    # Directory is created by tempfile, no embedded quote in generated basename.
                    safe_path = str(filename).replace("'", "''")
                    instructions.write(f"\\copy {table} ({', '.join(cols)}) FROM '{safe_path}' WITH (FORMAT csv, NULL '\\N')\n")
                for table, count in counts.items():
                    instructions.write(f"DO $check$ BEGIN IF (SELECT count(*) FROM {table}) != {count} THEN RAISE EXCEPTION 'Row count mismatch for {table}'; END IF; END $check$;\n")
                instructions.write("COMMIT;\n")
            environment = dict(os.environ)
            # Avoid printing a connection string containing credentials.
            result = subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "--dbname", environment["DATABASE_URL"], "--file", str(script)], env=environment, check=False)
            if result.returncode != 0:
                raise RuntimeError("PostgreSQL transaction failed and was rolled back. Source remains unchanged.")
            print("PostgreSQL import committed. Verify application behavior before any cutover.")
        finally:
            connection.close()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, sqlite3.Error, OSError) as exc:
        print("Migration error:", exc, file=sys.stderr)
        sys.exit(1)
