# yourQR

A multi-user, self-hostable QR code workspace. Every person can create an account with a private library, folders, files, and analytics. yourQR uses its own design and assets; it is inspired by the QR management workflow, with no ME-QR branding or proprietary assets.

## What is included

- Public email/password registration, login and logout, with a separate private workspace for every account.
- Saved static URL/text codes and dynamic URL codes.
- All 19 QR types visible in the reference screenshot: URL, PDF, image, Play Market / App Store, text, WhatsApp, YouTube, Instagram, Facebook, Telegram, vCard, map, Wi-Fi, audio, email, booking, phone call, PPTX, and Smart QR.
- Stable redirect slugs, editable dynamic destinations, and pause/resume.
- Custom foreground/background colors and a PNG/JPEG center logo.
- High-resolution PNG and scalable SVG downloads, with a four-module quiet zone and high error correction.
- Folders, search, filtering, and per-code management.
- Analytics for dynamic redirect requests: daily visits, estimated visitors, devices, referring domains, and recent activity.
- A JSON export of code/folder records, plus Docker deployment files.

The database starts empty. All counters come from saved records and actual redirect requests.

## PDF codes and other uploaded files

1. Click **Create QR code**, then choose **PDF**.
2. Upload a PDF of up to **20 MB**. Give the code a name and optionally choose a permanent short-link slug, folder, colors, and logo.
3. Save, then download its QR as PNG or SVG. A scan opens the PDF from your yourQR server.
4. To update the document, open **Edit code**, upload a replacement PDF, and **Save changes**. The QR image and its permanent short link stay the same.

On a local or self-hosted SQLite installation, uploaded files are stored inside the database. On Vercel, PostgreSQL stores file metadata and Vercel Blob stores the private file contents; yourQR checks the file when it is finalized and serves it through the authenticated/active-code checks in the app. A JSON workspace export includes file metadata and references, **not file contents**.

Anyone who has an active file code's link can access its document; viewers do not need an owner login. Pausing or deleting the code blocks further serving of its file, unless another active code references that same upload. Replacing a file removes public access to its previous upload unless another active code uses it. Files already downloaded or cached by a recipient cannot be recalled. Newly uploaded files without a saved QR are private to the owner; abandoned uploads are collected after 24 hours during a later upload.

| File type | Accepted formats | Upload limit | Scan result |
|---|---|---|---|
| PDF | PDF | 20 MB | Browser PDF viewer, or download depending on the scanning browser |
| Image | PNG, JPEG, WebP; under 20 megapixels | 10 MB | Opens the image; local uploads converted to PNG |
| Audio | MP3, WAV, Ogg | 25 MB | Browser playback or the device's media player |
| PPTX | `.pptx` presentation | 20 MB | Downloads for opening in a presentation app |

Uploaded content uses dynamic codes. Your server must be running and reachable by the scanning phone. Choose your stable public HTTPS address before creating codes for other people; `localhost` codes only work on this computer. The existing hosting instructions below apply to PDF and other file codes too.

Uploads are checked for supported format signatures, package structure where applicable, and size limits. This is not an antivirus service or document conversion system. PDFs are served as PDFs; PPTX files are downloaded rather than converted into browser slides.

## The other QR types

| Types | Behavior |
|---|---|
| URL, YouTube, Instagram, Facebook, Telegram | Direct/static or editable dynamic website links |
| WhatsApp | Opens a chat using an international phone number and optional prepared message |
| Map | Opens a map search for an address or coordinates |
| Booking | Opens your existing booking/appointment page; the linked service handles scheduling |
| Text, Wi-Fi, vCard, email, phone call | Static content embedded in the QR, with type-specific editor fields |
| Play Market / App Store | Dynamic routing to Google Play on Android, App Store on iOS, and a required fallback website elsewhere |
| Smart QR | Dynamic iOS/Android/default website routing, using the scanning browser's device signal |

Wi-Fi passwords and contact details are embedded in static QR images. Share those images only with intended recipients. Static content cannot be changed after saving. Device routing is approximate and falls back to the default URL when a device cannot be identified. This version's Smart QR supports device rules, not time, country, or language rules.

## Run locally

Install **Node.js 24 or newer**, including npm. No separate database server or paid API account is needed. Run these commands from this folder:

```sh
npm ci
```

Copy the example settings:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

For the simplest local experience, build and start the app:

