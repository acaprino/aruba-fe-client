// src/index.cjs
// Public surface of aruba-fe-client. Pure-HTTP scraper for Aruba
// Fatturazione Elettronica — covers both received (passive) and sent (active)
// invoices. Bypasses the official REST API (which requires the "deleghe
// utente" / API access flag many Aruba plans don't include) by reusing the
// same Keycloak OIDC + internal endpoints the web portal uses.

const { login } = require('./auth.cjs');
const {
  // Session / metadata
  getSessionInfo,
  getVatCode,
  getFiscalYearList,
  // Low-level search
  advancedSearch,
  advancedSearchSent,
  // High-level fetchers
  fetchFatturePassive,
  fetchFatturePassiveByYears,
  fetchFattureAttive,
  fetchFattureAttiveByYears,
  // Single-invoice XML extraction
  extractXmlInvoiceReceived,
  extractXmlInvoiceSent,
} = require('./api.cjs');
const {
  toFattura,
  toFatturaSent,
  parseArubaDate,
  statoFromCode,
  StatoSDI,
  Direzione,
} = require('./models.cjs');
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
  // High-level fetchers — passive (received)
  fetchFatturePassive,
  fetchFatturePassiveByYears,
  // High-level fetchers — active (sent)
  fetchFattureAttive,
  fetchFattureAttiveByYears,
  // Low-level portal calls
  getSessionInfo,
  getVatCode,
  getFiscalYearList,
  advancedSearch,
  advancedSearchSent,
  extractXmlInvoiceReceived,
  extractXmlInvoiceSent,
  // Item -> Fattura mappers + helpers
  toFattura,
  toFatturaSent,
  parseArubaDate,
  statoFromCode,
  StatoSDI,
  Direzione,
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
