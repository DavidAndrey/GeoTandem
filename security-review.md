# Security review

Date: 2026-10-04. Scope: the whole backend (authentication, sessions, admin
API, query compiler and executor, import and GDAL handling, staging), how the
frontend displays data, Dockerfile, Makefile and `compose.yaml`. Every finding
is judged for two deployments: running locally, and a public cloud
demonstrator reachable from the internet.

Method: code reading, plus a check of FastAPI's request-handling order in the
installed version (0.141.1). No attacks were run against a live instance.

**Overall:** the core is solid. The serious risks are in how the instance is
deployed (an open setup page, missing HTTPS settings, no protection against
floods), not in the analysis code.

## What is already done well

- **No SQL injection found.** Queries are built with SQLAlchemy Core. Layer
  and attribute names are checked against the catalog, and imported names are
  cleaned in `importing/names.py`. Analysis connections run with
  `PRAGMA query_only` and a time limit.
- **Layer visibility holds.** Every query, join, aggregation, computed column,
  saved query and session goes through `LayerView`. A hidden layer looks
  exactly like a missing one, including in error messages.
- **Users cannot reach each other's data.** Sessions are scoped to their owner
  and answer 404 to anyone else. Saved queries check owner, sharing and layer
  visibility.
- **Login handling is sound.** Passwords use Argon2, and a dummy hash keeps
  timing equal for unknown usernames. Session tokens are 256-bit and only
  their SHA-256 is stored. Cookies are HttpOnly and SameSite=Strict. Changing,
  resetting or locking a password ends other logins.
- **GDAL is locked down.** Only the GeoJSON, Shapefile and GPKG drivers are
  enabled, with a startup check that fails if others appear.
- **XSS is handled in the map.** Popups and tooltips are built with
  `textContent`.
- **The container is reasonable.** It runs as a non-root user, upload file
  names are cleaned (`PurePath.name`), and staging ids are random UUIDs.

## Findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 1 | **Critical (cloud) / High (local)** | **Anyone can take over a fresh instance.** `api/auth.py`: `POST /api/auth/setup` is open to anyone until the first account exists. There is no setup token and no restriction to localhost; the README only warns about it. | On a public demo, whoever reaches a new or reset instance first becomes administrator, with full control of data, users and imports. Locally, `docker run -p 8000:8000` (and `compose.yaml`) listen on every network interface, so anyone on the same LAN or Wi-Fi can do it too. |
| 2 | **High (cloud)** | **Login can be flooded, both to guess passwords and to crash the server.** `/api/auth/login` has no rate limit, delay or lockout. Each attempt runs Argon2 with default settings (about 64 MB of RAM and tens of milliseconds of CPU) and opens a database write transaction (`BEGIN IMMEDIATE`), even for unknown usernames. | Unlimited online password guessing (minimum length 10, no breach-list check). Without logging in, about 40 parallel requests (the thread pool size) need around 2.5 GB of RAM and serialise on the SQLite write lock, which can crash a small cloud VM or lock everyone else out. |
| 3 | **High (cloud)** | **Unauthenticated users can send huge request bodies before any login check.** FastAPI reads and parses the body (`fastapi/routing.py:430`) before it checks dependencies such as `require_admin` (`:481`), and there is no global body size limit. A multipart upload to `/api/admin/imports` spools to temporary disk without limit (Starlette caps form fields at 1 MB, not file parts); `max_import_mb` is only checked after the request is authorised. JSON bodies to `/login` and `/setup` are read fully into memory. | An anonymous attacker can fill the container's temp disk or exhaust its memory and take the demo down. The "admin only" restriction on uploads does not help here. |
| 4 | **Medium (cloud)** | **The session cookie is not marked HTTPS-only, and HSTS is missing.** `config.py`: `cookie_secure` defaults to `false`, and neither the Dockerfile nor `compose.yaml` sets it. No `Strict-Transport-Security` header is sent. | Behind a TLS proxy the session cookie is still sent over any plain-HTTP request, for example a first visit or a downgrade. On public Wi-Fi a session can be stolen. |
| 5 | **Medium** | **Signed-in users can tie up the server with expensive queries.** The time limit uses SQLite's progress handler, which only interrupts *between* virtual-machine steps (`data/spatialite.py`, `execute`). Single expensive calls are not interrupted: `ST_Buffer` or `ST_Distance` on large geometries, `GeomFromGeoJSON` on input with millions of vertices. Python's `shape()` / `is_valid` in `engine/compile.py` runs before the timer starts. There is no limit on `InList.values`, `And`/`Or.args`, vertex count, buffer distance or nesting depth; `/query/count` and `/query/ids` add work per request. | One demo user, or a stolen account, can occupy the worker pool and make the service unresponsive for everyone. Very deep JSON nesting causes `RecursionError` and a 500 response. |
| 6 | **Medium** | **No limit on how much each user can store.** Each analysis session holds up to 1 MB of state (`sessions.py`) and each saved query up to 200 kB, with no cap on how many. The size check runs only after the whole body has been parsed. | Any signed-in user can grow the SQLite file until `/data` is full, which stops every write, logins included (they write `last_login_at` and sessions). |
| 7 | **Medium** | **No security headers.** No CSP, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors` or `Referrer-Policy`. | XSS is handled today, but there is no second line of defence if a new one appears, for example in metadata fields, saved-query names or layer titles shown to other users. SameSite=Strict largely covers clickjacking for now. |
| 8 | **Medium (cloud, depends on domain)** | **CSRF protection relies on SameSite alone.** No CSRF token and no `Origin` check. SameSite separates *sites*, not origins. | If the demo runs on a subdomain of a shared parent domain (e.g. `geotandem.example.org` beside other apps on `*.example.org`), an XSS or takeover on any sibling subdomain can send admin requests: create users, delete layers, upload files. |
| 9 | **Low–Medium** | **Imports parse untrusted files in-process.** Shapefile zips and `.xlsx` files are expanded without a limit on unpacked size: GDAL reads them via `/vsizip/` and `pyogrio.raw.read` loads the whole file into memory; openpyxl handles `.xlsx`. GPKG files are hostile SQLite databases opened by GDAL. `defusedxml` is not installed (current libexpat does block billion-laughs attacks). | Requires an admin (or a stolen admin session, see #2 and #4). A small zip bomb can crash the process; GDAL and SQLite parser bugs become a remote-code-execution surface. |
| 10 | **Low** | **Internal details exposed.** `/api/health` is unauthenticated and returns version, backend, CRS and capabilities. `/docs`, `/redoc` and `/openapi.json` are public; `/docs` loads Swagger UI from a CDN. GDAL and openpyxl error text, including server paths such as `/data/staging/<id>/…`, is returned to the client. | Helps an attacker map the system. Minor. |
| 11 | **Low** | **Abandoned uploads only expire at startup.** `importing/staging.py` removes uploads older than 24 h only when the server starts. | On a long-running demo, abandoned admin uploads (up to 200 MB each) pile up in `/data`. |
| 12 | **Low** | **Password policy.** No maximum length (bounded only by #3), no breach or common-password check, no limit on attempts at the current password in `/api/auth/password`. | Weak passwords combined with #2. |
| 13 | **Info** | **Logs miss security events.** Failed logins, admin actions other than imports, and account changes are not logged. | No way to notice or investigate brute-force attempts or misuse on the public demo. |
| 14 | **Info** | **External basemap leaks map positions.** When enabled, the browser fetches tiles from swisstopo or OSM, which learn which areas users look at (already documented). Attribution HTML comes from operator configuration, which is trusted. | Privacy only. |

## Fixes in priority order

1. **Setup takeover (#1):** require a one-time setup token printed to the
   container log (or `GEOTANDEM_SETUP_TOKEN`), or allow setup only from
   loopback. Alternatively create the admin with `geotandem user create`
   before exposing the instance. Publish the port as `127.0.0.1:8000:8000` in
   README, Makefile and `compose.yaml`.
2. **Login flood (#2):** limit failed sign-ins per client address and per
   username; bound how many Argon2 checks run at once; check the password
   before opening a write transaction.
3. **Oversized bodies (#3):** a reverse proxy with `client_max_body_size`, or
   an ASGI middleware that enforces `Content-Length` and the streamed size
   (about 1 MB in general, `max_import_mb` only for `/api/admin/imports`).
   Check the admin session in a middleware before the body is read.
4. **HTTPS (#4):** in the cloud, set `GEOTANDEM_COOKIE_SECURE=true` and HSTS
   at the proxy; consider deriving it from `X-Forwarded-Proto`.
5. **Expensive queries and storage (#5, #6):** limits in the query-object
   schema (vertex count, list lengths, nesting depth, maximum buffer and
   distance); a small per-user concurrency limit for analysis queries; a cap
   on sessions and saved queries per user.
6. **Headers and CSRF (#7, #8):** a security-headers middleware (CSP with
   `default-src 'self'` plus the tile host, `nosniff`,
   `frame-ancestors 'none'`, `Referrer-Policy`); reject state-changing
   requests whose `Origin` is not the app's own.
7. **Imports (#9):** check unpacked size and file count of zip and xlsx files
   before parsing; consider parsing in a resource-limited subprocess.
8. **Minor items (#10–#13):** disable or protect `/docs`, `/redoc` and
   `/openapi.json` on public deployments; return generic import error
   messages; clean up staging periodically; log authentication and admin
   events.

For the cloud demo, a reverse proxy (Caddy, nginx or the provider's load
balancer) with TLS, body-size limits and rate limiting closes most of #2, #3,
#4 and #7 without code changes. #1 and #5 need code changes.

## Status

Every fixed item is enforced by the application itself. The public
demonstrator also runs behind Traefik (`compose.traefik.yaml`), which repeats
most of them as a second layer, so a missing or misconfigured proxy opens no
hole.

| # | App | Traefik (`compose.traefik.yaml`) |
|---|---|---|
| 1 | Fixed: setup needs a token from the installation | `POST /api/auth/setup` only from `GEOTANDEM_SETUP_FROM` |
| 2 | Fixed: sign-in throttle, bounded hashing | Rate limit on sign-in and password change |
| 3 | Fixed: body limit before the body is read | `buffering` limits |
| 4 | Fixed: `Secure` cookie and HSTS over HTTPS | TLS, HSTS |
| 5 | Fixed: bounds on each query; queries running at once per account and in all | — |
| 6 | Fixed: sessions, saved queries and logins per account capped | — |
| 9 | Fixed: archives checked before parsing; Excel XML through defusedxml; files read in a limited process of their own | — |
| 11 | Fixed: expired uploads removed before every new one; at most 20 waiting | — |
| 12 | Fixed: password policy (length, blocklists, patterns, names) | — |
| 7 | Fixed: CSP with per-request nonce, `nosniff`, `X-Frame-Options`, `Referrer-Policy` | Same headers except CSP |
| 8 | Fixed: changes from other origins refused | — |
| 10 | Fixed: health says only ready or not, details for admins; API docs off by default; import errors without server details; no `server` header | — |
| 13 | Fixed: security events as JSON lines (`audit.py`) | Traefik's own access log, if enabled |

Verified on 2026-10-04 against a real Traefik v3.6 with the merged Compose
files: the Playwright suite passes over HTTPS with a check that fails any test
in which the browser reports a CSP violation, and `make gate` passes.

### #1: setup token (`auth/setup_token.py`)

- **Setup asks for a token only the installation has.** Either the operator
  sets `GEOTANDEM_SETUP_TOKEN` (at least 16 characters; never printed), or,
  while no account exists, every start makes a random one (144 bits) and
  writes it to the log with a link `/einrichtung#token=…` that fills it into
  the setup form. Behind `#`, the token reaches no server, so no access log or
  proxy log records it; the page removes it from the address bar and history.
