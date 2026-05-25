# Contributing

Thanks for considering a contribution to `aruba-fe-client`. This project stays intentionally small and dependency-light; PRs that align with that philosophy are easy to land.

## Quick start

```bash
git clone https://github.com/acaprino/aruba-fe-client.git
cd aruba-fe-client
npm install
npm test
```

Tests are pure-logic, no network, no fixtures of real Aruba data — they run in under a second.

## Project layout

```
src/
├── auth.cjs               Keycloak OIDC + session validation
├── api.cjs                Portal calls (search + XML extract) + session-info cache
├── models.cjs             Item → Fattura mappers (passive + active) + date parser
├── fatturaPaParser.cjs    Slim FatturaPA v1.2 XML parser (cheerio)
├── config.cjs             URLs + timeouts (no env vars)
├── getGot.cjs             Dynamic-import shim for got@14 ESM-only
└── index.cjs              Public barrel

tests/
├── fatturaPaParser.test.cjs    XML parser cases
└── models.test.cjs             Item-mapper cases (both directions)

docs/
└── ARCHITECTURE.md             HTTP flow + design decisions + roadmap
```

No build step, no transpilation. CommonJS files run directly under Node 18+.

## Design constraints

These have shaped the codebase — please respect them in PRs:

- **No env vars.** The library never reads `process.env` for credentials or behavior toggles. Per-call arguments only. Tests, CI, and callers stay simple.
- **No global state.** Every `login()` returns its own `got` client and cookie jar. Concurrent calls from the same process must not interfere.
- **CommonJS.** The library consumes `got@14` (ESM-only) via dynamic `import()` in `getGot.cjs` so CJS callers don't need to migrate. Don't change this.
- **Pure-logic tests.** Tests must run without network access. If a PR introduces a feature that's hard to test without hitting Aruba, add a fixture (anonymized) and unit-test the mapper / parser around it.
- **Symmetric API for active and passive.** New search/extract endpoints should expose the same calling convention on both sides where the portal endpoint is symmetrical.

## PR checklist

Before opening a PR, please:

- [ ] `npm test` passes locally
- [ ] New features have at least one test case
- [ ] Public API changes are reflected in `README.md` (the API reference table and the `Fattura` shape block) and in `docs/ARCHITECTURE.md` where relevant
- [ ] Breaking changes are documented in `CHANGELOG.md` under an `Unreleased` section, with a migration note
- [ ] No new runtime dependencies unless absolutely required (the current ones are `cheerio`, `got`, `tough-cookie` — keep the surface small)
- [ ] No `console.log` left in `src/` — use the optional `opts.logger` injection points instead

## Reporting Aruba-side changes

If you discover that:

- Aruba changed the Keycloak login template (HTML form selectors are wrong)
- Aruba renamed a JSON field (`loggedVatCode`, `Mittente`, `Destinatario`, …)
- A new SDI `Stato` code appears in your data
- The `extractXmlInvoiceSent` URL has been confirmed (or it's actually a different verb)

…please open an issue with:

- The exact error message you got
- A redacted sample of the response (remove P.IVA, names, totals)
- The endpoint you observed in DevTools (when applicable)

This kind of report is the single most valuable contribution — the library exists because the portal moves and the official API doesn't help.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
