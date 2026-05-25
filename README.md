# aruba-fe-client

Pure-HTTP client for **Aruba Fatturazione Elettronica** — downloads metadata and full FatturaPA XML for **both received (passive) and sent (active) invoices** from the Italian SDI workflow, without requiring the gated "deleghe utente" REST API.

The library reuses the same Keycloak OIDC login + internal `advancedSearch` endpoint that the Aruba web portal uses, so the same web credentials that work for `fatturazioneelettronica.aruba.it` work here.

For HTTP-flow diagrams, design decisions (UTC date handling, 5-min `session-info` cache, regex namespace stripping, …), and roadmap, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why this exists

Aruba's official REST API (`ws.fatturazioneelettronica.aruba.it`) sits behind the **"deleghe utente" / API access** flag, which many commercial plans don't include. In production you'll see:

```
[aruba-sync] find failed: Errore deleghe utente
```

…even with valid credentials, because the account doesn't have the API delegation enabled. This library sidesteps the gate by talking to the same internal portal endpoints the browser does.

**Trade-off**: paginated search returns metadata only. The full FatturaPA XML (with `DettaglioLinee`, `Causale`, `DatiPagamento`) is available on-demand per-invoice via `extractXmlInvoiceReceived` + `parseFatturaPa`.

## Install

