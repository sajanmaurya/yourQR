# yourQR PostgreSQL data migration (development only)

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

## Runtime PostgreSQL mode: Phase 2B integration

The Express application can now use a PostgreSQL database when `DATABASE_URL` is set. Without it, the original SQLite runtime remains fully supported. Tests run against **PostgreSQL 16**, including a migrated SQLite snapshot and a fresh application database. This is infrastructure-ready code, **not** a hosted deployment.

### Local empty-database startup

1. Create an empty local PostgreSQL database and a least-privileged dedicated role with schema creation privileges.
2. Put `DATABASE_URL=postgresql://yourQR:<password>@127.0.0.1:5432/yourQR` in your **untracked** `.env`. Use `?sslmode=require` and the provider's validated CA settings for remote production.
3. Set `SAAS_MODE=true`. Use `NODE_ENV=development` for a trusted local test, or configure `RESEND_API_KEY`, `MAIL_FROM`, HTTPS `PUBLIC_BASE_URL`, and secure cookies for production.
4. `npm ci && npm run build && npm start`. Startup creates the necessary schema and fails closed if PostgreSQL is unavailable. `GET /api/settings` reports `database: PostgreSQL` to signed-in users.
5. Create accounts and QR codes in the browser. All QR operations, file uploads, sessions, analytics and public redirects now execute against PostgreSQL.

### Existing SQLite data: controlled cutover

**Do not run PostgreSQL with an existing public URL until these checks pass.**

1. Back up the original **stopped** SQLite database (including WAL/shm files). Test restoring it. Back up the destination PostgreSQL database too.
2. Freeze writes and redirects to the old yourQR instance during final cutover. A snapshot while writes continue may miss later scans or QR changes. Arrange a maintenance window.
3. Create a **new empty** PostgreSQL database. Run:
   ```bash
   python3 db/postgres/migrate_sqlite.py --sqlite data/qori.sqlite --dry-run
   python3 db/postgres/migrate_sqlite.py --sqlite data/qori.sqlite
   ```
4. Check table counts, QR slugs, preserved encoded URLs and all uploaded file bytes; test owner/account login and redirects from a local test instance **before** routing users to the new runtime.
5. Keep the same public `PUBLIC_BASE_URL` hostname and `/r/:slug` paths. Point application `DATABASE_URL` at the imported PostgreSQL database; keep `SAAS_MODE` appropriate to the existing accounts. Switch the reverse proxy only after readiness and sample scanned printed codes are verified.
6. Observe traffic, upload access, cookies, redirects and error rates. Keep an untouched SQLite backup. **Rollback** requires stopping writes to PostgreSQL first and restoring the exact prior SQLite snapshot and routing, understanding that data written only to PostgreSQL after cutover will not automatically reappear in SQLite. Plan read-only downtime or a reconciliation process rather than silently losing new customer data.

### Operational notes

- Current uploads are still PostgreSQL `BYTEA` rows, not external R2 objects. This is deliberately transitional and **not ideal for scaling**.
- Local SQLite Wi-Fi rebasing and offline reset scripts are SQLite-only utilities; do not run them against PostgreSQL.
- Do not claim this runtime is safe for public customer traffic until backup/restore, email delivery, abuse handling, quotas, monitoring, and production deployment are verified.
