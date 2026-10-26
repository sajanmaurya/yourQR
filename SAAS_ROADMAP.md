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