Install directly from GitHub (this package isn't on npm by design):

```bash
npm install github:acaprino/aruba-fe-client
```

Or pin to a specific commit / tag:

```bash
npm install github:acaprino/aruba-fe-client#v1.0.0
```

Requires **Node.js 18+** (uses `got@14`, which is ESM-only and loaded via dynamic `import()` so the library itself stays CommonJS).

## Quick start

```js
const { login, fetchFatturePassive } = require('aruba-fe-client');

(async () => {
  const { http } = await login({
    username: process.env.ARUBA_USERNAME,
    password: process.env.ARUBA_PASSWORD,
  });

  const { fatture, stats } = await fetchFatturePassive(
    http,
    new Date('2026-04-01'),
    new Date('2026-05-31'),
  );

  console.log(stats);            // { vat, years, totalRaw, inRange, yearErrors }
  console.log(fatture.slice(0, 3));
})();
```

### Full-history pull

`fetchFatturePassive` derives the year list from the date range. For a full-history pull driven by Aruba's own fiscal-year list:

```js
const { login, getFiscalYearList, fetchFatturePassiveByYears } = require('aruba-fe-client');

const { http } = await login({ username, password });
const allYears = await getFiscalYearList(http);
// Aruba returns future years AND years before account activation — filter on
// the caller side.
const usable = allYears.filter((y) => y <= new Date().getFullYear() && y >= 2019);

const { fatture } = await fetchFatturePassiveByYears(http, usable);
```

### Sent (active) invoices

Symmetrical API to the passive one — same shape, just different functions:

```js
const {
  login,
  fetchFattureAttive,
  fetchFattureAttiveByYears,
} = require('aruba-fe-client');

const { http } = await login({ username, password });

// Date-range version
const { fatture } = await fetchFattureAttive(
  http,
  new Date('2026-01-01'),
  new Date('2026-05-31'),
);

console.log(fatture[0].direzione);     // 'attiva'
console.log(fatture[0].controparte);   // counterparty (customer name)
```

The Fattura shape is identical for both directions; the discriminator is the `direzione` field (`'passiva' | 'attiva'`). Counterparty data lives in the unified `controparte`, `controparte_piva`, `controparte_cf` fields — for a passive invoice the supplier (cedente), for an active invoice the customer (cessionario).

### Download a single FatturaPA XML

```js
const {
  login,
  getVatCode,
  extractXmlInvoiceReceived,
  extractXmlInvoiceSent,
  parseFatturaPa,
} = require('aruba-fe-client');

const { http } = await login({ username, password });
const vat = await getVatCode(http);
const aruId = `ARUBA${vat}`;

// Passive (received) invoice — fully verified
const xmlIn = await extractXmlInvoiceReceived(http, aruId, idAruba, 2026);
const { voci, causale, dati_pagamento } = parseFatturaPa(xmlIn);

// Active (sent) invoice — endpoint URL inferred by symmetry. If your account
// finds Aruba uses a different verb, override per call:
const xmlOut = await extractXmlInvoiceSent(http, aruId, idAruba, 2026);
// or:
// extractXmlInvoiceSent(http, aruId, idAruba, 2026, { endpoint: 'https://.../<real-verb>' })
```

## API reference

### `login(opts)` → `{ http, cookieJar }`

Performs the OIDC flow and returns an authenticated `got` client with the session cookie set on the in-memory cookie jar.

| Option | Type | Default | Notes |
|---|---|---|---|
| `username` | `string` | — | required |
| `password` | `string` | — | required |
| `timeoutMs` | `number` | `30000` | per-request timeout |
| `userAgent` | `string` | Chrome 131 | used for a consistent fingerprint |
| `logger` | `object` | no-op | `{ info, debug, warn }` (pino-compatible) |

**Throws** with descriptive messages on:
- `Keycloak login form not found in page` — template changed or CAPTCHA introduced
- `Keycloak login failed. Reason: …` — wrong credentials, reCAPTCHA, or 2FA
- `post-login URL unexpected: …` — redirect chain didn't reach the app domain
- `login appeared to succeed but session-info returns 401` — OIDC callback didn't set the session cookie

### `fetchFatturePassive(http, dateFrom, dateTo, opts?)` → `{ fatture, stats }`

Iterates fiscal years overlapping `[dateFrom, dateTo]`, calls `advancedSearch` per year, maps each `Item` to a `Fattura`, applies the date filter client-side, and deduplicates by `id_aruba`.

```ts
{
  fatture: Fattura[],   // sorted by date DESC
  stats: {
    vat: string,        // P.IVA of the logged account
    years: number[],    // years queried
    totalRaw: number,   // Items received before filtering
    inRange: number,    // fatture after date filter + dedup
    yearErrors: Array<{ year, message, code }>,  // per-year errors (does NOT abort the pull)
  }
}
```

### `fetchFatturePassiveByYears(http, years, opts?)` → `{ fatture, stats }`

Same shape, but the year list is explicit instead of derived from a date range. Use with `getFiscalYearList` for full-history pulls.

### `fetchFattureAttive(http, dateFrom, dateTo, opts?)` → `{ fatture, stats }`

Same signature and return shape as `fetchFatturePassive`, but hits `FatturaInviataFrontEnd/advancedSearch` instead. Each returned Fattura has `direzione: 'attiva'` and counterparty data sourced from `Destinatario` (the customer) instead of `Mittente`.

### `fetchFattureAttiveByYears(http, years, opts?)` → `{ fatture, stats }`

Explicit-year variant of `fetchFattureAttive`.

### `getFiscalYearList(http)` → `number[]`

Returns the queryable fiscal years Aruba reports for the account (from `/api/session-info.fiscalYearList`).

**Caveat**: the list includes **future years** (e.g. 2027, 2028 on an active 2026 account) and years before the account's actual activation. Filter `≤ currentYear` and `≥ <floor>` on the caller side.

Shares the `/api/session-info` response with `getVatCode` via a 5-min TTL cache on the `http` instance — calling both costs **one** HTTP request.

### `getVatCode(http)` → `string`

Returns the P.IVA of the logged-in account.

### `advancedSearch(http, aruId, year)` → `Item[]`

Low-level call for **received (passive)** invoices. Returns the raw `Items` array from Aruba so callers can access fields not surfaced by `toFattura` (e.g. `AbilitaCreazioneNotaCredito`, `VolumeAffari`, `StatoPagInc`).

`aruId` must be `ARUBA<P.IVA>` (no separator).

### `advancedSearchSent(http, aruId, year)` → `Item[]`

Same call against `FatturaInviataFrontEnd/advancedSearch` for **sent (active)** invoices. Same wire format; the counterparty field in each Item is `Destinatario` instead of `Mittente`.

### `extractXmlInvoiceReceived(http, aruId, idAruba, anno)` → `string`

Retrieves the complete FatturaPA XML for a single received invoice via the internal `POST /services/FatturaRicevutaFrontEnd/ExtractXmlInvoiceReceived` endpoint. Returns the decoded UTF-8 XML (Aruba wraps it in `{ Content: <base64> }`; this function unwraps and decodes).

### `extractXmlInvoiceSent(http, aruId, idAruba, anno, opts?)` → `string`

Symmetric call for a sent (active) invoice. Defaults to `POST /services/FatturaInviataFrontEnd/ExtractXmlInvoiceSent` (inferred from the received-side naming; if your account finds a different verb in use, override via `opts.endpoint`).

### `parseFatturaPa(xml)` → `{ voci, causale, dati_pagamento }`

Slim FatturaPA v1.2 XML parser, deliberately limited to the fields needed to render "what's in this invoice" to a human:

```ts
{
  voci: Array<{
    numero_linea: number | null,
    descrizione: string | null,
    quantita: number | null,
    prezzo_unitario: number | null,
    prezzo_totale: number | null,
    aliquota_iva: number | null,
    data_inizio_periodo: string | null,  // YYYY-MM-DD
    data_fine_periodo: string | null,
  }>,
  causale: string | null,
  dati_pagamento: {
    modalita: string | null,    // e.g. "MP05"
    scadenza: string | null,    // YYYY-MM-DD
    importo: number | null,
  } | null
}
```

Throws when the root `<FatturaElettronica>` element is missing.

### `Fattura` shape

```ts
type Fattura = {
  id_aruba: string;             // MongoDB ObjectId internal to Aruba
  numero: string;
  data: string;                 // YYYY-MM-DD (UTC-anchored, see note below)

  // Direction discriminator. Lets a caller mix passive + active Fatture
  // in a single collection and tell them apart.
  direzione: 'passiva' | 'attiva';

  // Unified counterparty fields. For passive invoices this is the supplier
  // (cedente); for active invoices the customer (cessionario).
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
  stato_code: number | null;
  data_ricezione: string | null; // ISO 8601 UTC
  id_sdi: string | null;
  sdi_filename: string | null;
  conservato: boolean;
  importata: boolean;
  allegati: boolean;
};
```

**`data` is always UTC-anchored YYYY-MM-DD.** Local-tz formatting would produce different results on a UTC server vs an Europe/Rome dev box for invoices timestamped near midnight (a `2026/01/01 02:30+02:00` invoice would become `2025-12-31` on UTC and `2026-01-01` on local — bad news for year-bucket logic).

## Failure modes & recovery

| Error message | Likely cause | Recovery |
|---|---|---|
| `Keycloak login form not found in page` | Keycloak template changed or CAPTCHA introduced | Update selectors in `src/auth.cjs::extractKeycloakError`. Open an issue. |
| `Keycloak login failed. Reason: …` | Wrong credentials, reCAPTCHA after retries, or 2FA/OTP | Verify credentials. For reCAPTCHA: log in from a browser once to reset. For 2FA: not supported via HTTP-only — disable 2FA on the account |
| `post-login URL unexpected: …` | Redirect chain didn't reach the app domain | Pass a debug logger to inspect the chain. Likely an OIDC flow change on Aruba's side |
| `login appeared to succeed but session-info returns 401` | OIDC callback didn't set the session cookie | Cookie domain mismatch or truncated redirect. Try bumping `maxRedirects` |
| `session-info 401/403: session invalid or expired` | Cookie expired between calls (rare in the same sync) | Re-invoke `login()`. Shouldn't normally happen — cookies are valid for hours |
| `advancedSearch year=<y> status=<c> body=<sample>` | Aruba 5xx, response schema changed, or IP rate-limited | Retry externally (no built-in retry on POST). If recurring, inspect the body sample |
| `aruba-fe-client.session-info: loggedVatCode missing` | Aruba renamed the `loggedVatCode` / `userVatCode` field | Update `getVatCode()` for the new name |

## Known limitations

| Limit | Impact | Workaround |
|---|---|---|
| **Metadata-only in search results** | `advancedSearch` / `advancedSearchSent` return no XML body | Use `extractXmlInvoiceReceived` / `extractXmlInvoiceSent` per-invoice (on-demand) |
| **`extractXmlInvoiceSent` endpoint is inferred** | Default URL is `FatturaInviataFrontEnd/ExtractXmlInvoiceSent` by symmetry with the received side. Verified verb on the **received** endpoint; the **sent** verb is unconfirmed | If a 404 / "method not found" hits, sniff the real verb in DevTools on the portal's "Fatture inviate" tab and pass it via `opts.endpoint`. Open an issue once you know the real URL so the default can be corrected |
| **No 2FA/OTP** | If the account has 2FA enabled, login fails | Disable 2FA on the sync account, or use a session-cookie capture flow |
| **`STATO_CODE_MAP` limited** | Only codes 1 and 2 map to `consegnata`. Other states resolve to `sconosciuto` but `stato_code` is preserved | Extend the map in `src/models.cjs` as new codes appear |
| **Server filters by fiscal year only** | A cross-year range = N HTTP calls (slow) | Inherent to the portal; minimize lookback window where possible |
| **In-memory cookie jar** | Fresh login on every run (~2-3s per login) | Serialize the jar with `cookieJar.toJSON()` and restore with `CookieJar.fromJSON()` if you have a place to cache it |
| **TLS fingerprinting via Akamai** | Today a CDN-level rate limit only, not blocking | If Akamai ever introduces TLS fingerprint checks, swap `got` for `curl-impersonate-node` |

## Tests

```bash
npm install
npm test
```

Two pure-logic suites, no network, ~30 cases total:

- `tests/fatturaPaParser.test.cjs` — XML parser (namespaces, missing fields, malformed input)
- `tests/models.test.cjs` — Item → Fattura mapper + date parser (UTC year-rollover guard)

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

## Comparison with the official REST client

| Aspect | Official REST | This library (web-scraper) |
|---|---|---|
| Auth endpoint | `auth.fatturazioneelettronica.aruba.it/auth/signin` (OAuth2 password grant) | `loginfatturazione.aruba.it` (Keycloak OIDC) |
| Data endpoint | `ws.fatturazioneelettronica.aruba.it/services/invoice/in/*` | `fatturazioneelettronica.aruba.it/services/FatturaRicevutaFrontEnd/*` |
| Required permission | **API access / deleghe utente** (gated) | Web login only (universal) |
| Token lifecycle | access 30 min + refresh 60 min | Session cookie in-memory per call |
| Payload | Includes FatturaPA XML base64 in `file` | Metadata + on-demand XML extraction |
| Server-side filters | `startDate` + `endDate` precise | Fiscal year only (date filter applied client-side) |
| Pagination | `?page=&size=` (cap 100/page × 10 pages) | `PageSize: null` → full year in one response |
| Anti-bot | Documented 12 find req/min/IP | Akamai CDN only (no public rate limit) |

## Disclaimer

This library is an independent, unofficial client. It is not affiliated with, endorsed by, or sponsored by Aruba S.p.A. or the Agenzia delle Entrate. Use at your own discretion and in compliance with your contract with Aruba.

The library relies on internal portal endpoints that may change without notice. If a sync starts failing, check the [Failure modes](#failure-modes--recovery) table and open an issue.

## License

MIT — see [LICENSE](LICENSE).
