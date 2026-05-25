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
const { toFattura, parseArubaDate } = require('./models.cjs');

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
 * Typical pattern: filter <= current year, then use min() as the "from" year
 * for a full-history pull.
 *
 * @param {import('got').Got} http
 * @returns {Promise<number[]>} fiscal years as returned by Aruba (typically
 *   sorted DESC, e.g. [2028, 2027, ..., 2014])
 */
async function getFiscalYearList(http) {
  const data = await getSessionInfo(http);
  const list = data && data.fiscalYearList;
  if (!Array.isArray(list)) {
    throw new Error(`aruba-fe-client.fiscalYearList missing or not an array (got ${typeof list})`);
  }
  return list.map(Number).filter(Number.isFinite);
}

/**
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {number} year
 * @returns {Promise<object[]>}  Raw Items as returned by Aruba (not mapped)
 */
async function advancedSearch(http, aruId, year) {
  const payload = { PageNumber: 1, PageSize: null, AnnoFiscale: year };
  const resp = await http.post(ENDPOINTS.advancedSearch, {
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
    throw new Error(`aruba-fe-client.advancedSearch year=${year} status=${resp.statusCode} body=${sample}`);
  }
  const items = resp.body && resp.body.Items;
  if (!Array.isArray(items)) {
    throw new Error(`aruba-fe-client.advancedSearch year=${year}: Items is not an array`);
  }
  return items;
}

/**
 * Full orchestration: getVat -> advancedSearch per year -> toFattura ->
 * date filter -> dedup. Years are derived from [dateFrom, dateTo] with
 * yearsInRange. For a "full history" pull driven by getFiscalYearList, use
 * fetchFatturePassiveByYears() instead.
 *
 * @param {import('got').Got} http
 * @param {Date} dateFrom
 * @param {Date} dateTo
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<{ fatture: object[], stats: { vat: string, years: number[], totalRaw: number, inRange: number, yearErrors: object[] } }>}
 */
async function fetchFatturePassive(http, dateFrom, dateTo, opts = {}) {
  const years = yearsInRange(dateFrom, dateTo);
  return fetchFatturePassiveByYears(http, years, { dateFrom, dateTo, ...opts });
}

/**
 * Like fetchFatturePassive, but the year list is explicit (use this with
 * getFiscalYearList for full-history pulls without hardcoding the start year).
 * The date filter still applies when dateFrom/dateTo are provided; otherwise
 * all Items in the queried years are kept.
 *
 * @param {import('got').Got} http
 * @param {number[]} years
 * @param {object} [opts]
 * @param {Date} [opts.dateFrom]
 * @param {Date} [opts.dateTo]
 * @param {object} [opts.logger]
 */
async function fetchFatturePassiveByYears(http, years, opts = {}) {
  const log = opts.logger || { info: () => {}, debug: () => {}, warn: () => {} };
  const vat = await getVatCode(http);
  const aruId = `ARUBA${vat}`;
  log.info({ vat, years }, 'years_to_query');

  let totalRaw = 0;
  const seen = new Set();
  const fatture = [];
  // Collect per-year errors instead of aborting the whole pull. A 502 on
  // year N would otherwise lose progress on year N+1; with per-year capture
  // each year stands alone.
  const yearErrors = [];
  const { dateFrom, dateTo } = opts;

  for (const year of years) {
    let items;
    try {
      items = await advancedSearch(http, aruId, year);
    } catch (err) {
      log.warn({ year, message: err.message }, 'advanced_search_failed');
      yearErrors.push({ year, message: err.message, code: err.aruba_error_code || null });
      continue;
    }
    totalRaw += items.length;
    log.info({ year, count: items.length }, 'advanced_search_done');
    for (const item of items) {
      const f = toFattura(item);
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
 * Fetch the full FatturaPA XML for a single received invoice.
 *
 * Uses the internal portal endpoint /services/FatturaRicevutaFrontEnd/ExtractXmlInvoiceReceived
 * (discovered via Playwright network sniff, May 2026). Same auth model as
 * advancedSearch: Aru-Sub / Aru-Delegator = ARUBA<P.IVA>, session cookie
 * from login().
 *
 * The response wraps the XML in { Content: <base64> }. Callers decode and
 * parse (see parseFatturaPa).
 *
 * @param {import('got').Got} http
 * @param {string} aruId  "ARUBA<P.IVA>"
 * @param {string} idAruba  MongoDB ObjectId from Fattura.id_aruba
 * @param {number} anno  Fiscal year (Fattura.data year)
 * @returns {Promise<string>}  Decoded UTF-8 FatturaPA XML
 */
async function extractXmlInvoiceReceived(http, aruId, idAruba, anno) {
  const payload = { Id: String(idAruba), AnnoFiscale: Number(anno) };
  const resp = await http.post(ENDPOINTS.extractXmlReceived, {
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
    throw new Error(`aruba-fe-client.extractXmlInvoiceReceived id=${idAruba} status=${resp.statusCode} body=${sample}`);
  }
  const content = resp.body && resp.body.Content;
  if (!content || typeof content !== 'string') {
    throw new Error(`aruba-fe-client.extractXmlInvoiceReceived id=${idAruba}: Content missing or not a string`);
  }
  return Buffer.from(content, 'base64').toString('utf8');
}

module.exports = {
  getSessionInfo,
  getVatCode,
  getFiscalYearList,
  advancedSearch,
  fetchFatturePassive,
  fetchFatturePassiveByYears,
  extractXmlInvoiceReceived,
};
