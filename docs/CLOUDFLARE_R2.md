# Qori PDF hosting with Cloudflare R2

**Status:** Application integration prepared on `saas-development`. Bucket, API credentials, and browser CORS still require the Cloudflare account owner. Do **not** turn on paid customers yet. Existing PDF uploads in PostgreSQL remain usable, and their `/files/:id` links are unchanged.

## Create a private test bucket in Cloudflare

1. Sign into [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Storage & databases → R2**. Activate R2 billing if prompted (Cloudflare may require a payment method even on the free allowance).
2. Create a **private** Standard storage bucket named **`qori-staging-files`**. Do not enable `r2.dev` public access. Use the default jurisdiction and an available region near your users when appropriate.
3. Under R2 **Manage API Tokens**, create an **Object Read & Write** token, **restricted to `qori-staging-files` only**. Copy its Access Key ID and Secret Access Key directly to Vercel, not to chats, Github commits, or screenshots. Find your 32-character Cloudflare account ID in R2 Overview.
4. In **R2 → qori-staging-files → Settings → CORS policy**, paste the JSON below. The origin is your **stable staging branch hostname** (not a random per-deployment URL). You will need to add your final production/custom domain when launching.

```json
[
  {
    "AllowedOrigins": ["https://yourqr-git-saas-development-sajan-kumar-s-projects.vercel.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

5. In **Vercel → yourqr → Settings → Environment Variables**, add the following as **server-side Preview variables restricted to the `saas-development` branch**:
   - `R2_ACCOUNT_ID`: Cloudflare account ID (32 hex digits)
   - `R2_BUCKET`: `qori-staging-files`
   - `R2_ACCESS_KEY_ID`: scoped R2 Access Key ID
   - `R2_SECRET_ACCESS_KEY`: scoped R2 Secret Access Key (**sensitive/encrypted**)
6. Redeploy the **Preview branch**, not `main`. Production's R2 and database settings must remain isolated.

## Verify the 10 MB shop PDF scenario

Sign into your private Qori Preview (owner setup or staging account), select **PDF**, and upload a real 10 MB PDF. The browser calls authenticated `/api/assets/r2/init`, PUTs directly to Cloudflare's signed R2 URL, and calls `/api/assets/r2/complete`. The backend checks size, MIME, PDF header and trailer, then stores only a short R2 reference in Neon instead of the full PDF. Create a dynamic QR and open `/r/:slug`; it should count the scan and redirect through `/files/:id` to a short-lived, signed R2 **GET**, delivering 10 MB without Vercel serving the response body. A paused or deleted QR must not yield a new signed download.

Do not trust a Vercel green build alone. Test the real upload, signed download, file replacement, pause/revoke, multiple browsers and network connections. A valid old signed download remains usable for up to two minutes after pausing a QR.

## Current safeguards and limitations

- R2 upload URLs expire after 5 minutes, signed file download URLs after 2 minutes. Bucket is private. R2 keys are random UUIDs namespaced per workspace, so no user-supplied path is signed. Authenticated owner requests are required for initiation/finalization. Only PDFs up to 20 MB are supported in the direct path. A 100 MB per-workspace reserved upload quota prevents routine overuse.
- Download authorization remains at Qori. QR links stay stable. File delivery occurs via Cloudflare, rather than a Vercel Function body.
- The temporary presigned PUT URL must be handled as a secret until it expires. Cloudflare S3 PUT URLs don't automatically guarantee uploaded byte size; Qori verifies it *after* upload. Add per-account rate limits, signed body-length policy enforcement, abuse safeguards, antivirus scanning, lifecycle cleanup of orphaned objects/pending uploads, and production monitoring before opening public registration or billing.
- Existing large PostgreSQL BLOB uploads still need a separate migration to R2. The implementation intentionally doesn't relocate user data without approval. The cleanup of expired R2 objects must be coordinated with the database; the old automatic database-only asset purge is disabled when R2 is active.
- A private `r2.dev` free public URL is **not** used: the application signs short GET URLs, retaining access control and avoiding exposing public bucket contents.
- Do not print real customer QR codes using a Preview hostname. Wait for the permanent custom domain and a tested production deployment.

References: [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), and [R2 S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/).