- **It is held in memory only**, compared in constant time, and void once an
  account exists. A restart before setup makes a new one.
- **Wrong tokens** are refused with `403 setup_token_invalid`, count in the
  sign-in throttle (10 per address in 15 minutes) and are recorded in the
  security log as `setup_token_rejected`, without the guess.
- Creating the administrator on the command line
  (`geotandem user create <name> --role admin`) needs no token: whoever can
  run it already has the installation.
- `make gate` takes the token from the first start's log as an operator
  would, and fails if a set-up instance still offers one.

Not changed: `docker run -p 8000:8000` still publishes on every interface.
With the token, reaching the address no longer allows a takeover; that the
instance is reachable from the LAN at all is intended for a demonstrator.

### #5: expensive queries (`engine/complexity.py`, `api/slots.py`)

- **Bounds on each query**, checked in `compile_query`, so for running,
  counting, ids, validation, session stamps and saved queries alike; beyond
  one, `400 query_too_complex` names it (`details.limit`, `max`, `found`):

  | Bound | Max |
  |---|---|
  | conditions in the whole query (nested, in relations and columns) | 200 |
  | nesting depth | 20 |
  | values in one `in` list / in all conditions | 1 000 / 5 000 |
  | vertices of drawn geometries | 10 000 |
  | `text_match` text | 500 characters |
  | buffer and distances | 1 000 km |
  | computed columns | 10 |
  | entries in `select`, `order_by`, join `fields`, `area_fields`, `metrics` | 100 |

  Far above anything the interface builds. Measured before: a list of
  150 000 values was a 500 (beyond SQLite's limit of variables); a drawn
  polygon that fits in 2 MB (about 45 000 vertices) took 0.8 s to check
  before the time limit even started.
- **Queries running at once**: each running query holds a slot of its
  account (3) and of the instance (8). Further queries wait in the event loop,
  on no worker thread, for at most the time limit, then get `503 busy` with
  `Retry-After`, recorded as `queries_busy`. Applies to `/api/query`,
  `/query/count`, `/query/ids` and the session routes that stamp a result;
  `/query/validate` runs nothing and needs no slot.

Not changed: nesting deeper than about 500 levels was already refused by
pydantic; the time limit itself (F-9.6) stays the way a slow query ends.

### #6: storage per account

- At most 100 saved sessions (1 MB of state each) and 100 saved queries per
  account; beyond, creating or duplicating answers `409 too_many_sessions` /
  `too_many_saved_queries`. Counted in the adding transaction (`BEGIN
  IMMEDIATE`), so two saves at once cannot both pass.
- At most 20 logins per account: a new one ends the one used least recently.
- Request bodies are bounded since #3, so the size check no longer follows an
  unbounded parse.

Worst case per account is now about 100 MB of sessions; for many accounts,
watch the size of `/data`.

### #9: import files (`importing/archive.py`, `importing/isolation.py`)

- **Archives first.** A zipped shapefile or an Excel workbook is checked in
  plain Python before GDAL or openpyxl see it: at most 1 000 entries, none
  encrypted, no archive inside, and at most `GEOTANDEM_MAX_IMPORT_UNPACKED_MB`
  (1000 MB) unpacked. Counted by unpacking, not from the headers: an entry
  whose header understates its size fails its checksum and is refused.
- **XML**: openpyxl parses through `defusedxml` (now a dependency), so an
  Excel file with XML entities ("billion laughs", external entities) is
  refused; tested down to the `EntitiesForbidden` it raises.
- **A process of its own.** The file is read in a child process forked from
  a small server that has imported the readers once (`forkserver`): address
  space `GEOTANDEM_IMPORT_MEMORY_MB` (4096; the libraries alone take about
  1.4 GB of virtual memory, 115 MB resident), CPU time
  `GEOTANDEM_IMPORT_TIMEOUT_S` (300 s), and a wall-clock limit on top. Out of
  memory, out of time, or a crash in GDAL or SQLite: the child ends, the
  wizard says the file cannot be read, the server goes on. The GDAL driver
  restriction holds in the child (tested).

Not changed: the child runs as the same user, so it is no sandbox against
code execution through a parser bug; that would need a separate user or
namespaces, beyond this application. Imports remain administrators' work.

### #11: uploads left waiting (`importing/staging.py`)

Uploads older than 24 hours are removed at start, as before, and now also
before every new upload; at most 20 wait at once (`409
too_many_pending_imports` beyond, the wizard tells to import or cancel one).
Abandoned uploads can no longer pile up on a long-running instance.

### #12: password policy (`auth/password_policy.py`)

Agreed on 2026-10-04. Length over complexity, as NIST SP 800-63B and OWASP
ASVS advise:

| Rule | Decision |
|---|---|
| Length | at least 12 characters, at most 1024; any characters, spaces and umlauts included |
| Composition | no rules about digits or special characters |
| Common passwords | `data/common-passwords.txt` (10 000 entries, provided for the project, SHA-256 recorded) and `data/german-passwords.txt` (104 entries compiled by hand), compared in normalized form: case, umlauts, separators, leetspeak and digits or symbols at either end do not count |
| Patterns | keyboard rows (QWERTZ and QWERTY), alphabet and digit sequences, repetitions, fewer than 5 distinct characters |
| Names | must not contain the username, the display name (parts of 4 characters and more) or "geotandem" |
| Applies to | setup, password change, `geotandem user create`; generated start passwords comply |
| Existing passwords | valid until their next change |
| Expiry | none |
| Unicode | NFKC before hashing; hashes made before still sign in and are renewed |

No external service is asked. The interface tells the reason in German
(`password_common`, `password_pattern`, `password_contains_name`), the lists
stay on the server. Measured: of the 10 000 common passwords only 10 have 12
characters or more, so an exact comparison would catch almost nothing; the
normalized one catches `P@ssw0rd2024!`, `Fussball1234!` or `Bern2024!!!!`.

### #2: sign-in throttle

- **Failed sign-ins are limited** (`auth/throttle.py`): per client address and
  username (default 10 in 15 minutes) and per client address alone (default
  50). Beyond that, sign-in answers `429 too_many_attempts` with
  `Retry-After`, also for the right password, so the limit cannot be used to
  test passwords. A successful sign-in clears the count for that username and
  address, not the count for the address. Wrong current passwords in
  `/api/auth/password` count the same way.
- **At most four password checks run at once**; a fifth waits up to ten
  seconds and is then answered `503 busy`. Peak memory for hashing stays near
  256 MB whatever the load.
- **A failed sign-in no longer takes the write lock**: the password is checked
  on a read transaction, and all hashing happens outside write transactions.
- **Passwords and usernames have a maximum length** in the sign-in, setup and
  password-change requests (1024 and 64 characters).

Limits: the counts live in memory (one process, F-9.7) and start afresh on a
restart. Behind a reverse proxy, uvicorn must trust the proxy's address
(`FORWARDED_ALLOW_IPS`; `compose.traefik.yaml` requires `TRAEFIK_IPS`), or
every request appears to come from the proxy and shares one address limit.
Guessing spread over many addresses is slowed by the hashing limit and
Traefik's rate limit.

### #3, #4, #7, #8: request guards (`api/guards.py`)

- **Body size**: every request body is cut off at `GEOTANDEM_MAX_REQUEST_MB`
  (2 MB), by `Content-Length` and by counting a body without it. Only
  `POST /api/admin/imports` with a valid administrator session may send up to
  `MAX_IMPORT_MB`; the session is checked before a byte of the body is read.
- **HTTPS**: a request that arrives over HTTPS (directly, or via a trusted
  proxy's `X-Forwarded-Proto`) gets a `Secure` cookie and HSTS, whatever
  `GEOTANDEM_COOKIE_SECURE` says.
- **Headers** on every response: CSP, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
  `Cross-Origin-Opener-Policy: same-origin`. The CSP allows scripts and styles
  only as files from the instance, images also from the configured tile server.
  Styles added at run time (Radix dialogs lock scrolling with `<style>`
  elements) need the page load's nonce: the server fills a fresh one into
  `index.html` on every load, which is therefore never cached.
- **Origin**: `POST`, `PUT`, `PATCH` and `DELETE` with a foreign `Origin` or
  `Sec-Fetch-Site: cross-site`/`same-site` are refused with `403 cross_origin`.

### #13: security log (`audit.py`)

One JSON line per event on stderr (so in `docker logs`), from the logger
`geotandem.security`, separate from uvicorn's access log. Every line carries
`time` (UTC), `event`, and the request's client `address`, `method` and
`path`; account events name the acting account as `username` (`cli` for the
command line) and the affected one as `account`.

| Events | Fields |
|---|---|
| `sign_in`, `sign_in_failed`, `sign_in_throttled`, `sign_out`, `setup` | `username`; a failure also its `reason` (`unknown_user`, `wrong_password`, `account_locked`), which the client is never told |
| `password_changed`, `password_change_failed`, `hashing_busy` | `username` |
| `account_created`, `account_updated`, `account_password_reset`, `account_deleted` | `account`, `role`, `changes` |
| `layer_updated`, `attribute_updated`, `layer_duplicated`, `layer_deleted` | `layer`, `attribute`, changed `fields` (names only), `copy` |
| `visibility_changed`, `visibility_default_changed` | `layer`, `role`, `visible` |
| `import_uploaded`, `import_committed`, `import_cancelled` | `file`, `import_id`, `layer`, `status` |
| `forbidden`, `cross_origin_refused`, `request_too_large` | `username`, `origin`, `upload` |

JSON, not free text: usernames and file names come from outside, and a line
break in one cannot forge a log line. Passwords, start passwords and session
tokens are never logged (tested). Not covered: reading data (queries,
sessions) is not a security event and stays in the access log only; the log
is not kept inside the instance, so its retention is the container runtime's
or the log collector's.

### #10: internal details

- **`/api/health`** answers anyone with `{"status": "ok"|"degraded"}` only,
  enough for the container health check and monitors. Version, data core,
  internal CRS, schema and sample versions and capabilities moved to
  `GET /api/admin/system`, for administrators (the *System* page).
- **API documentation**: `/docs`, `/redoc` and `/openapi.json` are served only
  with `GEOTANDEM_API_DOCS=true` (`make dev` sets it).
- **Import errors** name the file and the format it could not be read as,
  e.g. `'kaputt.gpkg' cannot be read as a GeoPackage.` GDAL's and openpyxl's
  own text, which held the staged file's path on the server
  (`/data/staging/<id>/…`) and driver hints, goes to the server log only.
- **`server: uvicorn`** is no longer sent.

Still public on purpose: `/api/schema/query-object` (the published query
format, F-10.3, nothing about the instance) and `GET /api/auth/setup`
(whether setup is pending, which the sign-in page needs).

## OWASP API Security Top 10 (2023)

Date: 2026-10-04, after the fixes above. Scope: every HTTP route of the
backend, checked against the ten risks of the
[OWASP API Security Top 10, 2023 edition](https://owasp.org/API-Security/editions/2023/en/0x00-header/).
Method: code reading, plus three checks against the running application
code: every registered route listed with the authentication dependency it
resolves to, the cost of decoding stored session states measured, and the
foreign-key enforcement behind account deletion confirmed.

**Overall:** no broken authorization found. All 57 routes require the access
level they should. The new findings are smaller: one route that lets a
signed-in user tie up the server, and some hardening of sessions and
response headers.

### Risk by risk

| Risk | Result | Basis |
|---|---|---|
| **API1 Broken Object Level Authorization** | No finding | Analysis sessions are loaded only by `(id, owner)` and answer 404 to anyone else (`sessions._get`). Saved queries: owner, or shared *and* every layer the query uses is visible (`saved_queries._readable`); only the owner changes or deletes. Layers go through `LayerView`, which is the only way to reach a table: `compile.py` records every layer it resolves, and layer tables carry a prefix, so a query cannot reach `app_user` or `auth_session` even as administrator. Ids are random (`token_urlsafe(8)`, imports UUIDs). Deleting an account deletes its logins, sessions and saved queries (`PRAGMA foreign_keys = ON`, `ondelete="CASCADE"`), so a reused account id inherits nothing. `/api/queries/{id}/usage` counts sessions of every account but never says whose (design Q7). |
| **API2 Broken Authentication** | #16, #18 | Covered by #1, #2, #4 and #12: setup token, sign-in throttle, bounded hashing, Argon2, 256-bit tokens stored as SHA-256, `HttpOnly` and `SameSite=Strict` cookie, logins ended on password change, reset and lock. Left: no absolute session lifetime (#16), no `__Host-` cookie prefix (#18). |
| **API3 Broken Object Property Level Authorization** | #19, #20 | No mass assignment: every write takes an explicit Pydantic model (`AccountUpdate`, `LayerUpdate`, `SessionWrite`, …). Owner, id and timestamps never come from the body, and `role`/`status` only through the admin router. Responses are explicit models too: `Account` has no password hash, and validation errors do not echo the input. Left: text fields without a length limit (#19), and the upload file name shown to every user (#20). |
| **API4 Unrestricted Resource Consumption** | #15 | Covered by #2, #3, #5, #6, #9 and #11. Left: listing sessions decodes every stored state, outside the query slots (#15). |
| **API5 Broken Function Level Authorization** | No finding; #21 | Every route listed with what it depends on: 22 admin (one dependency on the `/api/admin` router), 25 for a signed-in account, 2 also with the start password (`/auth/me`, `/auth/password`), 6 public on purpose (`health`, `schema/query-object`, `auth/setup` GET and POST, `auth/login`, `auth/logout`). The body-size guard decides "administrator" with the same rules as `require_admin`. The tests do not check this list, though (#21). |
| **API6 Unrestricted Access to Sensitive Business Flows** | No finding | No self-registration, no reset by e-mail, no payments. Accounts and passwords are an administrator's work, and setup happens once and needs the token. Shared queries are the one place where one user's content reaches others; at most 100 per account, read-only, and the owner's name is shown with each. Reading every visible feature page by page is the purpose of the application, not a misuse. |
| **API7 Server Side Request Forgery** | No finding | The server fetches no URL at run time. The tile URL is operator configuration and only the browser fetches it. GDAL is limited to GeoJSON, Shapefile and GPKG (the network drivers `HTTP`, `WFS`, `OAPIF`, `CSW`, `OGR_VRT` and `GDALG` are skipped). It only ever opens a staged file at a server-chosen path, and `sublayer` must be one of the names GDAL listed for that file. SpatiaLite's file and network functions (`ImportWFS`, `BlobFromFile`, …) cannot be named: queries use a fixed set of operations, and `SPATIALITE_SECURITY` is not relaxed. |
| **API8 Security Misconfiguration** | #17, #18 | Covered by #4, #7, #8 and #10: HSTS, CSP with nonce, `nosniff`, framing denied, origin check, API docs off, no `server` header, generic import errors. No CORS middleware, so only the instance's own origin can read answers. Container runs as non-root. Left: API answers carry no `Cache-Control` (#17). |
| **API9 Improper Inventory Management** | #21 | One API version and one deployable, no old or debug endpoints. The OpenAPI document is generated from the code and committed (`frontend/openapi.json`; `test_api.py` fails if it drifts). Two Compose files, both documented. The list of public routes is known (API5) but not enforced by a test (#21). |
| **API10 Unsafe Consumption of APIs** | No finding (watch for E2/E4) | No third-party API is called at run time. The sample dataset is downloaded only by `geotandem sample update` and pinned by SHA-256 in its manifest. Ahead: tool calling (E2) and the MCP server (E4) will treat model output as input. The registry already validates arguments against each tool's model (`Tool.call`) and runs tools under the caller's `LayerView` (`AppState.tool_context`). Layer and attribute descriptions and imported values will reach the model's context. Treat them as untrusted text that may carry instructions (indirect prompt injection), and keep tools read-only (F-9.5). |

### New findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 15 | **Medium (cloud)** | **Listing sessions decodes every session's full state.** `sessions.list_sessions` selects whole `AnalysisSession` rows, so SQLAlchemy reads and decodes the `state` JSON of each, although the summary never uses it. An account may hold 100 sessions of up to 1 MB each (#6). Measured: decoding 100 states of 0.84 MB takes about 1 s of CPU, holding the GIL. The route takes no query slot (#5) and has no rate limit. `saved_queries.list_queries` does the same for the state of every readable query (up to 200 kB each, from every account that shares). | One signed-in account can fill its 100 sessions once, then send `GET /api/sessions` in a loop from a few connections. Each request costs about 1 s of the single process's CPU, and the server stops answering everyone else. The query slots do not help, as this route is not a query. |
| 16 | **Low** | **Logins have no absolute lifetime.** Expiry slides by `session_hours` (12 h) on every use (`auth/sessions.resolve`); `created_at` is stored but never checked. | A stolen session cookie that is used at least every 12 hours stays valid until the password is changed, or the account is locked or reset. |
| 17 | **Low** | **API answers carry no `Cache-Control`.** Only `index.html` is sent with `no-store`. Answers that hold start passwords (`POST /api/admin/users`, `…/reset-password`), analysis states, account lists and data may be kept by the browser or an intermediate cache. | On a shared computer, data of a signed-out user may remain in the browser cache. Proxies will not cache these answers (the cookie and HTTPS prevent it), so the risk is small. |
| 18 | **Low (cloud, depends on domain)** | **The session cookie has no `__Host-` prefix.** It is named `geotandem_session`, not `__Host-geotandem_session`. | In the shared-parent-domain setting of #8, a sibling subdomain can set a `geotandem_session` cookie for the parent domain. The victim's browser then sends the attacker's login, so the victim works in, and saves analyses to, the attacker's account. The origin check (#8) does not stop this, as no cross-site request is involved. |
| 19 | **Low** | **Text fields without a length limit.** `display_name` (`NewAccount`, `AccountUpdate`, `SetupRequest`); `title` and `description` of `LayerUpdate`; `label`, `description`, `unit` and `value_domain.codes` of `AttributeUpdate`; `Duplicate.title`. They are bounded only by the 2 MB body limit (#3). Session and saved-query names and notes are bounded already. | Administrators only (setup also needs the token). A 2 MB layer title or code list is sent to every user with each `/api/layers` and shapes the layer profile meant for the model (`for_model`). This degrades the interface and, later, fills the model's context. |
| 20 | **Info** | **Users see the upload file name.** `LayerInfo.source` is `file:<original name>` for imported layers and goes to every user who sees the layer. | File names sometimes say more than the layer's title (e.g. `kunden_intern_vertraulich.gpkg`). Minor. |
| 21 | **Info** | **The access tests list routes by hand.** `test_access.py` covers 10 of the 22 admin routes and none of the routes that write sessions or saved queries. Today every route is guarded correctly (checked by listing them). | A new route added outside `/api/admin`, or without `CurrentAccount`, would not fail any test. |

### Fixes

1. **#15:** load only the summary columns in `list_sessions`, `last_opened`
   and `list_queries`, e.g. `.options(defer(AnalysisSession.state))`. The
   state is read only in `get`. A test that checks the list does not load
   `state` keeps it that way.
2. **#16:** also end a login `GEOTANDEM_SESSION_MAX_DAYS` (e.g. 7) after its
   `created_at`, whatever its use.
3. **#17:** `Cache-Control: no-store` on every `/api/` answer, in
   `SecurityHeaders`.
4. **#18:** name the cookie `__Host-geotandem_session` when it is `Secure`,
   which it is over HTTPS (#4). Browsers then refuse it from another host
   and without `Secure` and `Path=/`.
5. **#19:** `max_length` on these fields, e.g. 120 for names and titles,
   2 000 for descriptions, 1 000 entries in a code list.
6. **#20:** show `source` to administrators only (`AdminLayerInfo`), or keep
   only the format (`file:gpkg`).
7. **#21:** a test that walks `app.routes`, resolves each route's
   dependencies and fails unless the route needs `require_account` (or
   `require_admin` under `/api/admin`), or is on an explicit list of public
   routes.

### Status of #15–#21

| # | Fixed |
|---|---|
| 15 | Session and saved-query listings no longer load `state` (`defer(…, raiseload=True)`: reading it in a listing raises). Tested on the SQL a listing sends. |
| 16 | A login ends `GEOTANDEM_SESSION_MAX_DAYS` (7) after sign-in, however often it is used. Use extends the expiry up to that point only (`auth/sessions.Lifetime`). |
| 17 | Every `/api/` answer carries `Cache-Control: no-store`. |
| 18 | Over HTTPS the cookie is `__Host-geotandem_session`, and only that name is read. A planted `geotandem_session` is ignored (tested). Plain HTTP keeps `geotandem_session`. On the HTTPS demo, everyone signs in once more after the update. |
| 19 | Display names up to 120 characters; layer titles and attribute labels 200; descriptions 5 000; units 50; code lists 500 entries of 500 characters. The same limits apply to the import wizard's decisions. Defaults taken from a file (title from the file name, label from the column header) are cut to fit, and code lists are proposed only when they fit, so imported metadata can always be saved back unchanged. The admin forms stop typing at the limits. |
| 20 | `source` (e.g. `file:<uploaded name>`) is sent to administrators only; for anyone else `/api/layers` and `/api/layers/{name}` answer `null`. |
| 21 | `test_every_route_requires_what_it_should` reads the routes from the application, checks it found every one in the OpenAPI document, and fails unless each needs an account, or an administrator under `/api/admin/`, or is on the written list of public and own-account routes. Tested to fail on a route whose guard was removed. |

## OWASP Top 10 (2025)

Date: 2026-10-04, after #1–#19. Scope: the risks of the
[OWASP Top 10, 2025 edition](https://top10.owasp.org/2025/) that the API
list above does not already cover: the supply chain, cryptography, injection
beyond SQL, integrity of software and data, logging and alerting, and how
errors are handled. Method: code reading; `pip-audit` on the 95 locked
runtime packages (`uv export --no-dev`) and `npm audit` on `frontend/` and
`e2e/`; one Argon2 check timed (43 ms on the development machine); the
worker thread pool read from anyio (40 threads).

**Overall:** no broken access control, injection or weak cryptography found.
The new findings are in the sign-in throttle: it counts each IPv6 address on
its own, and it can be outrun by parallel requests. Waiting sign-ins also hold
worker threads. The supply chain is locked but not watched.

### Risk by risk

| Risk | Result | Basis |
|---|---|---|
| **A01 Broken Access Control** | No finding | Covered by API1, API3, API5 and #21. Server-side request forgery, now part of A01, as API7: the server fetches no URL. |
| **A02 Security Misconfiguration** | No finding | Covered by API8 (#4, #7, #8, #10, #17). `compose.yaml` publishes on every interface on purpose (#1, "Not changed"). |
| **A03 Software Supply Chain Failures** | #25 | Locked: `uv.lock` with hashes and `uv sync --frozen`; `package-lock.json` with integrity hashes and `npm ci`; the sample dataset pinned by SHA-256 and checked on load. Today: `pip-audit` finds nothing; `npm audit --omit=dev` finds nothing. With dev dependencies, `braces` (GHSA-vfj7-8cjw-p6xm, via `@lingui/cli` and `eslint-plugin-lingui`) is a denial of service on glob patterns the build itself writes, so it cannot be reached. Left: nothing checks this regularly (#25). |
| **A04 Cryptographic Failures** | No finding | Argon2 (argon2-cffi defaults, RFC 9106) for passwords; session tokens of 256 bits from `secrets`, stored as SHA-256, which is enough for random tokens of that length; setup token of 144 bits compared with `compare_digest`; start passwords of 96 bits; ids from `secrets` and `uuid4`. No home-made cryptography, no MD5/SHA-1, no keys in the code. In transit: HTTPS at Traefik (TLS 1.2 or later by default), HSTS, `Secure` and `__Host-` cookie (#4, #18), `Cache-Control: no-store` (#17). At rest the SQLite file is not encrypted; it holds hashes only, and protecting `/data` and its backups is the host's job. |
| **A05 Injection** | No finding | SQL as noted at the top. `text_match` escapes `GLOB` and `LIKE` wildcards (`autoescape=True`), so `%`, `_` and `*` match themselves. No HTML sink in the frontend (no `innerHTML`, `dangerouslySetInnerHTML`, `eval`), and a CSP with no inline scripts (#7). The security log is written as JSON (#13). No shell, no `subprocess`. No data export, so no formula injection in CSV or Excel. File paths are chosen by the server (`Staging.path` takes only alphanumeric ids). Ahead: prompt injection through layer descriptions and values (API10). |
| **A06 Insecure Design** | #22, #23 | The design-level limits are in place (#2, #5, #6, #9). The throttle's notion of "one client" does not hold for IPv6 (#22), and its waiting holds threads (#23). |
| **A07 Authentication Failures** | #22, #24 | Covered by API2 (#1, #2, #12, #16, #18). Left: the throttle keys (#22) and a race in it (#24). |
| **A08 Software or Data Integrity Failures** | No finding | No plugins, no auto-update, no scripts from a CDN (CSP `script-src 'self'`; Swagger UI only with `GEOTANDEM_API_DOCS`). Client data is only ever JSON, validated by Pydantic; stored queries of sessions and saved queries are validated again by `QueryObject` when read. The one `pickle`: the import child sends its result to the server through `multiprocessing`. A child taken over through a parser bug could send a crafted result, but it already runs as the same user with write access to `/data`, so this adds nothing to what #9 accepts. |
| **A09 Security Logging and Alerting Failures** | #26 | Covered by #13: sign-ins, refusals, account and layer changes, as JSON, without secrets. No alerting in the application; it belongs to the log collector. Left: a password typed into the username field is logged (#26). |
| **A10 Mishandling of Exceptional Conditions** | #24 | Fails closed: a database error in the body guard (`_is_admin`) or session check ends in a 500, never in letting the request through. Unexpected errors get Starlette's plain `Internal Server Error`, with no traceback (`debug` is off); import and copy entries are closed as `failed` before the error goes on (`run.py`, `admin.py`); writes roll back with their transaction. Validation errors name the field, not the value sent. Left: a check-then-act race (#24). |

### New findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 22 | **Medium (cloud, if reachable over IPv6)** | **The sign-in throttle counts each IPv6 address on its own.** `auth/throttle.py` keys on `request.client.host` as is. One IPv6 customer usually has a whole /64 (2⁶⁴ addresses), often more. Traefik's `ratelimit` also keys on the full address by default. There is no limit per username across addresses (accepted in #2 for spread-out guessing, which needed many machines then). | One attacker with an IPv6 /64 gets a fresh limit with every address: unlimited guesses at one username, bounded only by the four hashing slots, so about 90 a second at 43 ms per check (fewer on a small VM). The password policy (#12) makes success unlikely, but this is the guessing #2 meant to stop. It also feeds #23. |
| 23 | **Medium (cloud)** | **Sign-ins waiting for a hashing slot hold a worker thread.** `login`, `setup` and `change_password` are plain `def` routes, so each runs on one of anyio's 40 worker threads, and waits there for up to 10 s in `_hashing.acquire` (`auth/accounts.py`). So are 54 of the 55 API routes. | About 40 sign-in requests at once, sustained (4 a second, each waiting 10 s), take every worker thread. The whole API then stalls for everyone, signed-in users included, while the event loop still accepts requests. No account is needed. Per address the throttle stops this after 50 failures, so it needs about 70 addresses per 15 minutes, which #22 makes free. Query slots (#5) avoid this by waiting in the event loop. |
| 24 | **Low** | **The throttle can be outrun by parallel requests.** `_brake` checks the count before the password is hashed; `failed` adds to it only afterwards. Requests already past the check all go ahead. | With 40 requests in flight at once, about 50 guesses per username and address get through in 15 minutes instead of 10; about 25 behind Traefik (burst 15). The same applies to the per-address limit, to wrong current passwords in `/api/auth/password`, and to setup tokens (harmless at 144 bits). |
| 25 | **Low** | **Nothing watches the dependencies.** No CI, no Dependabot or Renovate, no audit in `make gate`. Base images by tag (`node:24-slim`, `python:3.14-slim`, `uv:0.12.10`), not by digest. No SBOM. GDAL, PROJ and SQLite come inside the `pyogrio`/`pyproj` wheels (pinned below 0.14 and 4) or from Debian (`libsqlite3-mod-spatialite`). `pip-audit` does not see their advisories. | A known flaw in a parser that reads uploaded files (#9) stays in the image until someone happens to update. Today's audit is clean, but it is a snapshot. |
| 26 | **Info** | **A password typed into the username field is logged.** `sign_in_failed` records `username` as sent (up to 64 characters), with `reason: unknown_user`. | A user who types their password one field too early leaves it in the security log, in plain text. Whoever reads the log (the operator, a log service) learns it. A common way passwords end up in logs (CWE-532). |

### Fixes

1. **#22:** in `LoginThrottle`, key an IPv6 client by its /64 (`ipaddress.ip_network(f"{host}/64", strict=False)`), IPv4 by its address. In `compose.traefik.yaml`, set the rate limit's `sourceCriterion.ipStrategy.ipv6Subnet: 64` (check that the Traefik version in use supports it). Consider a third, wider limit per username across all addresses that slows sign-in rather than blocking it (e.g. at most one check per second per username), so it cannot be used to lock someone out.
2. **#23:** take the hashing slot in the event loop before the route takes a thread: an `asyncio.Semaphore` dependency (as `api/slots.py` does for queries) on `login`, `setup` and `password`, with the same 10 s wait and `503 busy`. Waiting then costs no thread.
3. **#24:** reserve before hashing. `LoginThrottle.attempt(address, username)` checks and records the attempt in one locked step, and `succeeded` removes it again. Parallel requests then count from the first one.
4. **#25:** add `pip-audit` (on `uv export --no-dev`) and `npm audit --omit=dev` to `make gate`. Bump base images by digest on a schedule, or let Renovate do it. Rebuild the image when GDAL, PROJ or SQLite publish a security fix. Optionally keep an SBOM of each image (`docker buildx build --sbom=true`).
5. **#26:** log the username of a failed sign-in only if the account exists. For `unknown_user`, log a short hash or just the length, which still shows a spray of guesses.

### Status of #22–#23

| # | App | Traefik (`compose.traefik.yaml`) |
|---|---|---|
| 22 | The sign-in throttle counts an IPv6 client by its /64 (`auth/throttle.client`), and an IPv4 address written as IPv6 (`::ffff:192.0.2.1`) as itself. The security log keeps the full address. | The sign-in rate limit groups IPv6 by /64 (`ipStrategy.ipv6Subnet`) |
| 23 | Sign-in, setup and password change wait for a password check in the event loop (`api/slots.HashingSlots`, 4 at once, `503 busy` after 10 s), on no worker thread. A password change takes its slot only once its session is checked. Measured before: with the hashing slots taken, 60 waiting sign-ins held a plain `GET` for 5 s; now it answers at once (tested). | — |

Not changed: there is no limit per username across all addresses, so guessing spread over many IPv4 addresses or many /64s is still slowed only by the hashing limit (#2). The measurement above also showed the race of #24, with 40 wrong guesses let through instead of 10; fixed below.

### Status of #24–#26

| # | Fixed |
|---|---|
| 24 | The throttle checks and counts an attempt in one locked step (`LoginThrottle.attempt`), as a failure from the start. A success takes it back from the address's count and clears its username's; an attempt that tested no password (busy, or a new password that breaks a rule) is taken back whole. Sign-in, setup token and password change all go through it. Tested: 60 wrong sign-ins at once with 40 hashing slots get ten `401` and fifty `429`. |
| 25 | `make audit` runs `pip-audit` on the locked runtime packages and `npm audit --omit=dev` on the frontend; `make gate` runs it. Images are built with `--pull`, so a rebuild picks up fixes to the base images. `.github/dependabot.yml` watches the uv, npm and Docker dependencies and proposes updates (security advisories at once, the rest weekly). |
| 26 | A failed or throttled sign-in names the username in the log only if an account by that name exists. An unknown name may be a password typed into the wrong field (tested). Failures by address still show a spray of guesses. |

Not changed for #25: base images stay pinned by tag, not by digest. A digest would also freeze their security fixes, and without CI nobody would move it on. `pip-audit` still does not see GDAL, PROJ and SQLite inside the wheels, nor the Debian packages of the image; an image scanner (e.g. `docker scout cves geotandem`) covers those, and needs an account or a separate tool.

### #27: guesses at one username from many addresses

Agreed on 2026-10-04, as the open point after #22: guessing spread over many
IPv4 addresses or many /64s was slowed only by the hashing limit.

- **Counted per username across all addresses** (`auth/throttle.py`), default
  20 failures in 15 minutes (`GEOTANDEM_LOGIN_FAILURES_PER_USERNAME`). Past
  that, sign-in is not refused but paced: one password check every 30 seconds
  for that username; others get `429 too_many_attempts` with the seconds to
  wait. The security log names the limit (`sign_in_throttled`, `limit:
  username`). A success takes back only its own attempt, so it does not reset
  the count for the guessers.
- **The owner is not paced** (`auth/device.py`). A browser that signs in gets
  a device cookie (`geotandem_device`, over HTTPS `__Host-geotandem_device`;
  HttpOnly, SameSite=Strict, 180 days, kept on sign-out). It holds a random
  nonce and an HMAC over it and the username, so it tells nothing to whoever
  reads it, and counts only for that username. With it, sign-in skips the pace.
  The limits per address still apply. A password change is not paced either:
  whoever makes it is signed in already.
- **Tested:** wrong guesses at `admin` from 20 IPv6 /64s pass, the 21st is
  paced, and the owner's browser still signs in at once; with the cookie
  ignored, the same test fails.

Limits: the key lives in memory, like the counts, so after a restart a browser
is paced again until its next sign-in. A browser that has never signed in to
the account (a new device) shares the pace with the guessers while a flood
lasts. One browser remembers one username, the last it signed in as. At one
check per 30 s, a sustained flood gets about 2 900 guesses a day at one
username, against a password policy (#12) that refuses common and short ones.

## Model path, E2.4 (plan E2.3–E2.6, 5.4)

Date: 2026-10-10, WP71, after WP70 (enforcement), WP72 and WP73 (model log).
Scope: Modus B as far as E2.4 builds it: every `/api/model/*` route and
`/api/admin/model-actions`, the prompt flow and its model calls
(`model/service.py`), the action record (`model/record/`), the CSV of the log,
the account's choice of level and connection (`api/llm.py`, `connections.py`),
the tool registry. Method: code reading against the checklist of plan 5.4 and
the unit-of-attack list of WP71, each item backed by a test. The tests observe
the effect, not only the status code: statements in the data core's query
log, calls that reached the model, the stored record before and after
(`backend/tests/test_model_bypass.py`, beside `test_model_enforcement.py`,
`test_model_flow.py` and `test_model_log.py`). Each new finding was shown by a
test that fails on the code before its fix. The `/security-review` run on the
etappe's diff that plan 5.4 asks for followed at the E2.4 etappe gate: see
"Gate E2.4" below (#34–#39).

**Overall:** the rule holds past the surface. No request runs a query the
level did not allow, approves under an `off` class, reaches another account's
record or calls a disabled connection, whatever the body says. The findings
are small and none is usable today: a connection read twice for one prompt, a
decision the log could be given against its definition, the person's choices
open to a future token, an administrator's model path holding the writable
data core, and bodies that accepted more than they should (#28–#33).

### Checklist

| Item | Result | Basis |
|---|---|---|
| **Authorisation on every `/api/model/*` route** | No finding | Every route needs an account (#21). A record is its owner's: another account's id and a forged id answer `404 not_found` alike, on all nine built action routes, for users and, on every change, for administrators; administrators read every record (D4). Tested both ways, with the owner's same request passing afterwards as the control. The five routes still at 501 (`plan`, `run`, `adopt`, `compare`, `comparison`) answer 501 for any id, so no id tells anything; they are listed in the test, which demands the 404 once they are built. A follow-up's parent and the turns built from it are the caller's own only (P6); `/api/model/my-actions` lists own records only; `/api/admin/model-actions` needs the administrator role. |
| **Snapshot integrity** (the level cannot be changed through the request) | #29, #31, #33 | Level and connection are resolved on the server for every prompt (H6, C14, C17): a level the user may not choose is refused at the choice and, chosen before it was closed, replaced by the default; a disabled connection is refused at the choice and never called, administrators included. The request bodies refuse unknown fields (`extra="forbid"`: `level_id`, `matrix`, `governance`, `status`, `connection`, `system_prompt`, `tools`, `turns` → 422); routes without a body read nothing sent along. The record keeps the level as it was (matrix, prompt hash) and its governance; `approve`, `execute` and the preview judge only that, so a level edited or deleted after the prompt changes no record (tested both ways). The connection snapshot is now read with the call (#28). |
| **TOCTOU on approve/execute** | #28 | Every edge of the state diagram is a compare-and-set on the status it was checked against (`ModelActionStore._settle`): of `approve` and `reject` at once exactly one wins. `execute` checks the record, claims the action in the process (`ModelCalls.claim`) and writes with a compare-and-set, so six parallel executes run the query once; a replay is `already_decided`. Nothing runs while the model thinks or a record runs (`not_approved`); an answer arriving after an abort is dropped. The `proposal_only` check of #29 runs inside the same compare-and-set as the decision it guards. |
| **CSV injection** | No finding | Verified (WP73): every text cell of `export.csv` gets a `'` before `=`, `+`, `-` or `@` at its start, judged after NFKC normalisation and leading white space (fullwidth forms included), and after any `;`, `,`, tab or line break inside it, where a spreadsheet opened with the wrong separator would start a new cell; every cell is quoted (`model/record/export.py`, tested by writing and reading back). |
| **Log visibility (D4)** | No finding | Users read their own records (detail, list, "Meine Modellaktionen"), administrators all, prompt text included; the admin log, its key figures and the CSV answer 403 to users. No log line holds a prompt, an answer or a key (C15, `test_no_log_line_holds_the_prompt_or_the_answer`). |
| **Audit events** | #30 | `model_action_decided` for every decision, by its user or by `system` at start-up; `model_action_undone`; `levels_changed`, `llm_connection_changed` (the request limit too, P5), `model_calls_busy`. New: `session_required` when a token-shaped credential is refused (#30), without the token. `approve` alone is no event: the decision that follows it is (`accepted`, or `superseded`). |
| **DoS bounds** | No finding | At most `GEOTANDEM_MAX_MODEL_CALLS` (4) model calls at once (503 `busy`), each in a thread of its own; one per account, an aborted call included until it ends, across all logins of the account (409 `busy`, tested with four logins at once); the connection's timeout, at most 120 s, per call, retries included, as a wall-clock limit on the whole call only since #34 (before, the limit held for each read, so an endpoint that sent a byte now and then kept a call open as long as it liked, and the answer's size had no limit); the prompt's size against the connection's context before any call; the request limit per connection and day (P5) counted in the transaction that creates the record under a process-wide lock, so parallel prompts pass exactly up to it, and an aborted request that reached the model still counts. Preview and execute take a query slot and keep the engine's limits (size, time). The CSV export stops at 50 000 rows and streams; pages are bounded. |
| **No write reachable from the model path (F-9.5)** | #32 | No model route writes anything but its record, but an administrator's model path held the writable data core (#32). Now enumerated four ways, each a test that fails when the code moves past it: the tools (three, `read` or `state`, none writes; the direct path offers the model none); every name the model path (`model/`, `tools/`, `api/model.py`) imports from the rest of the application, each one that reads, with no relative import to slip past (a new import fails until it is listed); no name of a data-core write (`create_layer`, `replace_layer`, `drop_layer`, `duplicate_layer`: what `LayerView` refuses) anywhere on the path, as an attribute or a string; and, walking every model route as an administrator and as a user, the model's thread included, only `model_action` is written (insert and update, besides the one statement that extends a login), and every view handed to the model's checks, the preview and `execute` is a `LayerView` whose writes raise `PermissionError`. Queries run on a connection with `PRAGMA query_only`. |
| **Prompt injection** | No finding (see residual risks) | The prompt text is the user message and nothing else: the system message (level prompt, layer profile, answer format), the answer schema and the tools are byte for byte those of a harmless prompt, and the level is the account's. A model that obeys gets no further: a write is `model_query_invalid`, a level of its own beside the query is `model_unreadable`, a query is governed by the level as any other. |

### New findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 28 | **Low** | **One prompt read its connection twice.** `PromptFlow.prompt` took the record's snapshot (name, host, local or external) and the request limit from `Connections.active`, then the endpoint by id from `Connections.endpoint` in a second transaction, which did not check that the connection was still enabled. | An administrator who changes or disables the connection between the two reads (milliseconds apart) sends that prompt, with the account's layer profile, to the new address while the record says it went to the old one, possibly local when it went out (F-9.4), or to a connection just disabled (C14). Needs the administrator's own change at that moment; a user cannot cause it. |
| 29 | **Low** | **A proposal waiting for approval could be logged as applied by hand.** `decide` accepted `proposal_only` for every `proposed` record. Section 2 defines it for a level with an `off` part only. | A direct API client logs its *Prüfen* proposals as `proposal_only` instead of approving or rejecting them: they leave the acceptance rate, and the key figures show a level with approval duty as if it had none. Nothing runs on the server (the user applies by hand, as Modus A allows), so this is the log's integrity only. |
| 30 | **Low (E4)** | **Approve, reject, decide and the level choice took any credential.** Only the preview needed an interactive session (P2). | Today the login cookie is the only credential, so nothing is open. With the model and MCP tokens of E4, a program acting for the account could approve its own proposal, or move the account to an `auto` level (`PUT /api/llm/options`) and then prompt and execute without a person deciding, which F-6.2 forbids. |
| 31 | **Info** | **`PUT /api/llm/options` dropped unknown fields.** `matrix`, `selectable` or `enabled` sent along were ignored without a word. | Nothing changed, but a client could believe it had. |
| 32 | **Low** | **An administrator's model path held the writable data core.** `view_for` gives an administrator the data core itself, not a `LayerView`; the prompt flow passed it to the model's checks and tools (`ToolContext.backend`), the preview and `execute`. | No code on the path calls a write, and queries run with `PRAGMA query_only`, so nothing is open. But F-9.5 rested on the code staying so: a chain tool (E2.5) that reached `drop_layer` through its context would drop a layer when an administrator asks, and no check would stop it. |
| 33 | **Info** | **Level and connection bodies dropped unknown fields.** `PUT /api/admin/levels` and the connection bodies (create, change, test) ignored a field they did not know. | A misspelt `selectible: true` saved the level not selectable, `enabeld: false` left a connection on, without a word. Administrators only. |

### Status of #28–#33

| # | Fixed |
|---|---|
| 28 | `Connections.active_call` reads the active connection and its endpoint in one transaction; the prompt takes the snapshot, the request limit and the call from it. Tested by changing the connection right after the read: the call goes to the host the record names. |
| 29 | `ModelActionStore.decide` refuses `proposal_only` for a record that is not proposal-only (`409 not_approved`), inside the compare-and-set that writes the decision, as `approve` checks its `off` classes; `adjusted` stays open to every proposal. The frontend's fake server answers the same. The E2.3 test of the hand-over now runs under *Assistenz*. |
| 30 | `approve`, `reject`, `decide` and `PUT /api/llm/options` need an interactive session, as the preview does (`403 session_required` for a token beside the cookie, any token scheme, or a credential other than the login cookie); the refusal is logged (`session_required`). |
| 31 | The choice takes `connection_id` and `level_id` only (`extra="forbid"`, 422). |
| 32 | The model path takes its view from `read_view` (`model/service.py`): a `LayerView` over the account's layers for every role, all layers for an administrator, so a write raises `PermissionError` whoever asks. `view_for` itself is unchanged for the rest of the application. |
| 33 | `Level`, `LevelSet`, the connection's call parameters (create, test) and `ConnectionPatch` refuse unknown fields (422). The admin pages and the e2e specs send none; tested with `selectible` and `enabeld`. |

### Accepted residual risks

- **In flight when the administrator acts.** A prompt read before its connection is disabled or edited is still sent there; the call is not cancelled, it ends by its deadline. A request limit switched on meanwhile does not refuse requests already admitted.
- **An aborted call holds its slot** until its deadline (at most 120 s; since #34 a
  call is given up then even if its thread lingers). One account holds at most one; as many accounts as there are model-call slots can fill them all, and others get `503 busy` meanwhile. There is no per-account daily limit (P5 counts per connection, over all accounts), so one account can use up the day's requests of a connection whose limit is on. **Before a cloud
  demo with a paid key** a per-account daily limit is advisable (a counted
  query over the action table, like P5's, keyed by account): the per-connection
  limit caps the bill, but not who spends it.
- **What the client reports is believed for the log.** `undo` and `touched` are reported by the client and change the log only (D2: the server never sees the analysis); `adjusted` names a query the user says they applied, logged, never run. A direct client can make its own entries say so falsely; it cannot make anything run.
- **`prompt`, `execute`, `undo`, `touched` and `abort` take any signed-in credential** until E4. A token can ask the model and execute what the account's level, chosen by the person, already allows (`auto` cells); it can neither choose that level nor approve. `undo`, `touched` and `abort` change the log only. E4 decides them together with its token design; the obligation in `require_interactive` stays: no token may set the login cookie's credential. Note for E4: a prompt sent with a token closes the account's open record like any prompt (WP70), so a program's prompt supersedes a proposal the person is still looking at. Nothing runs and the person's analysis is untouched; the log shows the proposal `superseded` (or `proposal_only`) instead of decided. E4 decides whether a token's prompt may close a person's open proposal.
- **Indirect prompt injection** through layer titles, descriptions, attribute labels and value lists in the layer profile (API10) is not filtered. Its reach is wider than the administrator's own words: an imported layer's labels default to the file's column headers and its title to the file name (#19), so whoever made the file writes into every account's model context until an administrator edits them. The model's own answers come back too: a follow-up's turns are built from the account's earlier records (P6), so an instruction the model once repeated in an explanation or assumption persists within that account's thread. Its reach is still that of a user's own prompt: the answer is checked, governed by the level, and only the stored query runs.
- **Routes still at 501** answer the same for every id without looking at the record. `test_model_bypass.py` lists them (`PENDING_ROUTES`, `GUARDED_PENDING`); WP75 and WP76 must move each to the tested lists when they build it, or the test fails.
- **Administrators read every prompt** (D4), by design; the prompt panel says inputs are logged.

## Gate E2.4 (plan E2.3–E2.6, 5.2 and 5.4)

Date: 2026-10-10, at the E2.4 etappe gate. Scope: the integrated diff of
E2.4 (WP70–WP73b) on `ep-2.3-6`: the model path, the adapter it calls
(`llm/openai_compat.py`), the record and its views, the log, the frontend's
model state. Method: `/security-review` on the diff and the integrated code
review, each finding shown by a test that fails on the code before its fix
where the code allows one (#34 on real sockets).

**Overall:** the rule still holds past the surface; the findings are about
resources (#34–#36), what a view or a stored record carries (#35, #37), input
bounds (#38) and one route's method (#39). #34 blocked the gate.

### New findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 34 | **High (gate blocker)** | **A model call was bounded neither in time nor in size.** The adapter gave httpx2 a read timeout, which limits each wait for a byte, not the call: an endpoint that sends a byte every few seconds, in its headers or its body, kept a call open for as long as it liked. The answer was read whole into memory, of any size, and compressed answers were accepted, so a small body could decode to far more. The model-call thread held the account (409) and a slot (503) until it ended. | A slow, broken or hostile endpoint (an external one, or a local one taken over) ties up every model-call slot for good and grows the process's memory without limit; every account's prompts then get `503 busy`. "120 s per call" in the checklist above was not what the code did. |
| 35 | **Low** | **A refused answer was stored as it came.** The raw query of a refused `query` answer (kept for inspection, design M3), the error list of `model_query_invalid` and the cause of `model_unreadable` had no bound; an assumption's `condition` path had none either. | Up to the answer's size (no limit, #34) per record, written to the database and sent with every poll of the record and the log. |
| 36 | **Low** | **A slot was taken before the account's own call was checked.** `prompt` took a global model-call slot, then found the account's call in flight and gave it back. | An account polling its prompt again while its answer is pending briefly held a slot; another account's prompt at that moment got `503 busy` instead of being served. |
| 37 | **Low** | **Users saw a failure's technical cause.** A record's `error.details.cause` (the transport's exception text, what did not parse) went to the record's owner as well as to the log. | Internal host names, addresses and library messages of the endpoint reached users (D4 shows them to administrators). The cause was in no security log line, so an operator saw it only in the admin log page. |
| 38 | **Info** | **Ids were unbounded integers.** An action id or a log filter (`level_id`, `connection_id`) or `parent_action_id` beyond a 64-bit integer reached the database. | `500 Internal Server Error` instead of 404 or 422: noise in the logs, no data. |
| 39 | **Low** | **The preview was a `GET` that writes.** `GET /api/model/actions/{id}/preview` sets `previewed_at` on the record. The origin check (#8) covers `POST`, `PUT`, `PATCH` and `DELETE` only. | A change guarded by the `SameSite=Strict` cookie alone, without the second layer every other change has: where the cookie is sent (a same-site sibling, #8, #18; a browser that ignores the attribute) another page could make a signed-in browser preview its proposals, and the log claims previews the user never saw. Nothing leaks: the answer goes to the user's browser. |

### Status of #34–#39

| # | Fixed |
|---|---|
| 34 | **Size:** every answer of an endpoint is read in chunks and given up past **1 MB** (`llm_bad_response`, `cause` "too large"), a declared larger `Content-Length` before the body; the adapter asks for `Accept-Encoding: identity` and refuses a compressed answer (`cause` "compressed"), so the limit is also what is decoded; error bodies count too. **Time:** an attempt's timeout is now a wall-clock deadline for the whole request: a network backend under httpx2's connection pool gives every connect, read and write only the time left before it, so an endpoint that trickles headers or body ends `llm_timeout` by then (and so do the Ollama probes, at their 5 s). Neither is retried. **Second line:** `ModelCalls` gives a call up 5 s after its deadline if its thread has not ended: the account entry and the slot are free, the cancel event is set, the record ends `failed` (`llm_timeout`), and a late answer is dropped by the compare-and-set. Tested on real sockets (one byte a second in the headers and in the body: the call ends within the deadline; 4 MB streamed and declared: refused, one request), through the API (a trickling endpoint, then the account prompts again; a model that never answers, the same), and the second line on its own (a call whose thread lingers). Shown to fail without the network backend. |
| 35 | A refused answer keeps its raw query up to 64 kB of canonical JSON, else `{"omitted": "too large"}`; `model_query_invalid` keeps the first 20 errors and `error_count`; a `model_unreadable` cause lists 20 and "and N more"; an assumption's `condition` has at most 20 indexes (else the answer is unreadable). Everything else of an answer was bounded by its schema already. |
| 36 | `prompt` checks the account's call in flight before it takes a slot (and again under the admission lock): an account waiting for its answer gets `409 busy` with its action, never a slot. Tested with one slot taken by the account's own call. |
| 37 | Every view of a record carries a failure's code and message only; `details` (the cause) only in the administrator's log entry (`GET /api/admin/model-actions/{id}`, D4) and in the security log, where `model_action_decided` of a failure now carries `code` and `cause` (no prompt or answer text, C13, C15). |
| 38 | Action ids in paths, the log's id filters and `parent_action_id` are bounded to 1 … 2⁶³−1: outside, `422`; inside, `404` when there is no such record. Tested at 0, −1, 2⁶³ and 2⁸⁰. |
| 39 | The preview is `POST /api/model/actions/{id}/preview` (client, fakes, e2e and plan section 6 follow); a cross-site `POST` is refused by the origin check and leaves `previewed_at` unset (tested). |

Also from the integrated review, for the record: sign-out and sign-in now reset
all model state in the browser (dialogue, last change with its snapshot of the
analysis, approval baselines, parked work, hand-over, panel), so the next
account in the same window sees nothing of the last one's and an answer still
on its way changes nothing (tested without a reload). A reverse proxy must not
forward a Bearer `Authorization` header (README).

## Gate E2.5 (plan E2.3–E2.6, 5.2 and 5.4)

Date: 2026-10-11, at the E2.5 etappe gate. Scope: the integrated diff of
E2.5 (WP74–WP79) on `ep-2.3-6`: the tool chain (`model/chain/`: its tools,
`model_view`, planning, re-plans), its run and its record (`model/service.py`,
`model/record/store.py`, migration 0011), the comparison
(`model/compare.py`), the routes (`api/model.py`), the query slots
(`api/slots.py`), and the frontend's chain and comparison clients with their
fakes. Method: `/security-review` on the diff and the checklist of plan 5.4
item by item, each finding shown by a test that fails on the code before its
fix.

**Overall:** the model still sees nothing of the data but counts (D9, D10),
and a chain writes nothing but its record. The findings are about resources a
chain uses outside the bounds the direct path keeps (#40, #42, #44), one
route's method (#41), and a level or a request limit that a chain outlived
(#43).

### Checklist (E2.5)

| Item | Result | Basis |
|---|---|---|
| **`model_view` is the only path to the model (D10)** | No finding | `model_view` (`chain/view.py`) is the one function that turns an engine result into what the model sees: `ok`/`error`, a code, `empty`, the count, and a `part` that must be a layer or attribute name written in that step's own arguments. `ModelView` has no free-text field (mypy strict). An AST check holds every call site to it (`test_an_engine_result_reaches_the_model_only_through_model_view`, `test_only_model_view_makes_what_the_model_sees`, `test_the_check_catches_the_cheap_ways_round`); `chain/ask.py`, the one module that talks to the model, imports nothing of the engine; nothing on the model path reads the data-release flag. |
| **Sentinel test** | No finding | `test_model_chain_sentinel.py`: sentinels in attribute values, geometry and the names of derived layers, a name-shaped one in an error; no sentinel in any message sent to the model (plan, re-plan input, error texts). The data-release flag flipped: the model input is the same byte for byte (D10). End to end (WP79): a sentinel in the data never appears in the stub's request log. |
| **No intermediate result is written** | No finding | A step is its query object and a count (`count_query`); only the adoptable step gets a stamp, within the result-size limit. Walking every model route as an administrator and as a user writes `model_action`, `model_action_step` and, since #43, `model_call` (an insert per re-plan), nothing else; the view handed on is a `LayerView` whose writes raise; no name of a data-core write is on the path (`test_walking_every_model_route_writes_the_action_record_only`, `test_the_model_path_names_no_write_of_the_data_core`). |
| **Background task cancellation** | #44 | `abort` sets the run's cancel event; the run checks it before every step and around a re-plan's call, and the store refuses the next step once the abort is written (one compare-and-set, `_going_on`). A run outliving its budget is given up (`_run_expired`), a `running` record found at start-up is closed `interrupted`. At shutdown the calls and runs in flight were not cancelled (#44). |
| **Resource exhaustion** | #40, #42, #43 | 8 steps, re-planned ones included (`step_limit`), at most 2 re-plans; 10 000 objects (`result_too_large` at the last step, the stamp within the limit); 10 s per step; 120 s per model call, the planning call's and each re-plan's own, both tested on an injected clock; 300 s per request; one run per account among the model-call slots (4). Found: a refused plan stored whole (#40), the chain's queries outside the instance's query slots (#42), re-plans outside the request limit (#43). The comparison keeps the result-size limit and one time budget for all its reads. |
| **The accepted residual risk of D9, re-read** | Still acceptable, restated | See "Accepted residual risks (E2.5)" below: the count oracle is real, bounded, and an open decision for external connections without data release. |

### New findings

| # | Priority | Finding | Impact |
|---|---|---|---|
| 40 | **Low** | **A refused plan was stored whole.** `_bounded` (`record/store.py`) limited a refused answer's raw `query` only (#35); a plan has `steps`, and its schema had no upper bound on their number, nor on a step's `arguments`. | A plan refused for `step_limit` or any check kept every step as the model sent it: up to the answer's size (1 MB, #34) per record, written to the database and sent with every poll of the record and the log. |
| 41 | **Low** | **The comparison was a `GET` that writes.** `GET /api/model/actions/{id}/comparison` sets `previewed_at` on a waiting side, as the preview does, and the origin check (#8) covers changing methods only. | The same as #39 for the preview: guarded by the `SameSite=Strict` cookie alone, another page could make a signed-in browser compare, and the log claims previews of proposals the user never saw. Nothing leaks. |
| 42 | **Low** | **A chain's queries ran outside the instance's query slots.** A step's count and the adoptable step's stamp run in the chain's thread, not in a request, and took no slot of the count that bounds queries at once (#5); neither did the stamp of an abort. | Every running chain (one per account, up to the four model-call slots) adds a query of up to 10 s beside the instance's cap of 8: with Modus A saturated, 12 queries at once on a server sized for 8, and the cap that keeps sign-ins and everyone's work responsive did not hold. |
| 43 | **Medium** | **A chain outlived its level and its connection's request limit.** A re-plan, and a `run` after a halt, made new model calls under the record's level whatever the account's level was now: a level the administrator had edited, or taken from the user, kept governing. The request limit (P5) counted a chain once, at its plan; its re-plans were not counted. | A chain halted for approval can be resumed days later and re-plan under a level the administrator closed (approve and run judge the snapshot, M7.3). A connection whose limit caps a paid model's bill was exceeded up to threefold by chains (a plan and two re-plans each). |
| 44 | **Low** | **Shutdown left calls and runs going.** `ModelCalls.shutdown` cancelled the timers and the calls not started, but set no cancel event. | A chain running at shutdown went on starting steps and could send a re-plan to the model while the process stopped; a call queued at that moment found no event set. Its record is closed at the next start either way. |

### Status of #40–#44

| # | Fixed |
|---|---|
| 40 | A refused plan keeps its first `MAX_STEPS` steps, and their arguments only while together within 64 kB of canonical JSON, else each step's are `{"omitted": "too large"}`. `PlanAnswer.steps` has an upper bound in the parsing schema (`MAX_PLAN_STEPS`, 64): a plan beyond it is `model_unreadable`, one between 9 and 64 steps is `step_limit` as before. Tested with a 1 MB plan. |
| 41 | The comparison is `POST /api/model/actions/{id}/comparison` (client, fakes, e2e and plan section 6, P7 and WP76 follow); a cross-site `POST` is refused by the origin check, runs nothing and leaves `previewed_at` unset (tested). |
| 42 | The instance's count of queries at once is one counter shared by requests and threads (`QuerySlots`; a request still waits in the event loop, on no worker thread). Each step and each stamp of a chain takes a slot from it in the chain's thread and gives it back in `finally`, waiting no longer than the query time limit and the request's deadline leave, and no longer than an abort. A step that gets none stops the run before it: `limited`, `interrupted`, `busy` naming the step (or `aborted`, `time_limit` when that came first); never past the cap. A stamp without a slot leaves the result unstamped, as when its run fails. **`abort`** waits for no slot: it takes one if one is free, else its result is offered unstamped, as `_stop_quietly` leaves it, and `adopt` stamps it under its own slot; an abort must answer at once and never fail `busy`, and an unstamped result loses nothing (decided at the gate). Tested with a saturated instance (the step waits, then stops; a slot that comes free lets it go on; the chain never holds more than one), and an abort without a free slot. |
| 43 | Before a re-plan, and at `run` after a halt, the account's current level must still be the record's (id, matrix, system-prompt hash; the name does not count). Otherwise the chain stops `limited`/`replan_limit` with `level_not_available`, `details.reason` `changed`, before any model call; its last complete result stays adoptable. A re-plan is a model call of its own for the request limit: counted on the day it happens (`model_call`, migration **0012**, one row per re-plan with its connection and time) and refused at the limit before its call (`replan_limit`, `quota_exceeded` with the limit); prompts count them too. Tested: a level edited (matrix, system prompt) or taken away stops the next re-plan and the run after a halt, a renamed one does not; re-plans count toward the limit and the next prompt is refused. M7.3 still holds for everything the record governs (cells, halts, approvals). |
| 44 | `shutdown` sets every cancel event in flight before it stops the pool: a call not sent is not sent, an answer is dropped, a chain starts no further step or re-plan (tested). |

### Accepted residual risks (E2.5)

- **The D9 count oracle, restated.** A hostile endpoint (an external model, or
  a local one taken over) can single out one feature, by `near_feature` with
  a guessable feature id and a tiny distance, or by equality on a unique
  released attribute, and learn about one bit per step of a released
  attribute: a count of 0 or 1 for a condition it chooses. At most 8 counts
  per request (steps, re-planned ones included) and 2 re-plans. It holds with
  the data release off as well as on, and on external connections. It is
  bounded by: released attributes only (the layer profile), conditions the
  controls can show (D3), at most 8 conditions per query, the user's own
  requests (the model cannot start one), and the request limit (off by
  default; it now counts every call, #43). Under *Automatisch* and
  *Teilautonom* it runs without a person looking until the log shows it.
  Accepted for local connections. **Open decision, not implemented:** for
  external connections without data release the integrator has put the
  choice to the user: report only empty/non-empty, or a bucketed count, or
  no re-plans at all.
- **Model-call slots held by a chain.** A run holds its account's model-call
  slot for up to about 325 s (the 300 s request, two step limits for the step
  at the deadline and the stamp, and the grace), the re-plans' calls
  included. Four accounts running chains fill the four slots; other prompts
  get `503 busy` meanwhile.
- **Cost.** The request limit now counts calls, not requests (#43): a chain
  spends up to three of a connection's day. The per-account daily limit
  advised before a cloud demo with a paid key (E2.4) applies all the more.
- **Changes in flight.** A run reads the layer profile and the account's view
  once per run stretch (from `run` to its end or a halt): an attribute or a
  layer withdrawn during the stretch is seen at the next stretch or re-plan,
  not at the next step. The level is checked at each re-plan and each `run`
  after a halt (#43), not before every step.
- **Tokens.** `run` and `compare` take any signed-in credential until E4, like
  `prompt` and `execute` (E2.4): a token can run a chain the person's level
  already allows (`auto` cells) and ask for a comparison's repeat; `adopt`,
  the plan's edit, the comparison and every approval need an interactive
  session.
