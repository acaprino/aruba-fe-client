// src/api.cjs
// Calls against the Aruba portal's internal endpoints, using the authenticated
// `got` client returned by login(). No internal state — pass the http client
// per call.
//
// session-info responses are cached on the http instance itself
// (http.__sessionInfoCache) so getVatCode + getFiscalYearList share a single
// network request. The cache has a 5-min TTL so long-running workers that
// cross a fiscal-year rollover or a session re-issue don't read stale data.

const { ENDPOINTS, APP_BASE } = require('./config.cjs');
const { toFattura, toFatturaSent, parseArubaDate } = require('./models.cjs');

const SESSION_INFO_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch /api/session-info once per http client and cache the response on it
 * (with a 5-min TTL).
 *
 * @param {import('got').Got} http
 * @returns {Promise<object>}
 */
async function getSessionInfo(http) {
  const now = Date.now();
  if (http.__sessionInfoCache && (now - (http.__sessionInfoCachedAt || 0)) < SESSION_INFO_TTL_MS) {
    return http.__sessionInfoCache;
  }
  const resp = await http.get(ENDPOINTS.sessionInfo, {
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    responseType: 'json',
  });
  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new Error(`aruba-fe-client.session-info ${resp.statusCode}: session invalid or expired`);
  }
  if (resp.statusCode !== 200) {
    throw new Error(`aruba-fe-client.session-info status ${resp.statusCode}`);
  }
  http.__sessionInfoCache = resp.body;
  http.__sessionInfoCachedAt = now;
  return resp.body;
}

/**
 * @param {import('got').Got} http
 * @returns {Promise<string>} P.IVA of the logged-in account
 */
async function getVatCode(http) {
  const data = await getSessionInfo(http);
  const vat = (data && (data.loggedVatCode || data.userVatCode));
  if (!vat) {
    throw new Error('aruba-fe-client.session-info: loggedVatCode missing');
  }
  return String(vat);
}

/**
 * Fiscal years Aruba says are queryable for this account
 * (from /api/session-info.fiscalYearList). The list includes future years
 * AND years before the account's activation — filter on the caller side.
 *
 * @param {import('got').Got} http
 * @returns {Promise<number[]>} fiscal years (typically sorted DESC, e.g.
 *   [2028, 2027, ..., 2014])
 */
async function getFiscalYearList(http) {
  const data = await getSessionInfo(http);
  const list = data && data.fiscalYearList;
  if (!Array.isArray(list)) {
    throw new Error(`aruba-fe-client.fiscalYearList missing or not an array (got ${typeof list})`);
  }
  return list.map(Number).filter(Number.isFinite);
}

// ---------------------------------------------------------------------------
// advancedSearch — passive (received) + sent (active). Same wire protocol on
// both sides, only the endpoint URL changes. _runAdvancedSearch hosts the
// shared HTTP code; the public wrappers exist so callers don't have to know
// the URL.
// ---------------------------------------------------------------------------

async function _runAdvancedSearch(http, endpoint, aruId, year, fnLabel) {
  const payload = { PageNumber: 1, PageSize: null, AnnoFiscale: year };
  const resp = await http.post(endpoint, {
    json: payload,
    responseType: 'json',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'aru-sub': aruId,
      'aru-delegator': aruId,
      origin: APP_BASE,
      referer: `${APP_BASE}/`,
    },
  });
  if (resp.statusCode !== 200) {
    const sample = typeof resp.body === 'string' ? resp.body.slice(0, 300) : JSON.stringify(resp.body).slice(0, 300);
    throw new Error(`aruba-fe-client.${fnLabel} year=${year} status=${resp.statusCode} body=${sample}`);
  }
  const items = resp.body && resp.body.Items;
  if (!Array.isArray(items)) {
    throw new Error(`aruba-fe-client.${fnLabel} year=${year}: Items is not an array`);
  }
  return items;
}

/**
 * Raw `advancedSearch` call for **received (passive)** invoices.
 *
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {number} year
 * @returns {Promise<object[]>}  Raw Items as returned by Aruba (not mapped)
 */
