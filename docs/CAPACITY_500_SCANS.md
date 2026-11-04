# YourQR: 500 scans per hour capacity target

## Target

**500 dynamic QR scans/hour** (about 8.3/minute on average), including bursts where multiple visitors scan at the same time.

Run the repeatable, non-production regression test from a clean checkout:

```bash
npm ci
npm run test:capacity
```

This automatically exercises **425 website redirects + 75 private PDF redirects** (500 total), while up to 25 requests overlap. It then verifies exactly 500 database scan records, analytics totals, HEAD not counted, immediate pause behavior, private PDF range streaming (30 reads) and complete PDF delivery (5 reads). Each QR read remains a fresh database request, so editing/pausing links takes immediate effect.

The test uses an **isolated PostgreSQL-compatible PGlite database and an in-memory stand-in for private Vercel Blob**. It runs in GitHub Actions; it does *not* send synthetic traffic to production, consume customer data, or charge a merchant. It emits `QR_CAPACITY_REGRESSION` metrics with elapsed time and p50/p95/p99. These are local test metrics and **not production latency benchmarks**.

## Current deployed architecture

- Vercel: runs Express as a serverless function in the configured region.
- Neon PostgreSQL: public `/r/:slug` reads the unique slug, then records each genuine GET as a row in `user_scans`.
- Private Vercel Blob: serves PDFs through `/files/:id`, validating that an active QR still owns the upload. Supports streaming and HTTP byte ranges.
- SQL indexes: unique `slug`, per-QR scan/time, and a timestamp index to help analytics over recent date windows.
- QR short-links, pause/resume, existing PDFs, and all user data remain unchanged.

## Capacity and cost boundaries

The test is **functional/concurrency evidence**, not a real-host capacity guarantee. At 500 scans/hour, 2 MB PDFs can mean roughly 1 GB/hour of delivered documents, while 10 MB PDFs can mean ~5 GB/hour. Sustained all-day use at these rates may exceed free-tier data transfer/Blob allowances even if function requests themselves are small. One PDF QR scan typically causes a redirect request **and** a document request.

Before promising an SLA or launching a paid service:

1. In a dedicated **unprotected staging** deployment with its **own disposable Neon branch and private Blob store**, run a timed traffic profile at 8.3 scans/minute for an hour plus controlled bursts of 25-50 concurrent scans. Run the PDF profile with realistically sized documents. Do not run on real users' QR URLs.
2. Verify Vercel error rate and p95 response time, Neon query latency and compute usage, Blob downloads, bandwidth and database growth.
3. Confirm 0 failed scans, accurate analytics, zero unintended duplicate events, pause/resume behavior, and an acceptable p95 latency on mobile networks.
4. Set alerts and spending limits, backup the database and private objects, and plan cleanup/retention of long-term scan history.
5. Use commercial-eligible Vercel hosting before charging customers; Hobby is limited to personal/non-commercial use.

Official limit references:
- https://vercel.com/docs/limits
- https://vercel.com/docs/plans/hobby
- https://vercel.com/docs/vercel-blob
