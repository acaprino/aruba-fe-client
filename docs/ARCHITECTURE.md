# Architecture

Deep dive into how `aruba-fe-client` talks to the Aruba portal, the design decisions behind the code, and the roadmap for known limitations.

For the public API and quick-start examples see the [README](../README.md).

## HTTP flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. GET /api/oauth2/authorization/gateway?originaluri=<app_root>     │
│    → 302 to loginfatturazione.aruba.it (Keycloak OIDC + PKCE)       │
│ 2. cheerio extracts <form action="…"> from the Keycloak page        │
│ 3. POST form-urlencoded {username, password, credentialId=""}       │
│    → 302 with ?code=… to the Aruba callback                         │
│    → Aruba exchanges the code and sets the session cookie           │
│ 4. GET /api/session-info → loggedVatCode + fiscalYearList           │
│ 5. POST /services/FatturaRicevutaFrontEnd/advancedSearch            │
│    Body:    {"PageNumber":1,"PageSize":null,"AnnoFiscale":<year>}   │
│    Headers: Aru-Sub, Aru-Delegator = ARUBA<P.IVA>                   │
│ 6. Items[] → toFattura() → client-side date filter → dedup          │
└─────────────────────────────────────────────────────────────────────┘
```

For the on-demand XML extraction (step 7+):

```
┌─────────────────────────────────────────────────────────────────────┐
│ 7. POST /services/FatturaRicevutaFrontEnd/ExtractXmlInvoiceReceived │
│    Body:    {Id: <id_aruba>, AnnoFiscale: <year>}                   │
│    Headers: same Aru-Sub/Aru-Delegator as advancedSearch            │
│    Response: { Content: <base64 XML> }                              │
│ 8. Buffer.from(content, 'base64').toString('utf8') → raw XML        │
│ 9. parseFatturaPa(xml) → { voci, causale, dati_pagamento }          │
└─────────────────────────────────────────────────────────────────────┘
```

Endpoint #7 isn't documented anywhere — it was discovered by sniffing the portal's network traffic with Playwright (May 2026) while the operator clicked the "view invoice" button. The auth model is the same as `advancedSearch`.

### Sent (active) invoices

Same flow, different endpoints. Steps 1-4 are identical (login + session-info). Steps 5-9 use the `FatturaInviataFrontEnd` namespace:

```
5'. POST /services/FatturaInviataFrontEnd/advancedSearch         (verified)
6'. Items[] → toFatturaSent() — counterparty in `Destinatario`
7'. POST /services/FatturaInviataFrontEnd/ExtractXmlInvoiceSent  (inferred)
```

The `advancedSearchSent` endpoint is the one the portal calls on the "Fatture inviate" tab — confirmed. The XML-extraction verb on the sent side is **inferred by symmetry** with the received endpoint (`ExtractXmlInvoiceReceived` → `ExtractXmlInvoiceSent`). Until someone confirms it against a real account, treat `extractXmlInvoiceSent` as best-effort: the function accepts an `opts.endpoint` override so callers who sniff the real verb can swap it without patching the library.

The Item shape on the sent side is symmetrical: counterparty denomination lives in `Destinatario` instead of `Mittente`, while `CodicePrimario` / `CodiceSecondario` keep their meaning (counterparty VAT / CF). `toFatturaSent` handles the rename and tags the Fattura with `direzione: 'attiva'`. The Fattura shape is otherwise identical to the passive one — same `controparte`, `controparte_piva`, `controparte_cf` field names, so a caller can collect both directions into the same store and discriminate on `direzione` alone.

## Design decisions

### Why scrape instead of using the official REST API

Aruba's official REST API (`ws.fatturazioneelettronica.aruba.it`) sits behind the **"deleghe utente" / "abilita accesso API"** flag, which many commercial plans don't include. In production the call fails with:

```
Errore deleghe utente
```

…even with valid credentials, because the OAuth2 password-grant token has no API delegation. The web portal flow uses different endpoints (Keycloak OIDC + internal services) that bypass the gate — same credentials, different surface. The library is the minimal HTTP harness needed to consume those endpoints from server-side code.

### `PageSize: null` on `advancedSearch`

The portal frontend sends `PageSize: null` and Aruba responds with the entire year in one shot (no pagination cursor). The library follows the same contract. Trade-offs:

- **Pro**: one HTTP call per year regardless of invoice count — no pagination loop to get wrong.
- **Risk**: if Aruba ever silently caps the response, the call would succeed but lose envelopes without warning. The library does not detect this; downstream callers (e.g. anima-manager's `arubaClient.js`) can add a heuristic by counting `items.length === 100 / 500 / 1000` and refusing to advance any incremental cursor.

### Server-side filter is fiscal year only

Despite the portal UI having date pickers, the server filter on `advancedSearch` is **only `AnnoFiscale`**. The library iterates years in `[dateFrom, dateTo]` and applies the date filter client-side. A multi-year range therefore costs N HTTP calls.

### Per-year error isolation in `fetchFatturePassiveByYears`

Early versions threw on the first failing year, which lost progress on later years (a 502 on 2023 erased the 2024+ pulls). The current version collects per-year errors in `stats.yearErrors[]` and continues. The caller decides whether the partial result is usable.

### `session-info` 5-minute TTL cache

`getVatCode` and `getFiscalYearList` both consume `/api/session-info`. The response is cached on the `got` instance (`http.__sessionInfoCache`) with a 5-minute TTL.

- The cache is per-`http`-instance, not global — it dies when the `got` client is garbage-collected.
- The 5-minute TTL exists because long-running workers (Cloud Functions with ~9 min budget) can cross a fiscal-year rollover or a session re-issue during a single sync. Stale cache there would mis-identify the queryable year list.

### UTC-anchored `data` field in `Fattura`

`models.cjs::ymd()` formats the date in UTC, not local time. Aruba returns timestamps with explicit `+02:00` offsets, so an invoice timestamped `2026/01/01 02:30:00+02:00` is `2025-12-31T00:30Z`. Local-tz formatting would produce:

- UTC server: `2025-12-31` (correct)
- Europe/Rome dev: `2026-01-01` (off by one day)

The mismatch broke any logic that bucketed invoices by `data` (year-freeze in particular). UTC is the only stable choice.

### Stripping XML namespaces with a regex

`fatturaPaParser.cjs::stripXmlNs` removes the `ns0:` / `p:` prefixes from the raw XML *before* feeding it to cheerio in xmlMode. The alternative (querying with namespace-aware selectors) is more correct but adds verbosity for no functional gain — both `ns0:` and `p:` are used by FatturaPA tooling for the same XSD, and the parser only reads a small slice of the document.

### Cookies stay in-memory

The library does not serialize the `tough-cookie` jar anywhere. Every `login()` call performs a fresh OIDC handshake (~2-3 seconds). For workloads that pay this cost frequently, callers can serialize via `cookieJar.toJSON()` and restore with `CookieJar.fromJSON()` — but they must handle encryption at rest themselves.

### `got@14` is ESM-only

`got@14` is published as ESM only. The library is CommonJS, so it loads `got` via a cached dynamic `import()` in `getGot.cjs`. Cold-start cost: ~50-150 ms on the first call per process. The cache is reset on rejection so a transient cold-start failure doesn't poison the process for its lifetime.

## Roadmap

Backlog for when requirements or problems emerge:

- **[H] Cookie-jar cache hook** — the library doesn't ship caching to avoid mandating a storage backend, but a `cacheAdapter` option (`{ get(key), set(key, value, ttl) }`) would let callers persist `cookieJar.toJSON()` with their own encryption. Saves one Keycloak login per sync (~2-3s).
- **[H] Extended `STATO_CODE_MAP`** — only codes 1 and 2 map to `consegnata`. Other states resolve to `sconosciuto` but `stato_code` is preserved in the `Fattura`. Extend `src/models.cjs::STATO_CODE_MAP` as new codes appear in real data.
- **[H] Confirm the `extractXmlInvoiceSent` URL** — the verb is inferred from the received-side naming. Until verified live against a real account, callers should be prepared to override `opts.endpoint`. Once confirmed (or corrected), update the default in `config.cjs::ENDPOINTS.extractXmlSent`.
- **[M] Retry with backoff on 5xx** — `advancedSearch` / `advancedSearchSent` have no built-in retry on POST. A single retry with jitter on 502/503/504 would absorb transient blips. Must respect Aruba's anti-bot posture (no observed rate limit today, but Akamai is in the path).
- **[L] `curl-impersonate` fallback** — if Akamai introduces TLS-fingerprint bot detection, swap `got` for `curl-impersonate-node`. A compatible wrapper would live in `getGot.cjs`.
- **[L] CAPTCHA detection** — if `Keycloak login form not found` recurs, parse the error HTML more carefully to distinguish "CAPTCHA required" from "template changed".

## Comparison with the official REST client

| Aspect | Official REST | This library (web-scraper) |
|---|---|---|
| Auth endpoint | `auth.fatturazioneelettronica.aruba.it/auth/signin` (OAuth2 password grant) | `loginfatturazione.aruba.it` (Keycloak OIDC + PKCE) |
| Data endpoint | `ws.fatturazioneelettronica.aruba.it/services/invoice/in/*` | `fatturazioneelettronica.aruba.it/services/FatturaRicevutaFrontEnd/*` |
| Required permission | **API access / deleghe utente** (gated) | Web login only (universal) |
| Token lifecycle | access 30 min + refresh 60 min | Session cookie in-memory per call |
| Payload | Includes FatturaPA XML base64 in `file` | Metadata + on-demand XML extraction |
| Server-side filters | `startDate` + `endDate` precise | Fiscal year only (date filter applied client-side) |
| Pagination | `?page=&size=` (cap 100/page × 10 pages = 1000) | `PageSize: null` → full year in one response |
| Anti-bot | Documented 12 find req/min/IP | Akamai CDN only (no public rate limit) |

## Project structure

```
aruba-fe-client/
├── src/
│   ├── auth.cjs                 Keycloak OIDC + session validation
│   ├── api.cjs                  Portal calls + session-info cache
│   ├── models.cjs               Item → Fattura mapper + Aruba date parser
│   ├── fatturaPaParser.cjs      Slim FatturaPA v1.2 XML parser (cheerio)
│   ├── config.cjs               URLs + timeouts (no env vars)
│   ├── getGot.cjs               ESM-import shim for got@14 from CJS
│   └── index.cjs                Public barrel
├── tests/
│   ├── fatturaPaParser.test.cjs 7 cases — XML parser edge cases
│   └── models.test.cjs          14 cases — Item mapper (passive + active) + date parser + UTC ymd
├── docs/
│   └── ARCHITECTURE.md          This file
├── README.md                    Quick start + API reference + failure modes
├── LICENSE                      MIT
└── package.json                 Deps: cheerio, got@14, tough-cookie@4
```

No build step. Pure CJS, tests run with `node` directly (no test runner).
