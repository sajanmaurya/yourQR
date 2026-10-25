# Validation record

Verified on 25 October 2026 using Node.js 24.14.1 on Windows.

## Passed

- `npm test`: **14 backend test groups passed**. Covers first-owner setup, login, protected endpoints, origin checks, session logout, dynamic URL stability, destination edits, GET versus HEAD analytics, pause/resume, deletion, immutable static content, folders, validation, persistence, offline password recovery, production setup token, secure cookies, and throttling. New checks create all 19 QR types and decode each actual exported PNG; they also cover PDF/image/audio/PPTX uploads, file replacement and access rules, byte ranges, iOS/Android/default routing, structured payload escaping, and invalid-file rejection.
- Export tests decode the **actual generated PNG and rasterized SVG**, including a center logo, back to their expected content. Unicode plain text is also decoded.
- `npm run build`: production frontend built successfully.
- `npm run test:e2e` using installed Microsoft Edge: **5 browser scenarios passed**. Exercises account setup, folders, custom color/logo, both download formats, QR decoding, dynamic destination edits, pause/resume, static text, search/filter/list views, analytics and date ranges, JSON export, folder rename/delete, mobile navigation/editor, logout/login, and code deletion. The added scenario covers the searchable 19-type gallery, PDF upload, actual served PDF bytes, a decoded PDF QR download, replacement with an unchanged QR address, old-file blocking, file pause/resume, Wi-Fi field entry and immutable saved details, and mobile PDF uploads.
- Desktop viewport: 1440 × 1000. Mobile viewport: 390 × 844. Mobile dashboard and editor checks detect horizontal page overflow.
- A separate browser viewing check followed a public PDF QR redirect and visually confirmed the PDF's page and text in Microsoft Edge's PDF viewer, with no browser console errors.
- A separate native audio check followed an audio QR redirect and confirmed that WAV playback loaded with media ready state 4, a valid duration, and no media error.
- Dependency audit after updating Sharp to 0.35.5: **0 known vulnerabilities reported**.
- The local app runs on port 8787. The content-type upgrade uses additive SQLite migrations and preserves the existing personal account and saved records. All feature tests used separate databases; a database snapshot was taken before the upgrade.

## Practical limits

Docker and a public HTTPS deployment were not executed in this environment. The included Docker, Compose, and Caddy files were reviewed for consistency with the implemented settings. Public DNS, TLS, persistence, backups, and uptime must be configured on the chosen host.

Automated QR decoding verifies the image files under test. Scan a printed sample with your intended phones and at the intended print size before a large print run.

Analytics count real requests to dynamic redirect URLs, including test visits, repeats, and possible bots. They cannot measure scans of static codes. Visitor counts are approximate daily unique estimates.

The dashboard preview image shows the isolated test workspace. It does not seed the personal workspace or represent production traffic.

## Same-Wi-Fi fix verification

Verified the configured Wi-Fi address responds, both migrated QR links redirect correctly, and the linked PDF is served successfully. Used HEAD requests so these checks did not increase scan totals. Confirmed the Windows rule allows this app on TCP 8787 from LocalSubnet. Existing records were backed up before rewriting loopback QR addresses. The actual phone connection still needs to be checked on the phone.

## Latest review

See REVIEW.md for the current audit, screenshots, 14 passing backend groups, five passing browser scenarios, and the new build-time code check. The live hotspot address remains 10.177.121.108; no rebasing to the temporary router network was performed.
