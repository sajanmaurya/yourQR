# yourQR on Vercel: staging checklist

## Hosting decision

yourQR's **React/Vite frontend and Node.js/Express API** will be deployed in a single Vercel project, connecting to managed Neon PostgreSQL. The repository is **prepared**, but is **not linked to your Vercel account or deployed yet**. Work in the `saas-development` branch / draft PR.

Vercel recognizes the root `index.js` default export as an Express entrypoint. It runs in a Vercel Function; `npm run build:vercel` builds the Vite client and stages it to `public/` for Vercel's CDN. No `app.listen()` is called in that serverless entrypoint. Vercel ignores `express.static()`, so Vite assets cannot be served from Express there.

## Before deploying any public preview

1. Create a **separate Neon PostgreSQL database/branch for staging**; never connect previews to production customer data.
2. In Vercel, import GitHub `sajanmaurya/yourQR` and choose `saas-development` as the non-production development source. Confirm framework **Express**, root directory the repository root, and build command `npm run build:vercel`. Check Vercel recognizes `index.js` as the function entry.
3. Configure **server-side** project secrets (never `VITE_` values):
   - `DATABASE_URL` = Neon pooled PostgreSQL URL with correctly configured TLS and least-privilege credentials.
   - `PUBLIC_BASE_URL` = the final, stable `https://` origin where the QR links will live. Do not use a disposable preview URL for printed QR codes.
   - `SAAS_MODE=true` (only once verified login setup, terms, and abuse protections are ready).
   - `RESEND_API_KEY`, `MAIL_FROM` = verified sender account, required for production SaaS registration.
   - Keep `COOKIE_SECURE=true`. `TRUST_PROXY` depends on deployment network trust, default 0 unless verified.
4. Ensure no existing active QR references assets larger than 4 MB. Vercel Functions have a **4.5MB input/output ceiling**. yourQR currently stores uploaded media as DB bytes, so **20MB uploads and serving >4MB files are blocked on Vercel until Cloudflare R2 direct upload and delivery are implemented**.
5. Deploy a **private test preview**, confirm Vercel Express function detection, static page/assets, HTTPS cookies, email confirmation, two-account isolation, dynamic QR GET vs HEAD, scan history, and file previews.
6. Set up monitoring, database backups + restore rehearsal, anti-abuse policies and stable DNS **before** any public paid launch. Test previously printed QR destinations and migration rollback.

## Validation

GitHub CI executes `npm test`, `npm run build` (SQLite regression suite), PostgreSQL 16 API + import integration tests, and a Vercel staging build verification. Vercel's real deployment routing must still be checked from an actual staging preview.

## Free vs commercial

Vercel's free Hobby tier is for **personal/non-commercial** use. Plan for a paid, commercially permitted Vercel tier for the customer-facing SaaS. Database quotas, function invocation billing and bandwidth apply. Do not publish yourQR as a paid SaaS on Hobby.

## Selecting the redesigned deployment branch

The pearl-white glass interface is available on `saas-development`, together with the Express entrypoint, PostgreSQL support and `build:vercel` script. Create the Vercel deployment from this branch. A deployment log that says `Branch: main` is building a different application configuration; redeploying that same commit will not switch branches.

Keep framework **Express**, repository-root working directory, and build command `npm run build:vercel`. If this branch should serve the production domain, update the project's production branch in Vercel before creating that deployment. Otherwise, create a preview deployment using `saas-development` as the Git reference. Preserve the project's existing server-side environment bindings, and confirm they are assigned to the selected deployment environment. Local build verification does not confirm Vercel account settings, live database connectivity or deployment success.

## Frontend asset fallback

When the HTML title loads but the page is entirely blank, inspect Network for the Vite JS and CSS URLs under `/assets/`. yourQR's Express entrypoint has a fallback route that serves the hashed `dist/assets` files directly with JavaScript/CSS MIME types, and `vercel.json` includes those files in the Function bundle. Vercel's `public/` remains the preferred static CDN location. A 9-second inline fallback replaces an otherwise completely white screen when React fails to mount. Keep Function and CDN artifacts in sync after changing the Vite build.
