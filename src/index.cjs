// src/index.cjs
// Public surface of aruba-fe-client. Pure-HTTP scraper for Aruba
// Fatturazione Elettronica passive invoices (received invoices). Bypasses the
// official REST API (which requires the "deleghe utente" / API access flag
// many Aruba plans don't include) by reusing the same Keycloak OIDC +
// internal `advancedSearch` endpoint the web portal uses.

const { login } = require('./auth.cjs');
const {
  fetchFatturePassive,
  fetchFatturePassiveByYears,
  getSessionInfo,
  getVatCode,
  getFiscalYearList,
  advancedSearch,
  extractXmlInvoiceReceived,
} = require('./api.cjs');
const { toFattura, parseArubaDate, statoFromCode, StatoSDI } = require('./models.cjs');
const { parseFatturaPa, stripXmlNs } = require('./fatturaPaParser.cjs');
const {
  ENDPOINTS,
  APP_BASE,
  KC_BASE,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
} = require('./config.cjs');

module.exports = {
  // Auth
  login,
  // High-level fetchers
  fetchFatturePassive,
  fetchFatturePassiveByYears,
  // Low-level portal calls
  getSessionInfo,
  getVatCode,
  getFiscalYearList,
  advancedSearch,
  extractXmlInvoiceReceived,
  // Item -> Fattura mapper + helpers
  toFattura,
  parseArubaDate,
  statoFromCode,
  StatoSDI,
  // FatturaPA XML parser
  parseFatturaPa,
  stripXmlNs,
  // Config (exported for advanced/custom callers)
  ENDPOINTS,
  APP_BASE,
  KC_BASE,
  DEFAULT_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
};
