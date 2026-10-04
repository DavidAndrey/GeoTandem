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
