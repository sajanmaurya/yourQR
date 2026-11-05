# Clerk authentication for yourQR

yourQR supports Clerk with the official React and Express SDKs. The glass interface and all workspace data remain in yourQR; Clerk manages authentication, email verification, sessions and its account menu.

## Enable

1. Create an application named **yourQR** in the Clerk dashboard. Enable email sign-in and email verification. Enable social providers there if wanted.
2. Set these environment variables locally in `.env`, or in the matching Vercel project environment:

   ```dotenv
   AUTH_PROVIDER=clerk
   CLERK_PUBLISHABLE_KEY=pk_test_...
   CLERK_SECRET_KEY=sk_test_...
   ```

3. Keep `PUBLIC_BASE_URL` set to the exact app origin. The backend restricts Clerk token authorized parties to this origin (and local development origins outside production).
4. Restart locally or redeploy Vercel. No build-time Clerk key is needed: `/api/auth/config` supplies the publishable key. The secret stays on the server.
5. Test sign-up with a verified email, sign-in, logout, PDF upload, download and a second account's isolation. For public launch use a claimed production Clerk instance, its live keys, configured domain/DNS and provider settings. Temporary or test keys are for development/trials.

Never commit `.env` or paste secret keys into issues or chat. An explicit `AUTH_PROVIDER=clerk` with missing keys fails at startup rather than silently opening local authentication.

## Existing accounts

Clerk identities map to the same numeric `users.id` through the new `clerk_identities` table. Codes, folders, assets, public slugs and scans keep their IDs and ownership. Signing in with a verified email matching an old account prompts for the **previous yourQR password once**. A matching email alone does not link a workspace. A successful link revokes old local sessions. New Clerk users have no usable local password. Existing password hashes remain only to support this explicit migration.

If the previous password is lost, contact the administrator for the existing offline recovery procedure before linking; do not assign workspace ownership based on an unverified email. Switching Clerk instances requires an explicit administrative migration of identity mappings, not automatic relinking.

## Routes and security

- Clerk's hash-routed SignIn and SignUp components provide registration, sign-in and configured recovery/social flows. The visible logout button invokes Clerk signOut, and UserButton provides account management.
- Express verifies Clerk cookies/bearer tokens with `clerkMiddleware` and `getAuth`. The browser sends a fresh Clerk bearer token on API requests, downloads and file uploads.
- Local register/login/setup/logout endpoints are disabled in Clerk mode; an old local cookie cannot authenticate there.
- Provisioning requires a verified primary email. A unique identity mapping prevents one workspace being claimed by multiple Clerk identities.
- Existing resource authorization still uses the internal user ID. Public active QR redirects/file links stay public for scanning.
- Production CSP permits the configured Clerk host and Clerk/Cloudflare widgets without allowing arbitrary script hosts.
- `AUTH_PROVIDER=local` preserves offline self-hosting and the original local login. Back up the database before a production cutover.

## Validation boundaries

`npm test` covers provisioning, local endpoint shutdown, unverified email rejection, data isolation, password-confirmed linking, session revocation and CSP with an injected test identity adapter. These tests do not prove Clerk dashboard configuration or a real hosted sign-in. Complete the live flows above with actual Clerk keys before declaring the rollout verified.