async function advancedSearch(http, aruId, year) {
  return _runAdvancedSearch(http, ENDPOINTS.advancedSearch, aruId, year, 'advancedSearch');
}

/**
 * Raw `advancedSearch` call for **sent (active)** invoices.
 *
 * Same wire format as `advancedSearch` but against
 * `/services/FatturaInviataFrontEnd/advancedSearch`. The Item shape is the
 * symmetrical one — the counterparty field is `Destinatario` instead of
 * `Mittente`. Use `toFatturaSent` from models.cjs to map.
 *
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {number} year
 * @returns {Promise<object[]>}
 */
async function advancedSearchSent(http, aruId, year) {
  return _runAdvancedSearch(http, ENDPOINTS.advancedSearchSent, aruId, year, 'advancedSearchSent');
}

// ---------------------------------------------------------------------------
// fetch orchestrators — both directions share the loop logic
// (getVat -> per-year search -> map -> date filter -> dedup -> sort).
// _fetchByYears parameterizes the search fn + the Item->Fattura mapper.
// ---------------------------------------------------------------------------

async function _fetchByYears(http, years, opts, { searchFn, mapFn, fnLabel }) {
  const log = opts.logger || { info: () => {}, debug: () => {}, warn: () => {} };
  const vat = await getVatCode(http);
  const aruId = `ARUBA${vat}`;
  log.info({ vat, years, mode: fnLabel }, 'years_to_query');

  let totalRaw = 0;
  const seen = new Set();
  const fatture = [];
  // Per-year error capture so a 502 on one year doesn't abort the whole pull.
  const yearErrors = [];
  const { dateFrom, dateTo } = opts;

  for (const year of years) {
    let items;
    try {
      items = await searchFn(http, aruId, year);
    } catch (err) {
      log.warn({ year, message: err.message, mode: fnLabel }, 'advanced_search_failed');
      yearErrors.push({ year, message: err.message, code: err.aruba_error_code || null });
      continue;
    }
    totalRaw += items.length;
    log.info({ year, count: items.length, mode: fnLabel }, 'advanced_search_done');
    for (const item of items) {
      const f = mapFn(item);
      if (!f) continue;
      const d = parseArubaDate(item.Data);
      if (!d) continue;
      if (dateFrom && d < dateFrom) continue;
      if (dateTo && d > dateTo) continue;
      if (seen.has(f.id_aruba)) continue;
      seen.add(f.id_aruba);
      fatture.push(f);
    }
  }

  fatture.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  return { fatture, stats: { vat, years, totalRaw, inRange: fatture.length, yearErrors } };
}

function yearsInRange(dateFrom, dateTo) {
  const y0 = dateFrom.getFullYear();
  const y1 = dateTo.getFullYear();
  const out = [];
  for (let y = y0; y <= y1; y++) out.push(y);
  return out;
}

/**
 * Full orchestration for **received (passive)** invoices: getVat ->
 * advancedSearch per year -> toFattura -> date filter -> dedup. Years are
 * derived from [dateFrom, dateTo]. For a "full history" pull driven by
 * getFiscalYearList, use `fetchFatturePassiveByYears`.
 *
 * Each Fattura has `direzione: 'passiva'`.
 *
 * @param {import('got').Got} http
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<{ fatture: object[], stats: { vat, years, totalRaw, inRange, yearErrors } }>}
 */
async function fetchFatturePassive(http, dateFrom, dateTo, opts = {}) {
  const years = yearsInRange(dateFrom, dateTo);
  return fetchFatturePassiveByYears(http, years, { dateFrom, dateTo, ...opts });
}

/**
 * Like fetchFatturePassive, but the year list is explicit.
 */
async function fetchFatturePassiveByYears(http, years, opts = {}) {
  return _fetchByYears(http, years, opts, {
    searchFn: advancedSearch,
    mapFn: toFattura,
    fnLabel: 'passive',
  });
}

