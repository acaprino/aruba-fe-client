// src/config.cjs
// Hardcoded URLs and HTTP defaults for the Aruba Fatturazione Elettronica
// web portal. Per-call credentials are passed explicitly to login(); the
// library does not read any environment variables.

const APP_BASE = 'https://fatturazioneelettronica.aruba.it';
const KC_BASE = 'https://loginfatturazione.aruba.it';

const ENDPOINTS = Object.freeze({
  appRoot: `${APP_BASE}/`,
  sessionInfo: `${APP_BASE}/api/session-info`,
  // Received (passive) invoices — verified in production.
  advancedSearch: `${APP_BASE}/services/FatturaRicevutaFrontEnd/advancedSearch`,
  extractXmlReceived: `${APP_BASE}/services/FatturaRicevutaFrontEnd/ExtractXmlInvoiceReceived`,
  // Sent (active) invoices — `advancedSearchSent` is the endpoint the portal
  // calls on the "Fatture inviate" tab. `extractXmlSent` is inferred by
  // symmetry with the received side; if Aruba uses a different verb, the
  // caller can override per-call via the `endpoint` opt on
  // extractXmlInvoiceSent.
  advancedSearchSent: `${APP_BASE}/services/FatturaInviataFrontEnd/advancedSearch`,
  extractXmlSent: `${APP_BASE}/services/FatturaInviataFrontEnd/ExtractXmlInvoiceSent`,
  oidcTrigger: `${APP_BASE}/api/oauth2/authorization/gateway`,
});

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 30_000;

module.exports = { APP_BASE, KC_BASE, ENDPOINTS, DEFAULT_USER_AGENT, DEFAULT_TIMEOUT_MS };
