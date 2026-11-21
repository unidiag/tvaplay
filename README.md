# TVAPLAY

**TVAPLAY** is a Go-based IPTV platform with a legacy-compatible **JavaScript ES5 + jQuery 2.2.4 TV interface**, a **React** administration interface, HLS streaming, an EPG, catch-up TV archives, subscription packages, and external billing integration.

**Website:** https://tvaplay.com  
**Source repository:** https://github.com/unidiag/tvaplay  
**Commercial licensing:** https://tvaplay.com  
**Rights holder contact:** info@tva.by


## Contents

- [Features](#features)
- [Architecture](#architecture)
- [TV UI and device compatibility](#tv-ui-and-device-compatibility)
- [Live streaming and archives](#live-streaming-and-archives)
- [Authentication, subscriptions, and billing](#authentication-subscriptions-and-billing)
- [HTTP endpoints](#http-endpoints)
- [API v2: external billing integration](#api-v2-external-billing-integration)
- [Building and running](#building-and-running)
- [Configurable HTTP listen address](#configurable-http-listen-address)
- [Operational checklist](#operational-checklist)
- [Copyright and license](#copyright-and-license)

## Features

### TV application

- Live IPTV playback using a dynamically generated M3U playlist, channel groups, channel logos, and fullscreen mode.
- Electronic Program Guide (EPG), including currently airing programmes and progress indicators.
- Catch-up TV archive: browse programmes, play recordings, pause, seek, and move between programmes.
- Archive programme search and filtering by favorite channels.
- Favorite channels with local preference storage.
- Remote-control navigation and modal dialogs with focus management.
- JSON-based localization; the available language catalog is served at `/languages.json`.
- Service area for account details, devices/sessions, speed testing, and settings.
- Optional Media Station X (MSX) entry point.

### Server

- Go HTTP server, internal TV API, and React administration UI.
- UDP/IPTV to HLS through independent FFmpeg processes and an HLS proxy.
- Temporary live HLS segments and token-protected playback.
- Per-channel archive recordings, retention policies, and cleanup of old/partial files.
- Multiple archive storage locations, recording migration, and disk I/O metrics.
- EPG ingestion and archived-programme search.
- SMS login, JWT access/refresh sessions, and device administration.
- Subscription packages, balances, billing operations, and financial transaction history.
- **API v2** for external billing: subscriber lookup, session revocation, status changes, balance operations, external billing IDs, and package replacement.
- Viewing statistics and background maintenance workers.

## Architecture

```text
Smart TV / Android TV / Browser / MSX       React Admin       External Billing
                  |                             |                    |
                  +-----------------------------+--------------------+
                                                |
                                          Go HTTP server
                                           /    |     \
                                          /     |      \
                                  TV/API       HLS       API v2
                                    |           |           |
                               MySQL/GORM  FFmpeg/HLS   X-API-Key
                                    |           |
                                EPG/users   IPTV sources
                                packages    archive disks
```

Major server files:

| File | Responsibility |
|---|---|
| `main.go` | Startup, background workers, build metadata |
| `webserver.go` | HTTP route registration |
| `api.go`, `api_*.go` | Internal TV client JSON API |
| `api_v2.go` | External billing API |
| `auth.go`, `billing.go` | JWT authentication and billing |
| `models/` | GORM models for subscribers, packages, and transactions |
| `playlist.go` | M3U playlist generation |
| `epg.go`, `api_epg.go` | Programme guide and EPG API |
| `hlsworker.go`, `hlsproxy.go`, `hls_token.go` | FFmpeg/HLS pipeline, proxy, and tokens |
| `archive_record.go`, `archive_playback.go` | Archive recording and playback |
| `archive_storage.go`, `archive_move.go` | Storage management and recording migration |
| `archive_search.go` | Archive search |
| `view_stats.go`, `storage_io.go`, `storage_metrics.go` | Viewing statistics and disk metrics |
| `msx.go` | Media Station X support |
| `frontend/` | React Admin, TV UI, and static assets |
| `make` | Project-specific build/deployment script; inspect before running |

## TV UI and device compatibility

The TV UI consists of numbered JavaScript modules (`frontend/public/app/`) and runs independently of React. It deliberately targets **ES5** for compatibility with older LG webOS, Samsung Smart TV, and embedded browsers. When modifying TV UI code, prefer `var`, ordinary functions, and jQuery instead of making ES modules, `fetch`, or native `Promise` mandatory.

Relevant modules include `20-pages.js` (pages and keyboard/remote navigation), `12-modalFocus.js` (modal focus), `20-epg.js`, `31-playerPage.js` (live playback, archive, fullscreen), `32-favoritesPage.js`, `33-searchPage.js`, `34-servicePage.js`, and `04-i18n.js`.

Smart TVs use native HLS when supported. Some desktop browsers use `hls.js`. Codec support and smooth UI navigation depend on the browser and device. Avoid expensive DOM rebuilding, repeated layout reads, and large DOM scans in every remote-control key handler without device testing.

## Live streaming and archives

**Live playback:** IPTV source → FFmpeg → local HLS segments → HTTP proxy → TV client. `hlsManager` supervises HLS worker processes. Temporary live segments are stored separately from the long-term recording archive. Live and archive URLs use server-side tokens and/or signatures as appropriate.

**Catch-up archive:** the server records per-channel, approximately one-minute `.ts` files. Retention is controlled by channel settings. The archive subsystem supports selectable storage locations, checks disk availability, removes expired recordings and partial files, and provides separate playback routes. EPG and search results can be used to open recordings for specific programmes.

Test live streams and archives independently on older TVs: TS compatibility, segment transitions, seeking, remote-control behavior, and buffering all matter.

## Authentication, subscriptions, and billing

- TV UI login uses SMS verification, access/refresh JWTs, and a device identifier.
- In the documented build: **access-token lifetime: 10 minutes; refresh-token lifetime: 45 days**. Always verify against the deployed build.
- Revoking refresh sessions does not necessarily invalidate an already-issued access JWT immediately.
- Subscribers are associated with service packages; package activation timestamps are stored as `enabled_at`.
- External billing integrations use **API v2**, separate from the TV client's JWT-protected API.

## HTTP endpoints

| Route | Purpose |
|---|---|
| `GET /` | TV UI |
| `GET /admin` | React Admin |
| `GET /app/main.js` | Bundled TV application JavaScript |
| `GET /app/main.css` | Main TV UI styles |
| `POST /api` | Internal JSON API with an `op` field |
| `GET /playlist.m3u` | IPTV playlist |
| `GET /api/epg/archive` | Archive programme guide |
| `POST /api/archive/play` | Initialize archive playback |
| `/api/archive/search` | Archive programme search |
| `/archive/` | Archive HLS/TS delivery |
| `/api/hls/token` | Obtain an HLS access token |
| `/api/v2/…` | External billing API |
| `GET /languages.json` | Language catalog |
| `/msx/start.json`, `/msx/app.json` | Media Station X |
| `GET /up_balance.jpg` | Balance top-up QR code |

Internal TV endpoints have their own authorization, GeoIP and parameter rules; they do **not** automatically use the API v2 `X-API-Key` header.

Internal API example:

```bash
curl -X POST 'https://tv.example.com/api' \
  -H 'Content-Type: application/json' \
  -d '{"op":"guestHandshake"}'
```

# API v2: external billing integration

> **Important protocol change:** The secret API key **must not appear in the URL**. Send it in the **`X-API-Key` HTTP header**. Old URLs such as `/api/v2/<API_KEY>/getUser/...` are not compatible with commit `96bcc926`.

## Purpose and authentication

Base path: **`/api/v2/<FUNCTION>/...`**.

```http
GET /api/v2/getUser/%2B375291111111 HTTP/1.1
Host: tv.example.com
X-API-Key: your-secret-api-key
```

The server compares the supplied secret with the `api_key` server setting using SHA-256 and constant-time comparison. A missing server-side key disables the API (`503`). A missing or incorrect `X-API-Key` results in `401`.

The handler supports HTTP `GET` and `POST`; **read endpoints require `GET`**. Mutating endpoints accept both methods in the documented revision, but external clients should **always use `POST`** for writes.

- JSON responses include `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.
- Function names are case-sensitive: `getUser`, not `getuser`.
- `<LOGIN>` means `users.login`; phone-style logins with and without `+` are supported. Lookup prioritizes `id ASC`.
- `<BillingID>` is a positive external `users.billing_id`; **it is not `users.id`**.
- URL-encode all variable path components.
- Use HTTPS, `POST`, and `X-Idempotency-Key` for financial mutations.

## API v2 endpoint reference

| Method | Path relative to `/api/v2/` | Description |
|---|---|---|
| `GET` | `getUsers` | List all subscribers |
| `GET` | `getUsers/<STATUS>` | Filter by status `0…9` |
| `GET` | `getUser/<LOGIN>` | Subscriber, refresh sessions, active packages |
| `POST`¹ | `delUser/<LOGIN>` | Revoke all refresh sessions |
| `POST`¹ | `setUser/<LOGIN>/status/<VALUE>` | Set user status `0…7` |
| `POST`¹ | `setUser/<LOGIN>/balance/<AMOUNT>` | Set an **absolute** balance |
| `POST`¹ | `setUser/<LOGIN>/info/<TEXT>` | Update user information/comment |
| `POST`¹ | `setUser/<LOGIN>/billing_id/<ID>` | Set or clear external billing identifier |
| `POST`¹ | `addBalance/<BillingID>/<AMOUNT>` | Add a positive amount to the balance |
| `POST`¹ | `adjBalance/<BillingID>/<AMOUNT>` | Apply a positive or negative adjustment |
| `POST`¹ | `setPackage/<LOGIN>/<PACKAGE_ID>[/<PACKAGE_ID>...]` | **Replace the complete set** of subscriber packages |

¹ In the documented handler, mutating operations also accept `GET`; using GET for state changes is **strongly discouraged**.

## `getUsers`: list subscribers

```bash
curl -fsS 'https://tv.example.com/api/v2/getUsers' \
  -H "X-API-Key: $TVAPLAY_API_KEY"

curl -fsS 'https://tv.example.com/api/v2/getUsers/1' \
  -H "X-API-Key: $TVAPLAY_API_KEY"
```

Returns a **JSON array** of public `models.User` fields sorted by `id ASC`; an empty result is `[]`. The status filter accepts `0–9`, which differs from the `setUser/status` range. Password fields, recent SMS verification codes, and other sensitive fields are omitted.

## `getUser`: subscriber details

```bash
curl -fsS 'https://tv.example.com/api/v2/getUser/%2B375291111111' \
  -H "X-API-Key: $TVAPLAY_API_KEY"
```

The response has three top-level members:

```json
{
  "user": {"id": 15, "login": "+375291111111", "status": 1, "balance": "10.00", "billing_id": 12345},
  "sessions": [{"id": 23, "uid": "device-uid", "ip": "192.0.2.10", "user_agent": "TV Browser", "created_at": "2026-11-08T10:00:00Z", "expires_at": "2026-12-08T10:00:00Z", "active": true}],
  "packages": [{"id": 2, "name": "Sport", "enabled_at": "2026-11-08T10:30:00Z", "disable_available_at": "2026-11-09T10:30:00Z"}]
}
```

This is an **abbreviated illustrative response**. Actual user and package attributes depend on the models' JSON tags. The `sessions` array can contain expired records until removed from the database; `active` is derived from `expires_at`. Refresh secrets and JTI values are not exposed. Packages are ordered by `position, id`, and `disable_available_at` is calculated from the activation timestamp according to server rules.

## `delUser`: revoke device sessions

```bash
curl -fsS -X POST 'https://tv.example.com/api/v2/delUser/%2B375291111111' \
  -H "X-API-Key: $TVAPLAY_API_KEY"
```

Deletes **only refresh-token sessions** from `user_refresh_tokens`. It does **not** delete the subscriber, their balance, or package assignments.

```json
{"status":"OK","login":"+375291111111","deleted_sessions":3}
```

## `setUser`: modify subscriber fields

```bash
# Status: integer 0..7
curl -X POST 'https://tv.example.com/api/v2/setUser/%2B375291111111/status/1' -H "X-API-Key: $TVAPLAY_API_KEY"

# Absolute balance, NOT a top-up
curl -X POST 'https://tv.example.com/api/v2/setUser/%2B375291111111/balance/10.00' -H "X-API-Key: $TVAPLAY_API_KEY"

# Information/comment: URL-encoded text
curl -X POST 'https://tv.example.com/api/v2/setUser/%2B375291111111/info/Contract%20123' -H "X-API-Key: $TVAPLAY_API_KEY"

# Assign external billing identifier
curl -X POST 'https://tv.example.com/api/v2/setUser/%2B375291111111/billing_id/12345' -H "X-API-Key: $TVAPLAY_API_KEY"
```

- `status`: valid range `0–7`; this is an administrative update, not a user's self-service pause action.
- `balance`: absolute `DECIMAL(12,2)` balance. Negative values are allowed. An actual balance change is recorded in the transaction journal.
- `info`: must be valid UTF-8; maximum **10,000 bytes**. In this revision a `+` character is converted to a space; encoded `/` characters can be affected by reverse-proxy path handling.
- `billing_id`: unsigned 64-bit integer. Positive IDs must be unique across users. **`0` clears the external assignment** and is allowed for multiple users. A duplicate positive ID produces `409`.

Example response:

```json
{"status":"OK","login":"+375291111111","field":"billing_id","value":12345}
```

## `addBalance`: top up by BillingID

```bash
curl -X POST 'https://tv.example.com/api/v2/addBalance/12345/25.50' \
  -H "X-API-Key: $TVAPLAY_API_KEY" \
  -H 'X-Idempotency-Key: payment-2026-000123'
```

- `BillingID` must be a **positive** `users.billing_id`. This endpoint does **not** look up `users.login`.
- `AMOUNT` must be **greater than zero** and have at most two decimal places. Calculations use integer minor currency units rather than `float64`.
- Both the balance update and transaction journal insertion happen inside **one database transaction** with a subscriber row lock.
- An unknown BillingID produces `404`; an ambiguous BillingID produces `409` and no credit is applied.
- `X-Idempotency-Key` makes a retry of the **same payment** safe: the same key and amount yields `repeated: true` without crediting again. Reusing the key with a different amount produces `409`.
- **Without `X-Idempotency-Key`, each request is a separate operation**: retries may credit the account twice.

```json
{"status":"OK","billing_id":12345,"login":"+375291111111","amount":"25.50","balance":"35.50","repeated":false,"transaction_id":1001}
```

On an idempotent replay, `balance` describes the value **immediately after the original transaction**, not necessarily the subscriber's current balance.

## `adjBalance`: adjust by BillingID

```bash
# Debit 7.00
curl -X POST 'https://tv.example.com/api/v2/adjBalance/12345/-7.00' \
  -H "X-API-Key: $TVAPLAY_API_KEY" \
  -H 'X-Idempotency-Key: adjustment-2026-000124'
```

`AMOUNT` must be **nonzero**: a positive number increases the balance, and a negative number decreases it. Subscriber lookup, locking, and journaling follow the same principles as `addBalance`, but the journal marks this as an adjustment. Idempotency is scoped to the operation type, subscriber, and external key. Without the key, each request is a new adjustment.

```json
{"status":"OK","billing_id":12345,"login":"+375291111111","amount":"-7.00","balance":"28.50","repeated":false,"transaction_id":1002}
```

### Monetary value constraints

Accepted amount format: `^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$`. No whitespace, exponent notation, or comma decimal separator. Values use `DECIMAL(12,2)` in the database. The implementation separately checks the ±9,999,999,999.99 bounds and the resulting balance. `addBalance` rejects zero/negative amounts; `adjBalance` permits negative amounts but rejects zero. Idempotency keys may not exceed **128 bytes** or contain CR/LF.

**Important:** `setUser/.../balance/...` sets the **absolute balance**, whereas `addBalance` increments it. Use the former for administrative reconciliation, the latter for payments.

## `setPackage`: atomically replace packages

```bash
curl -X POST 'https://tv.example.com/api/v2/setPackage/%2B375291111111/2/5/9' \
  -H "X-API-Key: $TVAPLAY_API_KEY"
```

This endpoint **replaces the entire set** of assigned packages; it does not add to the existing set. After this example the user has only `[2,5,9]`.

1. Each package ID must be a positive `uint32`; duplicate IDs are deduplicated.
2. Every requested package must exist; otherwise the server returns `404` without a partial update.
3. Associations absent from the requested set are removed within one transaction.
4. Unchanged assignments retain their original `enabled_at` value.
5. Newly added assignments receive `enabled_at = now`.
6. The response contains the final set plus `added`, `removed`, and `unchanged` lists.

```json
{"status":"OK","login":"+375291111111","packages":[2,5,9],"added":[9],"removed":[3],"unchanged":[2,5]}
```

**Limitation:** at least one `<PACKAGE_ID>` is required. The current route cannot clear *all* packages using an empty list. Empty Go nil slices in `added`, `removed`, or `unchanged` may be serialized as `null`, not `[]`; clients should handle either.

## Error format and HTTP status codes

Typical API v2 error response:

```json
{"status":"ERROR","message":"User not found"}
```

| HTTP status | Meaning |
|---|---|
| `200` | Successful operation |
| `400` | Invalid ID, amount, status, package, field, or idempotency key |
| `401` | Missing or invalid `X-API-Key` |
| `404` | User, package, BillingID, or endpoint not found |
| `405` | Wrong HTTP method (`getUsers` and `getUser` require GET) |
| `409` | Duplicate `billing_id`, ambiguous BillingID, or idempotency conflict |
| `500` | Database or response serialization failure |
| `503` | API disabled: empty server-side `api_key` |

For writes, validate both the HTTP status and `status == "OK"`. `getUsers` returns an array; `getUser` returns an object with three sections, so do not assume a uniform success envelope across read endpoints.

## Example Go billing client

```go
package main

import (
    "fmt"
    "io"
    "net/http"
    "net/url"
    "os"
    "strings"
    "time"
)

func callV2(method, path, idempotency string) ([]byte, error) {
    base := "https://tv.example.com/api/v2/"
    req, err := http.NewRequest(method, base+path, nil)
    if err != nil { return nil, err }
    req.Header.Set("X-API-Key", os.Getenv("TVAPLAY_API_KEY"))
    if idempotency != "" { req.Header.Set("X-Idempotency-Key", idempotency) }
    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(req)
    if err != nil { return nil, err }
    defer resp.Body.Close()
    body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
    if err != nil { return nil, err }
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return nil, fmt.Errorf("API %s: %s", resp.Status, strings.TrimSpace(string(body)))
    }
    return body, nil
}

func main() {
    login := url.PathEscape("+375291111111")
    data, err := callV2(http.MethodGet, "getUser/"+login, "")
    if err != nil { panic(err) }
    fmt.Println(string(data))

    // Use a stable external payment ID as the idempotency key.
    data, err = callV2(http.MethodPost, "addBalance/12345/10.00", "payment-12345")
    if err != nil { panic(err) }
    fmt.Println(string(data))
}
```

### Integration security practices

1. Expose API v2 over HTTPS only; keep the high-entropy API key in an environment variable or secret manager.
2. **Never put the API key in a URL**; use `X-API-Key` exclusively.
3. Prevent proxies, tracing, and error reporting from logging `X-API-Key` values.
4. Restrict `/api/v2/` to trusted billing-system IP addresses or networks where possible.
5. Submit payments with `POST` and a **stable, unique** `X-Idempotency-Key`; retain the same key across retries.
6. Treat `409` as a conflict requiring investigation, not an invitation to retry with a new key automatically.
7. Limit the exposure and retention of subscriber/session personal data.
8. Recheck `apiV2PublicUser` whenever the database model gains new sensitive fields.

## Building and running

Prerequisites: the Go version required by `go.mod`, Node.js/npm for the React frontend, MySQL, FFmpeg, configured IPTV sources, and an SMS gateway. A GeoIP database may be needed if geographical access checks are enabled.

```bash
git clone https://github.com/unidiag/tvaplay.git
cd tvaplay
go mod download
(cd frontend && npm install && npm run build)
go build -o tvaplay .
```

The documented `main.go` checks for root privileges at startup. Configure a suitable service account/privilege model and filesystem permissions for networking, storage devices, and system resources. Supply database credentials and application secrets through your deployment configuration; do not commit secrets to Git.

> **Caution:** The project-specific `make` script may modify Git history and production services. Read it carefully before running it.

## Configurable HTTP listen address

By default, TVAPLAY listens on **`:8008`** (all network interfaces). You can optionally provide a listen address as the **first command-line argument after the executable name**. No configuration file argument is required.

```text
tvaplay [IP:PORT|:PORT]
```

In Go, the optional address is `os.Args[1]`: `os.Args[0]` is the executable name.

### Examples

```bash
# Default: all interfaces, port 8008
./tvaplay

# Loopback only, port 8000 (for a local reverse proxy)
./tvaplay 127.0.0.1:8000

# Specific IPv4 address, port 9000
./tvaplay 192.168.1.2:9000

# All interfaces, port 8888
./tvaplay :8888
```

| Listen address | Behavior |
|---|---|
| Not specified | Default `:8008`, all interfaces |
| `127.0.0.1:8000` | Loopback only, port 8000 |
| `192.168.1.2:9000` | Bind to the specified IPv4 address, port 9000 |
| `:8888` | All interfaces, port 8888 |

Validation requirements:

- Accept `IP:PORT` or `:PORT` (empty host) only; reject hostnames such as `localhost`.
- Require a decimal port between **1 and 65535**.
- Print an English usage message and exit with a nonzero status for invalid arguments.
- Binding to an unavailable address or occupied port is reported by the HTTP listener.

Invalid invocation:

```bash
./tvaplay not-an-address
```

Example error output:

```text
Invalid listen address: not-an-address
Usage: tvaplay [IP:PORT|:PORT]
Examples:
  tvaplay 127.0.0.1:8000
  tvaplay 192.168.1.2:9000
  tvaplay :8888
```

**Implementation note:** This section describes the proposed configurable listen address. The running binary must implement the corresponding parsing and validation in `main.go` before these options work. The HTTP listener is still `http.ListenAndServe(listenAddress, nil)`.

## Operational checklist

- [ ] Confirm the expected build version and date.
- [ ] Test localization, remote navigation, live playback, and archive playback on actual Smart TV and Android TV devices.
- [ ] Verify the playlist, EPG, and archive search against production data.
- [ ] Verify HLS proxy authentication and archive URL protection.
- [ ] Check recording, retention cleanup, and free space on every archive storage device.
- [ ] Configure database backups and disk space monitoring.
- [ ] Confirm API v2 authenticates through `X-API-Key`, not URL path secrets.
- [ ] Verify that an idempotent `addBalance` replay does not apply a payment twice.
- [ ] Verify negative `adjBalance` adjustments.
- [ ] Verify `setPackage` preserves `enabled_at` on existing packages and removes omitted packages.
- [ ] Check for conflicts before setting a positive `billing_id`.
- [ ] Verify the HTTP listener defaults to `:8008` and accepts the intended optional bind address after deployment.
- [ ] Confirm the intended use complies with the license below.

## Copyright and license

**Copyright © 2026 Private Enterprise "TVABY" (Частное предприятие «ТВАБАЙ»), Republic of Belarus. All rights reserved.**  
**Email:** [info@tva.by](mailto:info@tva.by)  
**Product and commercial licensing website:** [TVAPLAY.COM](https://tvaplay.com)

TVAPLAY is made available under the **[PolyForm Strict License 1.0.0](https://polyformproject.org/licenses/strict/1.0.0)**.

- **Noncommercial use:** Use of TVAPLAY for purposes permitted under PolyForm Strict 1.0.0 is free of charge, subject to the full license conditions.
- **Commercial use:** A separate paid commercial license must be purchased via **[TVAPLAY.COM](https://tvaplay.com)** **before** commercial use of the software.
- **Restrictions:** PolyForm Strict 1.0.0 does **not** grant permission to redistribute the software or to modify it or create derivative works. Such activities require separate authorization from the rights holder unless otherwise permitted by applicable law.
- **Rights:** All rights not expressly granted under the applicable license are reserved by Private Enterprise "TVABY".

The [official PolyForm Strict License 1.0.0 text](https://polyformproject.org/licenses/strict/1.0.0) governs use under that license. This summary is provided for convenience and does not replace or modify the official terms. Commercial license terms are provided separately by the rights holder.

---

TVAPLAY · [TVAPLAY.COM](https://tvaplay.com) · [GitHub](https://github.com/unidiag/tvaplay) · [info@tva.by](mailto:info@tva.by)