/**
 * Full orchestration for **sent (active)** invoices. Symmetrical to
 * `fetchFatturePassive` but against `FatturaInviataFrontEnd/advancedSearch`.
 * Each Fattura has `direzione: 'attiva'` and the counterparty fields
 * (`controparte_*`) are sourced from `Destinatario` / `CodicePrimario`
 * instead of `Mittente`.
 *
 * @param {import('got').Got} http
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @param {object} [opts]
 * @param {object} [opts.logger]
 */
async function fetchFattureAttive(http, dateFrom, dateTo, opts = {}) {
  const years = yearsInRange(dateFrom, dateTo);
  return fetchFattureAttiveByYears(http, years, { dateFrom, dateTo, ...opts });
}

/**
 * Like fetchFattureAttive, but the year list is explicit.
 */
async function fetchFattureAttiveByYears(http, years, opts = {}) {
  return _fetchByYears(http, years, opts, {
    searchFn: advancedSearchSent,
    mapFn: toFatturaSent,
    fnLabel: 'attive',
  });
}

// ---------------------------------------------------------------------------
// Single-invoice XML extraction. Same protocol both sides:
//   POST <endpoint> { Id, AnnoFiscale } -> { Content: <base64 XML> }
// _runExtractXml hosts the shared HTTP code; public wrappers pick the
// endpoint URL (and let advanced callers override it).
// ---------------------------------------------------------------------------

async function _runExtractXml(http, endpoint, aruId, idAruba, anno, fnLabel) {
  const payload = { Id: String(idAruba), AnnoFiscale: Number(anno) };
  const resp = await http.post(endpoint, {
    json: payload,
    responseType: 'json',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'aru-sub': aruId,
      'aru-delegator': aruId,
      origin: APP_BASE,
      referer: `${APP_BASE}/`,
    },
  });
  if (resp.statusCode !== 200) {
    const sample = typeof resp.body === 'string' ? resp.body.slice(0, 300) : JSON.stringify(resp.body).slice(0, 300);
    throw new Error(`aruba-fe-client.${fnLabel} id=${idAruba} status=${resp.statusCode} body=${sample}`);
  }
  const content = resp.body && resp.body.Content;
  if (!content || typeof content !== 'string') {
    throw new Error(`aruba-fe-client.${fnLabel} id=${idAruba}: Content missing or not a string`);
  }
  return Buffer.from(content, 'base64').toString('utf8');
}

/**
 * Fetch the full FatturaPA XML for a single **received (passive)** invoice.
 *
 * Uses /services/FatturaRicevutaFrontEnd/ExtractXmlInvoiceReceived (discovered
 * via Playwright sniff, May 2026). Same auth as advancedSearch.
 *
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {string} idAruba  MongoDB ObjectId from Fattura.id_aruba
 * @param {number} anno  Fiscal year
 * @returns {Promise<string>}  Decoded UTF-8 FatturaPA XML
 */
async function extractXmlInvoiceReceived(http, aruId, idAruba, anno) {
  return _runExtractXml(http, ENDPOINTS.extractXmlReceived, aruId, idAruba, anno, 'extractXmlInvoiceReceived');
}

/**
 * Fetch the full FatturaPA XML for a single **sent (active)** invoice.
 *
 * Uses /services/FatturaInviataFrontEnd/ExtractXmlInvoiceSent by symmetry
 * with the received side. If a deployment finds that Aruba uses a different
 * verb on the sent endpoint, pass `opts.endpoint` to override:
 *
 *   extractXmlInvoiceSent(http, aruId, idAruba, anno, {
 *     endpoint: 'https://fatturazioneelettronica.aruba.it/services/FatturaInviataFrontEnd/<real-verb>',
 *   })
 *
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {string} idAruba  MongoDB ObjectId from Fattura.id_aruba
 * @param {number} anno  Fiscal year
 * @param {{ endpoint?: string }} [opts]
 * @returns {Promise<string>}  Decoded UTF-8 FatturaPA XML
 */
async function extractXmlInvoiceSent(http, aruId, idAruba, anno, opts = {}) {
  const endpoint = opts.endpoint || ENDPOINTS.extractXmlSent;
  return _runExtractXml(http, endpoint, aruId, idAruba, anno, 'extractXmlInvoiceSent');
}

module.exports = {
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
};