```sh
npm run build
npm start
```

Open **[http://localhost:8787](http://localhost:8787)**. Select **Create an account** and use a password with at least 12 characters. Each account sees only its own codes, folders, files, sessions, and analytics; local data is stored in `data/qori.sqlite`.

For development with automatic reload:

```sh
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)**. Vite forwards API and redirect requests to the API on port 8787. The default encoded dynamic URLs use port 8787 so they continue working when you switch to the built app.

The built app and development app use the same local database. Stop one API instance before starting the other. Node may print a notice about its built-in SQLite API; it does not prevent the app from running.

## Static and dynamic codes

### Use a phone on the same Wi-Fi

For a Wi-Fi-only installation, stop yourQR, find your computer's Wi-Fi IPv4 address with `ipconfig`, then run this from the project folder:

```powershell
npm run share:wifi -- 192.168.1.20
npm start
```

Replace the example IP with your computer's actual address. This saves `HOST=0.0.0.0` and the Wi-Fi `PUBLIC_BASE_URL` in your private `.env`. The command backs up SQLite and updates existing dynamic codes whose QR address contains localhost/loopback or this app's previous Wi-Fi origin. Account, uploaded files, folders, slugs, and scan history are preserved. **Download affected QR images again**; previously downloaded images still contain the old localhost address.

On Windows, run `enable-wifi-firewall.ps1` once in administrator PowerShell if inbound access is blocked. It permits this Node app on Wi-Fi, TCP 8787, from the local subnet only. It does not configure router forwarding. Connect the phone and computer to the same Wi-Fi or hotspot, open the Wi-Fi address on the phone, and keep the computer awake with yourQR running. If your network isolates connected devices, that router/hotspot setting must allow them to communicate.

A Wi-Fi IP address can change when you switch networks or reconnect. A DHCP reservation in your router can keep the computer's address stable for printed codes. This Wi-Fi setup does not require internet hosting or a public domain.

| | Static | Dynamic |
|---|---|---|
| Encoded content | The destination URL or text itself | A stable URL such as `https://qr.example.com/r/menu` |
| Change the destination after printing | Generate and print a new code | Edit the saved destination; the printed code stays valid |
| Requires yourQR to be online when scanned | No | Yes |
| yourQR scan analytics | Unavailable | Redirect visits are recorded |
| Pause / resume | Unavailable | Supported |

Static content and code type are fixed after creation. You can still edit their name, folder, colors, and logo. For a dynamic code, the slug is fixed after creation while its destination remains editable.

yourQR checks URL schemes and color contrast and limits logo size. Always scan the **final downloaded design** on the phones, screen sizes, and printed materials you plan to use. Dense text, decorative colors, printing, and logo overlays can affect readability.

## What runs free, and what needs hosting

All included software features run locally without a subscription, metered QR plan, or external QR generation service. Static QR images can be generated and downloaded locally, then scanned without yourQR running. Opening a static website URL still needs access to that website.

Dynamic codes and their analytics need a reachable yourQR server. `localhost` refers to the device doing the scan: a code containing `http://localhost:8787/...` will not reach your computer from a phone. For testing on your Wi-Fi, bind the API to `0.0.0.0`, set `PUBLIC_BASE_URL` to your computer’s LAN address, restart the API, allow the port through your firewall, and open that address on the phone. Keep this test instance on a trusted network.

For codes shared outside your network, use an always-on host and a **stable public HTTPS address**. A server you own or a hosting provider may be suitable. Hosting and a custom domain can cost money; any free hosting option must support a persistent disk, Node.js, and the uptime you need. A provider-supplied stable hostname can work without buying a custom domain.

Set the permanent public address **before printing dynamic codes**. yourQR stores the encoded redirect address with each code. Changing `PUBLIC_BASE_URL` later cannot rewrite images that have already been downloaded or printed. Keep the old address serving those redirects if you move hosts.

## Vercel hosted trial

The Vercel configuration supports a **multi-user hosted trial**. Vercel serves the React files, runs the Express API as a Function, Neon Postgres keeps accounts/codes/folders/analytics, and private Vercel Blob stores uploaded PDFs and other files. The Vercel Function's local filesystem is not used for permanent data. Existing SQLite data and PDF files are not automatically copied to the hosted database.

1. Import `sajanmaurya/yourQR` into Vercel and use `main` as the Production Branch after merging the hosted code in Project Settings. Use the repository root, the **Express** framework preset, Node **24.x**, and `npm run build`. Leave Output Directory at the framework default; do not override it to `dist` or choose the Vite preset. The root `index.js` serves the API and the build copies browser files into `public/` for Vercel’s CDN.
2. Create a Neon Postgres database and a **private** Vercel Blob store, then link the Blob store to the Vercel project.
3. In Vercel Project Settings → Environment Variables, configure `DATABASE_URL` with the **Neon** connection string and `PUBLIC_BASE_URL` with the final stable HTTPS domain. Set `TRUST_PROXY=1` and `NODE_ENV=production`. Confirm the linked private store supplies `BLOB_READ_WRITE_TOKEN`. Use separate database and Blob stores for previews; never point unreviewed previews at live customer data.
4. Deploy, open the production URL, create two test accounts, and verify that neither can view or modify the other account’s data.
5. Open `/api/health`, then create a test PDF QR code (also try a PDF larger than 4.5 MB), scan it from a phone on mobile data, replace the PDF, and verify the same QR slug opens the replacement. Pause the code and check that both its redirect and file link stop working. Check analytics, PNG/SVG downloads, logout/login, and persistence after redeploying before distributing codes. Public QR redirects must be reachable without Vercel deployment-protection login; yourQR’s dashboard still requires the owner login.

Uploads go directly from the signed-in browser to private Blob using a short-lived, size-limited permission for one unique path. The API validates the file before attaching it to the library. Retrying finalization returns the same asset. Downloads are streamed through yourQR with active-code checks and byte-range support. Hosted login throttling is stored in Postgres so it survives Function restarts.

Back up both Neon and Blob; the JSON library export is not a full backup. Hosted abandoned/invalid uploads remain private and may consume storage. Periodically compare Blob paths with `assets.blob_path` and `upload_intents.pathname`, removing only unreferenced objects whose upload intent expired more than a day ago. Never delete objects still referenced by assets. The local `reset-password` script is SQLite-only; keep the hosted owner credentials in a password manager. Provider costs, backup retention, cleanup and availability still need monitoring during the trial.

The Vercel adapter uses Postgres and Blob only when running on Vercel; local and Docker installs keep SQLite-backed uploads. Vercel/Neon/Blob usage may incur charges after provider allowances. Check current provider pricing and set spending alerts before inviting anyone. Vercel projects can deploy previews for branches, but the `PUBLIC_BASE_URL` used to encode new QR codes must remain stable; do not create printed codes from a temporary preview URL.

Account registration and tenant-level data isolation are implemented. Before a full commercial launch, add email verification, email-based password reset, abuse controls/CAPTCHA, subscriptions and quotas, privacy/terms pages, account deletion, database backups, monitoring, and an external security review.

## Architecture

```text
React / Vite UI ── Vercel CDN (public/index.html and assets)
    │ same-origin authenticated requests
    ▼
Express API ─────── Vercel Function
    ├── Neon Postgres (hosted) / SQLite (local and self-hosted)
    ├── private Vercel Blob (hosted file bytes) / SQLite BLOB (local files)
    ├── qrcode + sharp → SVG / PNG downloads with optional center logo
    └── GET /r/:slug → record visit → HTTP 302 to current destination
```

The frontend lives in `client/`. Express and data access live in `server/`. Vite builds the frontend into `dist/`; the Vercel build copies it into `public/` for CDN delivery. The browser and API share one origin; no separate CORS configuration or browser database key is required.

This MVP uses SQLite via Node’s built-in `node:sqlite` locally and PostgreSQL on Vercel. Account IDs scope folders, uploaded assets, QR codes, analytics, exports, and direct-object mutations. Existing single-owner data is migrated into the first user automatically. A market launch still needs verified email and recovery flows plus operational and security controls.

QR generation runs on your own server. It does not send destinations, uploaded logos, or analytics to a QR vendor. The server redirects visitors to the destination you selected; normal destination-site traffic is separate.

## Configuration

The supplied npm commands load `.env` automatically. Existing environment variables take precedence.

| Variable | Default / purpose |
|---|---|
| `PORT` | `8787` |
| `HOST` | `127.0.0.1`; use `0.0.0.0` inside a container or for deliberate LAN access |
| `PUBLIC_BASE_URL` | `http://localhost:8787`; permanent address encoded into new dynamic QR codes |
| `DB_PATH` | `./data/qori.sqlite`, relative to this app folder |
| `NODE_ENV` | `development`; use `production` behind HTTPS |
| `TRUST_PROXY` | `0`; use `1` only when one trusted reverse proxy is the only route to the app |
| `COOKIE_SECURE` | Automatically enabled for an HTTPS public URL; may be set explicitly to `true` or `false` |
| `DATABASE_URL` | Vercel only; PostgreSQL connection string from Neon |
| `BLOB_READ_WRITE_TOKEN` | Vercel only; supplied by linking the private Blob store to the project |

Registration is public. Keep `.env` private and outside version control, enforce HTTPS, and add email verification plus bot protection before a broad public launch.

## Self-host with Docker and HTTPS

The provided Compose file runs one non-root app container and stores SQLite in a named volume. It binds the app port to the host’s loopback interface so a reverse proxy on the host can expose HTTPS.

1. Copy `.env.example` to `.env`.
2. Set `PUBLIC_BASE_URL=https://qr.example.com` to your real address.
3. Point that domain’s DNS to your server and allow inbound HTTP/HTTPS traffic for your proxy.
4. Build and start yourQR:

   ```sh
   docker compose up -d --build
   ```

5. Install Caddy on the host, copy `Caddyfile.example` into your Caddy configuration, replace the example domain, and reload Caddy. It proxies to `127.0.0.1:8787` and manages HTTPS for a correctly configured public domain.
6. Open your HTTPS URL and create a test account.

The Compose file sets production mode, a container bind address, secure cookies, and a single trusted proxy. If you use a different proxy topology, update the proxy setting deliberately. With this default Compose configuration, visiting the loopback HTTP port directly will not support login because the session cookie requires HTTPS; use your public HTTPS URL.

For an installation without Docker, run `npm ci`, `npm run build`, and `npm start` under a service manager. Use production settings, a persistent `data/` folder, one app process, and the same reverse-proxy arrangement. Never expose a fresh development instance as a public service.

## Backups, moving hosts, and recovery

The **Export** action downloads code and folder records as JSON. It is useful for inspection and portability; it does not contain your login credentials, sessions, or full analytics, and this MVP has no JSON import workflow.

For a complete backup, **stop the app first**, copy the entire `data/` directory or back up the stopped Docker volume, then restart. SQLite may use `-wal` and `-shm` sidecar files while running, so copying only a live `.sqlite` file is not a reliable backup. Restore the complete backup with the app stopped and keep filesystem ownership writable by the app user. Store backups privately: they contain your account hash, destinations, logos, and analytics.

On a host move, preserve the database and keep the same public hostname. A DNS move with the same hostname lets printed dynamic URLs continue resolving to the new server. Test redirects before retiring the old server.

There is no email-based password reset in this personal MVP. Stop the running app, then use the offline recovery command with your existing owner email and a new password of 12–256 characters:

```powershell
# Windows PowerShell 7: password entry is hidden and is not written in history.
$env:RESET_EMAIL = Read-Host 'Existing owner email'
$env:RESET_PASSWORD = Read-Host 'New password' -MaskInput
npm run reset-password
Remove-Item Env:RESET_EMAIL, Env:RESET_PASSWORD
```

```sh
# Bash: password entry is hidden and is not written in history.
read -r -p 'Existing owner email: ' RESET_EMAIL
read -r -s -p 'New password: ' RESET_PASSWORD; printf '\n'
export RESET_EMAIL RESET_PASSWORD
npm run reset-password
unset RESET_EMAIL RESET_PASSWORD
```

Recovery requires local access to the database and the existing email; it cannot change the owner email. It invalidates existing sessions and does not delete saved QR codes. For Docker, run the same `server/reset-password.js` utility in a one-off container with the existing volume mounted and recovery variables supplied, while the normal app container is stopped.

## Analytics and privacy limits

- A “scan” is a GET request to a dynamic redirect. Opening or testing the short link counts too. HEAD requests do not count.
- Device labels are broad categories inferred from the request. Referrers are domains and may be absent.
- Estimated visitors use a daily rotating, keyed hash of request signals. The secret is stored in your database. Raw IP addresses and complete user-agent strings are not stored in scan events.
- Visitor totals are approximate daily unique counts summed over the selected period. One person can count again on another day or device; shared networks can undercount.
- Bots, link previews, and repeated visits may increase totals. Basic bot/preview labels are available, but there is no reliable bot filtering or geolocation in this MVP.
- Static codes bypass this app when scanned, so yourQR cannot measure their scans.
- Scan records persist until their code is deleted. Publish any privacy notice your intended deployment needs.

## Authentication and scope

Passwords use salted scrypt hashes. Sessions use random opaque tokens, store only token hashes in the database, and expire after seven days. Cookies are HttpOnly and SameSite; production HTTPS uses secure cookies. Mutating API requests check origins, login/setup attempts are throttled, inputs are validated, and database queries use bound parameters.

The owner can manage all saved records. Public visitors can only follow enabled dynamic redirects. There is no public registration after initial setup, no multi-user sharing, and no separate administrator role. yourQR is an MVP for personal use; backups, host updates, availability, and access to your server remain part of operating it.

## API overview

All `/api` routes except health, session information, and authentication require login. Errors return JSON with an `error` message.

| Route | Purpose |
|---|---|
| `GET /api/health` | Public health and version check |
| `GET /api/auth/session` | Authentication state and whether initial setup is needed |
| `POST /api/auth/setup` | Create the first owner |
| `POST /api/auth/login`, `POST /api/auth/logout` | Start or end a session |
| `GET`, `POST /api/qrs` | List or create codes |
| `PATCH`, `DELETE /api/qrs/:id` | Update or delete a code |
| `GET /api/qrs/:id/download?format=png\|svg` | Download a saved design |
| `POST /api/preview` | Render a design preview without saving |
| `POST /api/assets?type=pdf\|image\|audio\|pptx` | Authenticated raw file upload; `Content-Type: application/octet-stream`, encoded filename in `X-File-Name` |
| `POST /api/assets/upload-intent`, `POST /api/assets/upload-token`, `POST /api/assets/finalize` | Hosted authenticated direct-upload flow; raw upload endpoint is local-only |
| `GET /api/assets/:id/content` | Owner-only uploaded-file preview |
| `DELETE /api/assets/:id` | Remove an upload not referenced by a saved QR |
| `GET`, `POST /api/folders` | List or create folders |
| `PATCH`, `DELETE /api/folders/:id` | Rename/recolor or remove a folder; codes become unfiled |
| `GET /api/analytics?days=30&qrId=…` | Aggregate or per-code dynamic analytics; supports 7, 30, or 90 days |
| `GET /api/settings` | Effective instance configuration |
| `GET /api/export` | Export code/folder records without account secrets |
| `GET /r/:slug` | Public, uncached dynamic redirect |
| `GET /files/:id` | Public content only when referenced by an active code; supports byte ranges |

## Validation and development

```sh
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The backend tests use isolated temporary databases. `server/hosted.test.js` runs PostgreSQL queries in PGlite with simulated private Blob storage, covering an 8 MB PDF, upload permissions, repeated finalization, download ranges, replacement/pause, analytics, folders and shared login throttling. This checks application behavior; real Neon connectivity, Blob uploads, CDN headers and Vercel routing still require the deployment smoke test above. Browser tests exercise the built app with a separate database so they do not use your personal account or records. Review the test output for the exact checks run in your environment. Test reports and screenshots are local development artifacts and are excluded from version control.

Browser tests use Playwright’s Chromium by default. You can use an installed Microsoft Edge instead by setting `PLAYWRIGHT_CHANNEL=msedge` before running `npm run test:e2e` (`$env:PLAYWRIGHT_CHANNEL='msedge'` in PowerShell). This is useful on Windows when Edge is already available.

Primary implementation references: [Node.js SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [node-qrcode](https://github.com/soldair/node-qrcode), and [Express security guidance](https://expressjs.com/en/advanced/best-practice-security/).

Content-format references: [ZXing barcode content conventions](https://github.com/zxing/zxing/wiki/Barcode-Contents), [mailto URI specification](https://www.rfc-editor.org/rfc/rfc6068), and [vCard 3.0 specification](https://www.rfc-editor.org/rfc/rfc2426).

## Review improvements

The PDF editor now puts upload first, and the saved-code menu includes **Share or test link** with the full address, phone-friendly copying, PDF download, and QR downloads. Mobile cards are easier to read. Builds check undefined variables, and a recovery screen handles unexpected view errors. See [the test and improvement review](REVIEW.md) for evidence and practical limits.
