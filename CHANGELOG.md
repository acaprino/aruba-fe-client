# Changelog

All notable changes to `aruba-fe-client` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-25

### ⚠️ Breaking changes

- **Removed legacy `Fattura` aliases.** The pre-1.1.0 passive-only field names are gone:

  | Removed | Replacement (works for both directions) |
  |---|---|
  | `mittente` | `controparte` |
  | `cedente_piva` | `controparte_piva` |
  | `cedente_cf` | `controparte_cf` |

  **Migration**: in your codebase, search for `mittente`, `cedente_piva`, `cedente_cf` on objects returned by `toFattura` / `fetchFatturePassive*` and replace with the unified counterparty fields. The values are identical for passive invoices; the new names just also work for active invoices.

### Added

- **Sent (active) invoices** — full symmetric API surface:
  - `fetchFattureAttive(http, dateFrom, dateTo, opts?)`
  - `fetchFattureAttiveByYears(http, years, opts?)`
  - `advancedSearchSent(http, aruId, year)` — raw items from `FatturaInviataFrontEnd/advancedSearch` (verified endpoint)
  - `extractXmlInvoiceSent(http, aruId, idAruba, anno, opts?)` — endpoint URL inferred by symmetry with the received side; `opts.endpoint` overrides
  - `toFatturaSent(item)` — maps a sent Item (counterparty in `Destinatario`) to a `Fattura` with `direzione: 'attiva'`
- **`Direzione` enum** — `{ PASSIVA: 'passiva', ATTIVA: 'attiva' }`
- **`Fattura.direzione` discriminator field** — every `Fattura` now carries `'passiva' | 'attiva'`, so callers can mix both directions in one collection and tell them apart
- **`ENDPOINTS.advancedSearchSent`** + **`ENDPOINTS.extractXmlSent`** in `config.cjs`

### Changed

- `api.cjs` refactored to share the search loop and the XML-extract HTTP code between directions via internal helpers (`_fetchByYears`, `_runAdvancedSearch`, `_runExtractXml`). No duplication.
- `models.cjs` refactored — both `toFattura` and `toFatturaSent` funnel through `_toFatturaCore(item, direzione, counterpartyName)`. Output shape unified except for the `direzione` tag and the counterparty field source.
- `models.test.cjs` grown from 10 to 14 cases (added active-direction coverage and the discriminator round-trip test).
- README rewritten for open-source distribution (badges, TOC, comparison table, FAQ-like failure-modes table).

### Notes

- The `extractXmlInvoiceSent` URL hasn't been verified live against an Aruba account yet — it follows the naming convention of the received side. If your deployment hits a 404 there, override `opts.endpoint` and please open an issue with the real verb so the default can be corrected.

## [1.0.0] — 2026-05-25

### Added

Initial public release. Extracted from a private codebase that had vendored the scraper as `aruba-grabber`.

- **Keycloak OIDC login** (`login`) — pure-HTTP handshake against `loginfatturazione.aruba.it`, no browser needed
- **Passive invoices**:
  - `fetchFatturePassive(http, dateFrom, dateTo, opts?)` — date-range driven
  - `fetchFatturePassiveByYears(http, years, opts?)` — explicit year list (for full-history pulls)
  - `advancedSearch(http, aruId, year)` — raw items
- **Single-invoice XML extraction**:
  - `extractXmlInvoiceReceived(http, aruId, idAruba, anno)`
- **FatturaPA v1.2 XML parser**:
  - `parseFatturaPa(xml)` — extracts `voci`, `causale`, `dati_pagamento`
  - `stripXmlNs(xml)` — utility
- **Session / metadata**:
  - `getSessionInfo(http)` (with 5-min TTL cache on the http instance)
  - `getVatCode(http)`
  - `getFiscalYearList(http)`
- **Item → Fattura mapper** (`toFattura`) + helpers (`parseArubaDate`, `statoFromCode`, `StatoSDI`)
- **Per-year error isolation** in the high-level fetchers — a 502 on year N doesn't abort the pull on year N+1; per-year errors are surfaced in `stats.yearErrors`
- **UTC-anchored `data` field** (`ymd`) to avoid year-rollover slips between UTC servers and Europe/Rome dev boxes
- **Tests**: 17 cases across XML parser + Item mapper, pure-logic, no network

[1.1.0]: https://github.com/acaprino/aruba-fe-client/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/acaprino/aruba-fe-client/releases/tag/v1.0.0
