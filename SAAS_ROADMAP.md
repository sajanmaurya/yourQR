# Qori SaaS foundation status

## Implemented on saas-development

- Existing React, Express, QR rendering and all 19 content types are retained.
- Opt-in SAAS_MODE=true enables multiple independent customer accounts, registration, login and logout.
- Sessions are isolated; old local owner's account and data remain in the legacy workspace.
- QR records, folders and uploaded assets have server-enforced ownership.
- QR listing, editing, downloads, folder operations, asset upload and previews, analytics and JSON export are scoped by workspace.
- Public QR slugs remain globally unique. Public redirects intentionally do not require login.
- Automated cross-account isolation tests plus existing personal-workspace tests.
- Existing SQLite rows are migrated additively and folder names become unique within workspaces, not globally.

## Do not advertise or publicly deploy this as a finished SaaS

This milestone deliberately retains SQLite and uses passwords + server sessions. It is not the PostgreSQL/Drizzle migration, managed-hosting deployment or paid subscription product yet. The following are launch blockers:

1. Verify email ownership and add secure recovery/verification mail.
2. Introduce a real workspace/membership model and invite permissions for team plans.
3. PostgreSQL migration with import, backups, rollback and concurrency testing.
4. Migrate binary uploads out of SQLite to object storage (R2/S3) and add scanning, upload quotas and legal abuse-response process.
5. Permanent HTTPS redirect domain, redirect uptime monitoring, backup testing and incident procedures.
6. Distributed rate limiting, abuse detection and expiry/deletion policies for analytics.
7. Razorpay billing with idempotent webhook processing, plan enforcement and billing support.
8. Accessibility/security review and production test coverage.

**Local test:** Node 24+, npm ci, copy .env.example to .env, set SAAS_MODE=true, npm run build, npm start. Open http://localhost:8787. Register two different accounts and verify they cannot read each other's workspace.

**Default:** SAAS_MODE=false keeps personal-owner behavior. Never copy production databases to a public demo without reviewing personal content and account data.

## Phase 2: In progress (PostgreSQL + verified identity)

Implemented on this branch:
- PostgreSQL schema in `db/postgres/schema.sql`, with user-owned workspaces and membership rows.
- Python/psql SQLite snapshot importer in `db/postgres/migrate_sqlite.py`. Transactions, count validation, empty-target checks, binary byte preservation and test-only fixtures are covered by GitHub Actions.
- Production SaaS registrations require single-use expiring email confirmation before login.
- Password reset uses single-use hashed tokens, 30-minute expiry, and invalidates all existing account sessions when used.
- Resend verification and reset links through Resend REST email provider (bring your own verified sender and credentials).
- CI runs Node backend/lint/build and a real PostgreSQL service import test.

`SAAS_MODE=true` remains an experimental flag. Development/test deliberately skip mandatory verification unless `requireEmailVerification` is enabled in test or `NODE_ENV=production`. Real production SaaS requires `RESEND_API_KEY`, `MAIL_FROM`, and a permanent HTTPS `PUBLIC_BASE_URL`.

**Not implemented yet:** Express still runs on SQLite. Importing PostgreSQL data **does not switch API traffic**. No PostgreSQL application adapter/cutover, production mail delivery verification, managed database account, deployment, R2 storage, or billing yet. Never claim this is launched or ready for public customer data.

## Phase 2B: PostgreSQL runtime implemented and tested

- Node's `pg` pool is used when `DATABASE_URL` is configured. Without that variable, SQLite remains the default.
- The original Express API has been adapted to async database operations: owner/account auth, verification/reset tokens, workspaces, QR and asset creation/editing, dynamic redirects, folders, scan aggregation, and exports.
- PostgreSQL initial schema is provisioned during server startup. Signup creates an account-owned workspace and membership atomically.
- GitHub CI performs independent legacy SQLite tests, production frontend lint/build, PostgreSQL 16 snapshot import, empty database runtime CRUD/redirect tests, and post-import continuity tests.
- Keep the same URL origin during cutover and freeze old writes before taking the final copy. Refer to `db/postgres/README.md` for rollback details.

**Still not a public launch:** no managed Postgres deployment, CDN/short-link uptime guarantees, email delivery verification, object storage migration, rate limiting across replicas, or paid billing.
