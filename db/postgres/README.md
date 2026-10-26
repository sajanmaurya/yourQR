# Qori PostgreSQL data migration (development only)

This folder contains the **PostgreSQL schema and snapshot importer** for the future SaaS application. The current Express app still uses SQLite. A successful import does not switch runtime storage.

## Requirements

- Python 3, with standard `sqlite3` module
- PostgreSQL server and `psql` CLI installed
- Source SQLite database (e.g. `data/qori.sqlite`), which is only read
- **Dedicated, empty** destination PostgreSQL database

Set `DATABASE_URL` to the PostgreSQL connection URI using a secret environment variable. Use TLS for remote databases. Never commit credentials or put them in CLI scripts.

```bash
python3 db/postgres/migrate_sqlite.py --sqlite data/qori.sqlite --dry-run
python3 db/postgres/migrate_sqlite.py --sqlite data/qori.sqlite
```

The importer uses SQLite's online backup API to create one point-in-time copy and streams its rows into CSV. It executes schema creation, workspace seed rows, COPY imports, and record-count checks in **one PostgreSQL transaction**. It rejects nonempty destination databases. A failure rolls back PostgreSQL changes. It does not modify the SQLite source.

Notes:
- Existing `legacy` personal records remain distinct from SaaS customer workspaces.
- Accounts map to their own workspaces with an `owner` membership. Existing UUID/text identifiers and redirect slugs are preserved.
- Uploaded file BLOBs become PostgreSQL BYTEA values without loss.
- Pending email-verification and password-reset records are migrated as well, but should be reissued when changing domains or authentication backend.
- A source database with missing tables or broken foreign keys is rejected; do not manually delete columns to force the migration.
- A successful database import is **not** a production cutover. Until the Express database adapter supports PostgreSQL, continue serving the original SQLite database and keep both backups.

CI uses an isolated PostgreSQL 16 service and synthetic SQLite fixture to exercise this path. Production migration needs rehearsal with a restored copy of the real database, downtime strategy, delta synchronization, final backup, rollback runbook, and checked public redirect continuity.
