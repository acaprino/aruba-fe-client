# aruba-fe-client

> A pure-HTTP Node.js client for **Aruba Fatturazione Elettronica** — Italian SDI invoices, without the "deleghe utente" REST gate.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](#requirements)
[![CommonJS](https://img.shields.io/badge/module-CJS-blue.svg)](#requirements)
[![Tests](https://img.shields.io/badge/tests-21%20passing-brightgreen.svg)](#tests)

Aruba's official invoicing REST API sits behind a per-account permission flag (**"deleghe utente"** / API access) that many commercial plans don't include — accounts without it just see `Errore deleghe utente` on every call. This library sidesteps that gate by speaking the **same Keycloak OIDC + internal portal endpoints** the Aruba web UI uses. Web credentials are enough.

```js
const { login, fetchFatturePassive } = require('aruba-fe-client');

const { http } = await login({ username, password });
const { fatture } = await fetchFatturePassive(
  http,
  new Date('2026-04-01'),
  new Date('2026-05-31'),
);

console.log(fatture[0]);
// { id_aruba, numero, data, direzione: 'passiva',
//   controparte: 'Wind Tre S.p.A.', importo_totale: 44.41, ... }
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Usage](#usage)
  - [Received (passive) invoices](#received-passive-invoices)
  - [Sent (active) invoices](#sent-active-invoices)
  - [Full-history pull](#full-history-pull)
  - [Single-invoice XML extraction](#single-invoice-xml-extraction)
  - [Logging](#logging)
- [API reference](#api-reference)
- [The `Fattura` shape](#the-fattura-shape)
- [Failure modes & recovery](#failure-modes--recovery)
- [Known limitations](#known-limitations)
- [Comparison with the official REST client](#comparison-with-the-official-rest-client)
- [Architecture](#architecture)
- [Tests](#tests)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Why this exists

If you've ever hit `Errore deleghe utente` calling the Aruba REST API, you know the problem: the auth flow works (`POST /auth/signin` returns 200 + access_token) but the first `GET /services/invoice/in/findByUsername` returns 403 because the account doesn't have the API delegation enabled — and the flag is gated behind enterprise plans you don't always have.

The Aruba **web portal** doesn't care about that flag. It uses a different endpoint family (Keycloak OIDC + internal `advancedSearch`) and works for every account that can log in via browser. This library replicates the same flow from Node.

**Trade-off**: `advancedSearch` returns metadata only (no FatturaPA XML inline). The full XML is available on demand via a separate per-invoice endpoint, exposed here as `extractXmlInvoiceReceived` / `extractXmlInvoiceSent` + a slim parser (`parseFatturaPa`).

## Features

- ✓ **Received (passive) invoices** — list, filter by date range or fiscal year, full metadata
- ✓ **Sent (active) invoices** — symmetric API on `FatturaInviataFrontEnd`
- ✓ **FatturaPA v1.2 XML extraction** per invoice + a slim parser for `voci` / `causale` / `dati_pagamento`
- ✓ **No "deleghe utente" needed** — works with any account that can log in to the web portal
- ✓ **Per-call credentials** — no env vars, no global state
- ✓ **Per-year error isolation** — a 502 on one year doesn't abort the whole pull
- ✓ **UTC-anchored dates** — no surprises on year-rollover when servers and dev boxes disagree on timezone
- ✓ **session-info cache** — `getVatCode` + `getFiscalYearList` share a single HTTP request
- ✓ **Zero global state** — every `login()` returns its own `got` client + cookie jar; safe under concurrent use
- ✓ **CommonJS by design** — drops into any Node 18+ project including Firebase Cloud Functions

## Install

```bash
npm install github:acaprino/aruba-fe-client
```

Pin to a tag for reproducible installs:

```bash
npm install github:acaprino/aruba-fe-client#v1.1.0
```

Or as a `package.json` dependency:

```json
{
  "dependencies": {
    "aruba-fe-client": "github:acaprino/aruba-fe-client#v1.1.0"
  }
}
```

### Requirements

- **Node.js ≥ 18**
- Aruba Fatturazione Elettronica account with web login (no 2FA)
- The library is **CommonJS**. `got@14` is loaded via dynamic `import()` from CJS so consumers don't need ESM themselves.

## Quick start

```js
const { login, fetchFatturePassive } = require('aruba-fe-client');

(async () => {
  // 1. Authenticate (fresh Keycloak OIDC handshake, ~2-3s)
  const { http } = await login({
    username: process.env.ARUBA_USERNAME,
    password: process.env.ARUBA_PASSWORD,
  });

  // 2. Fetch passive invoices in a date range
  const { fatture, stats } = await fetchFatturePassive(
    http,
    new Date('2026-04-01'),
    new Date('2026-05-31'),
  );

  console.log(stats);
  // { vat: 'IT01234567890', years: [2026], totalRaw: 12, inRange: 8, yearErrors: [] }

  console.log(fatture[0]);
  // { id_aruba: '6a04b986...', numero: 'F12345', data: '2026-05-13',
  //   direzione: 'passiva', controparte: 'Wind Tre S.p.A.',
  //   controparte_piva: 'IT12345678901', importo_totale: 44.41, ... }
})();
```

## Usage

### Received (passive) invoices

```js
const { login, fetchFatturePassive } = require('aruba-fe-client');

const { http } = await login({ username, password });

const { fatture, stats } = await fetchFatturePassive(
  http,
  new Date('2026-01-01'),
  new Date('2026-05-31'),
);
```

The date range maps to fiscal years client-side (Aruba's server filter is fiscal-year only), so cross-year ranges trigger one HTTP call per year. Each `Fattura` has `direzione: 'passiva'`.

### Sent (active) invoices

Symmetrical API to the passive one — same shape, just different functions:

```js
const { login, fetchFattureAttive } = require('aruba-fe-client');

const { http } = await login({ username, password });

const { fatture } = await fetchFattureAttive(
  http,
  new Date('2026-01-01'),
  new Date('2026-05-31'),
);

console.log(fatture[0].direzione);    // 'attiva'
console.log(fatture[0].controparte);  // counterparty (customer name)
```

The `Fattura` shape is identical for both directions; the discriminator is `direzione` (`'passiva' | 'attiva'`). Counterparty fields are unified — `controparte`, `controparte_piva`, `controparte_cf` — and represent the supplier for passive invoices, the customer for active ones.

### Full-history pull

`fetchFatturePassive` derives the year list from the date range. For a complete historical pull driven by Aruba's own list of queryable years:

```js
const {
  login,
  getFiscalYearList,
  fetchFatturePassiveByYears,
} = require('aruba-fe-client');

const { http } = await login({ username, password });

const allYears = await getFiscalYearList(http);
// Aruba returns future years AND years before account activation.
// Filter on the caller side.
const usable = allYears.filter(
  (y) => y <= new Date().getFullYear() && y >= 2019,
);

const { fatture, stats } = await fetchFatturePassiveByYears(http, usable);
console.log(stats.yearErrors); // [] when everything went well
```

Tip: `getFiscalYearList` and `getVatCode` share the same `/api/session-info` response via an in-memory 5-min TTL cache on the `http` instance, so calling both costs **one** network round trip.

### Single-invoice XML extraction

`advancedSearch` returns metadata only. To get the full FatturaPA XML for a specific invoice:

```js
const {
  login,
  getVatCode,
  extractXmlInvoiceReceived,
  parseFatturaPa,
} = require('aruba-fe-client');

const { http } = await login({ username, password });
const vat = await getVatCode(http);
const aruId = `ARUBA${vat}`;

const xml = await extractXmlInvoiceReceived(http, aruId, idAruba, 2026);
const { voci, causale, dati_pagamento } = parseFatturaPa(xml);

// voci is an array of line items:
// [{ numero_linea: 1, descrizione: 'Abbonamento Super Fibra', quantita: 1,
//    prezzo_unitario: 23, prezzo_totale: 23, aliquota_iva: 22,
//    data_inizio_periodo: null, data_fine_periodo: null }, ...]
```

The sent-side equivalent is `extractXmlInvoiceSent`. Its endpoint URL is **inferred by symmetry** with the received side (the received verb is verified; the sent verb hasn't been confirmed against a live account at the time of writing) — if your account finds Aruba uses a different verb, override it:

```js
await extractXmlInvoiceSent(http, aruId, idAruba, anno, {
  endpoint: 'https://fatturazioneelettronica.aruba.it/services/FatturaInviataFrontEnd/<real-verb>',
});
```

### Logging

Pass a pino-compatible logger to surface internal events without depending on a specific logging library:

```js
const log = {
  info:  (obj, msg) => console.log('[aruba]', msg, obj),
  debug: (obj, msg) => console.debug('[aruba]', msg, obj),
  warn:  (obj, msg) => console.warn('[aruba]', msg, obj),
};

const { http } = await login({ username, password, logger: log });
const { fatture } = await fetchFatturePassive(http, from, to, { logger: log });
```

Events emitted: `kc_page_loaded`, `kc_post_done`, `login_success`, `years_to_query`, `advanced_search_done`, `advanced_search_failed`.

## API reference

### Auth

| Function | Returns | Notes |
|---|---|---|
| `login({ username, password, timeoutMs?, userAgent?, logger? })` | `{ http, cookieJar }` | Fresh Keycloak OIDC handshake. The returned `http` (a `got` instance) carries the session cookie via the jar. |

### Search

| Function | Returns | Endpoint |
|---|---|---|
| `advancedSearch(http, aruId, year)` | `Item[]` | `FatturaRicevutaFrontEnd/advancedSearch` — raw passive items |
| `advancedSearchSent(http, aruId, year)` | `Item[]` | `FatturaInviataFrontEnd/advancedSearch` — raw active items |
| `fetchFatturePassive(http, dateFrom, dateTo, opts?)` | `{ fatture, stats }` | High-level: per-year iteration + mapping + date filter + dedup |
| `fetchFatturePassiveByYears(http, years, opts?)` | `{ fatture, stats }` | Same but with explicit year list (use with `getFiscalYearList`) |
| `fetchFattureAttive(http, dateFrom, dateTo, opts?)` | `{ fatture, stats }` | Sent-invoices counterpart of `fetchFatturePassive` |
| `fetchFattureAttiveByYears(http, years, opts?)` | `{ fatture, stats }` | Sent-invoices counterpart of `fetchFatturePassiveByYears` |

`stats` shape:

```ts
{
  vat: string,         // P.IVA of the logged account
  years: number[],     // years queried
  totalRaw: number,    // Items received before mapping/filter
  inRange: number,     // Fatture after date filter + dedup
  yearErrors: Array<{ year: number, message: string, code: string | null }>,
}
```

`aruId` (where required) must be the literal string `ARUBA<P.IVA>` (no separator). Get it via `` `ARUBA${await getVatCode(http)}` ``.

### Single-invoice XML

| Function | Returns | Notes |
|---|---|---|
| `extractXmlInvoiceReceived(http, aruId, idAruba, anno)` | `string` (UTF-8 XML) | Verified endpoint |
| `extractXmlInvoiceSent(http, aruId, idAruba, anno, { endpoint? })` | `string` (UTF-8 XML) | Endpoint URL inferred by symmetry; `opts.endpoint` overrides |
| `parseFatturaPa(xml)` | `{ voci, causale, dati_pagamento }` | Slim cheerio-based parser; throws on missing `<FatturaElettronica>` root |
| `stripXmlNs(xml)` | `string` | Utility — strips `ns0:` / `p:` prefixes + xml prolog |

### Session metadata

| Function | Returns | Notes |
|---|---|---|
| `getSessionInfo(http)` | `object` | Raw `/api/session-info` response (cached 5 min on the http instance) |
| `getVatCode(http)` | `string` | P.IVA of the logged account |
| `getFiscalYearList(http)` | `number[]` | Queryable fiscal years per Aruba — includes future years and pre-activation years; filter caller-side |

### Mappers + enums

| Export | Purpose |
|---|---|
| `toFattura(item)` | Map raw passive Item → Fattura (returns `null` on malformed input) |
| `toFatturaSent(item)` | Map raw sent Item → Fattura |
| `parseArubaDate(raw)` | Parse `"2026/05/13 19:48:54.0000+02:00"` → `Date` or `null` |
| `statoFromCode(code)` | Map numeric SDI code → `StatoSDI` label |
| `Direzione` | `{ PASSIVA: 'passiva', ATTIVA: 'attiva' }` |
| `StatoSDI` | SDI status labels (`CONSEGNATA`, `ACCETTATA`, …, `SCONOSCIUTO`) |

### Config

| Export | Type | Notes |
|---|---|---|
| `ENDPOINTS` | `Object` | All hardcoded portal URLs (frozen) |
| `APP_BASE` | `string` | `https://fatturazioneelettronica.aruba.it` |
| `KC_BASE` | `string` | `https://loginfatturazione.aruba.it` |
| `DEFAULT_USER_AGENT` | `string` | Chrome 131 on Windows |
| `DEFAULT_TIMEOUT_MS` | `number` | `30000` |

## The `Fattura` shape

```ts
type Fattura = {
  id_aruba: string;             // MongoDB ObjectId internal to Aruba
  numero: string;
  data: string;                 // YYYY-MM-DD (UTC-anchored, see note below)

  direzione: 'passiva' | 'attiva';  // discriminator

  // Unified counterparty fields — supplier for passive, customer for active.
  controparte: string | null;
  controparte_piva: string | null;
  controparte_cf: string | null;

  tipo_documento: 'TD01'|'TD02'|'TD04'|'TD24'|... | null;
  formato_trasmissione: 'FPR12'|'FPA12' | null;
  importo_totale: number | null;
  totale_imponibile: number | null;
  totale_iva: number | null;
  totale_non_imponibile: number | null;
  netto_a_pagare: number | null;
  valuta: 'EUR';

  stato_sdi: 'consegnata'|'accettata'|...|'sconosciuto';
  stato_code: number | null;       // raw numeric code from Aruba
  data_ricezione: string | null;   // ISO 8601 UTC

  id_sdi: string | null;
  sdi_filename: string | null;
  conservato: boolean;
  importata: boolean;
  allegati: boolean;
};
```

> **`data` is always UTC-anchored YYYY-MM-DD.** Local-tz formatting would produce different results on a UTC server vs an Europe/Rome dev box for invoices near midnight (a `2026/01/01 02:30+02:00` invoice would become `2025-12-31` on UTC and `2026-01-01` on local — bad news for year-bucket logic).

## Failure modes & recovery

| Error message | Likely cause | Recovery |
|---|---|---|
| `Keycloak login form not found in page` | Keycloak template changed, or CAPTCHA introduced | Update selectors in `src/auth.cjs::extractKeycloakError`. [Open an issue](https://github.com/acaprino/aruba-fe-client/issues). |
| `Keycloak login failed. Reason: …` | Wrong credentials, reCAPTCHA after retries, or 2FA/OTP enabled | Verify credentials. For reCAPTCHA: log in via browser once to reset. For 2FA: not supported via HTTP-only — disable 2FA on the account. |
| `post-login URL unexpected: …` | Redirect chain didn't reach the app domain | Pass a debug logger to inspect the chain. Likely an OIDC flow change on Aruba's side. |
| `login appeared to succeed but session-info returns 401` | OIDC callback didn't set the session cookie | Cookie domain mismatch or truncated redirect. Try bumping `maxRedirects`. |
| `session-info 401/403: session invalid or expired` | Cookie expired between calls (rare in a single sync) | Re-invoke `login()`. Shouldn't normally happen — cookies are valid for hours. |
| `advancedSearch year=<y> status=<c> body=<sample>` | Aruba 5xx, response schema changed, or IP rate-limited | Retry externally (no built-in retry on POST). If recurring, inspect the body sample. |
| `aruba-fe-client.session-info: loggedVatCode missing` | Aruba renamed the `loggedVatCode` / `userVatCode` field | Update `getVatCode()` for the new field name. |

## Known limitations

| Limit | Impact | Workaround |
|---|---|---|
| **Metadata-only in search results** | `advancedSearch` / `advancedSearchSent` return no XML body | Use `extractXmlInvoiceReceived` / `extractXmlInvoiceSent` per-invoice on demand |
| **`extractXmlInvoiceSent` endpoint is inferred** | Default URL is `FatturaInviataFrontEnd/ExtractXmlInvoiceSent` by symmetry with the received side. The received verb is verified; the sent verb is unconfirmed | If you hit a 404, sniff the real verb in DevTools on the portal's "Fatture inviate" tab and pass it via `opts.endpoint`. [Open an issue](https://github.com/acaprino/aruba-fe-client/issues) so the default can be corrected |
| **No 2FA/OTP** | If the account has 2FA enabled, login fails | Disable 2FA on the sync account, or capture the session cookie manually |
| **`STATO_CODE_MAP` limited** | Only codes 1 and 2 map to `consegnata`. Other codes resolve to `sconosciuto` (but `stato_code` is preserved) | Extend the map in `src/models.cjs` as new codes appear in real data |
| **Server filters by fiscal year only** | A cross-year range = N HTTP calls (slow) | Inherent to the portal; minimize lookback windows |
| **In-memory cookie jar** | Fresh login on every run (~2-3s per login) | Serialize the jar with `cookieJar.toJSON()` and restore with `CookieJar.fromJSON()` if you have a place to cache it |
| **TLS fingerprinting via Akamai** | A CDN-level rate limit today, not blocking | If Akamai ever introduces TLS fingerprint checks, swap `got` for `curl-impersonate-node` |

## Comparison with the official REST client

| Aspect | Official REST | This library |
|---|---|---|
| Auth endpoint | `auth.fatturazioneelettronica.aruba.it/auth/signin` (OAuth2 password grant) | `loginfatturazione.aruba.it` (Keycloak OIDC + PKCE) |
| Data endpoint | `ws.fatturazioneelettronica.aruba.it/services/invoice/in/*` | `fatturazioneelettronica.aruba.it/services/Fattura{Ricevuta,Inviata}FrontEnd/*` |
| Required permission | **API access / deleghe utente** (gated) | Web login only (universal) |
| Token lifecycle | access 30 min + refresh 60 min | Session cookie in-memory per call |
| Payload | Includes FatturaPA XML base64 in `file` | Metadata + on-demand XML extraction |
| Server-side filters | `startDate` + `endDate` precise | Fiscal year only (date filter applied client-side) |
| Pagination | `?page=&size=` (cap 100/page × 10 pages = 1000) | `PageSize: null` → full year in one response |
| Anti-bot | Documented 12 find req/min/IP | Akamai CDN only (no public rate limit) |

## Architecture

For HTTP-flow diagrams (login → search → XML extraction), design decisions (UTC date handling, `session-info` cache, regex namespace stripping, ESM-only `got` shim), and the roadmap, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Source tree:

```
src/
├── auth.cjs               Keycloak OIDC + session validation
├── api.cjs                Portal calls (search + XML extract) + session-info cache
├── models.cjs             Item → Fattura mappers (passive + active) + date parser
├── fatturaPaParser.cjs    Slim FatturaPA v1.2 XML parser (cheerio)
├── config.cjs             URLs + timeouts (no env vars)
├── getGot.cjs             Dynamic-import shim for got@14 ESM-only
└── index.cjs              Public barrel
```

## Tests

```bash
npm install
npm test
```

Two pure-logic suites, no network, ~21 cases total:

- `tests/fatturaPaParser.test.cjs` (7 cases) — XML parser edge cases (namespaces, missing fields, malformed input)
- `tests/models.test.cjs` (14 cases) — Item → Fattura mapper for both directions, UTC year-rollover guard, status code map

For a live smoke test against your own Aruba account:

```js
const { login, fetchFatturePassive } = require('aruba-fe-client');

(async () => {
  const { http } = await login({
    username: process.env.ARUBA_USERNAME,
    password: process.env.ARUBA_PASSWORD,
  });
  const { stats, fatture } = await fetchFatturePassive(
    http,
    new Date('2026-04-01'),
    new Date('2026-05-31'),
  );
  console.log(stats);
  console.log(fatture.slice(0, 3));
})().catch((e) => { console.error(e); process.exit(1); });
```

## Roadmap

See [`docs/ARCHITECTURE.md#roadmap`](docs/ARCHITECTURE.md#roadmap) for the full backlog. Highlights:

- **[H]** Confirm the `extractXmlInvoiceSent` URL against a live account and correct the default if needed
- **[H]** Cookie-jar cache hook (caller-supplied `cacheAdapter`) so warm runs skip the ~2-3s Keycloak handshake
- **[M]** Retry with jitter on 502/503/504 from `advancedSearch{,Sent}`
- **[L]** `curl-impersonate` fallback if Akamai ever introduces TLS-fingerprint bot detection

## Contributing

PRs welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the file layout, test workflow, and what to include in a PR.

Quick path to a working dev environment:

```bash
git clone https://github.com/acaprino/aruba-fe-client.git
cd aruba-fe-client
npm install
npm test       # 21 cases, no network, < 1s
```

## Disclaimer

This library is an independent, unofficial client. It is not affiliated with, endorsed by, or sponsored by Aruba S.p.A. or the Agenzia delle Entrate. Use at your own discretion and in compliance with your contract with Aruba.

The library relies on internal portal endpoints that may change without notice. If a sync starts failing, check the [Failure modes](#failure-modes--recovery) table and [open an issue](https://github.com/acaprino/aruba-fe-client/issues).

## License

[MIT](LICENSE) © Alfio Caprino
