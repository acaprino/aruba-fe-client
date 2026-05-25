// src/auth.cjs
// HTTP-only OIDC login against Aruba's Keycloak. Returns an authenticated
// `got` client + cookie jar. Flow:
//
//   1. GET /api/oauth2/authorization/gateway?originaluri=<app_root>
//      -> 302 to loginfatturazione.aruba.it (Keycloak login HTML)
//   2. cheerio extracts <form action="..."> from the page
//   3. POST form-urlencoded {username, password, credentialId=''}
//      -> 302 with ?code=... to Aruba callback
//      -> Aruba sets the session cookie on fatturazioneelettronica.aruba.it
//   4. Verify via GET /api/session-info -> 200

const { load: cheerioLoad } = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { getGot } = require('./getGot.cjs');
const { ENDPOINTS, KC_BASE, DEFAULT_USER_AGENT, DEFAULT_TIMEOUT_MS } = require('./config.cjs');

function commonHeaders(userAgent) {
  return {
    'user-agent': userAgent || DEFAULT_USER_AGENT,
    'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

/**
 * Authenticate against Aruba's Keycloak. Per-call credentials, in-memory
 * cookie jar. The returned `http` client carries the session cookie via the
 * jar so subsequent calls to `advancedSearch`, `extractXmlInvoiceReceived`,
 * etc. work without further setup.
 *
 * @param {{ username: string, password: string, timeoutMs?: number, userAgent?: string, logger?: object }} opts
 * @returns {Promise<{ http: import('got').Got, cookieJar: CookieJar }>}
 */
async function login({ username, password, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent, logger } = {}) {
  if (!username || !password) {
    throw new Error('aruba-fe-client.login: username and password are required');
  }
  const log = logger || { info: () => {}, debug: () => {}, warn: () => {} };

  const got = await getGot();
  const cookieJar = new CookieJar();
  const headers = commonHeaders(userAgent);

  const http = got.extend({
    cookieJar,
    timeout: { request: timeoutMs },
    headers,
    followRedirect: true,
    maxRedirects: 15,
    throwHttpErrors: false,
    retry: { limit: 1, methods: ['GET'] },
    https: { rejectUnauthorized: true },
  });

  // 1. Trigger OIDC server-side -> redirect to Keycloak login HTML.
  const triggerUrl = `${ENDPOINTS.oidcTrigger}?originaluri=${encodeURIComponent(ENDPOINTS.appRoot)}`;
  const loginPage = await http.get(triggerUrl);
  log.debug({ status: loginPage.statusCode, finalUrl: loginPage.url }, 'kc_page_loaded');

  if (!loginPage.url.includes('loginfatturazione.aruba.it')) {
    throw new Error(
      `aruba-fe-client: expected redirect to loginfatturazione.aruba.it, got ${loginPage.url} (${loginPage.statusCode})`
    );
  }

  // 2. Extract the form action from the Keycloak HTML.
  const $ = cheerioLoad(loginPage.body);
  const action =
    $('form#kc-form-login').first().attr('action') ||
    $('form[action*="login-actions/authenticate"]').first().attr('action');

  if (!action) {
    throw new Error(
      'aruba-fe-client: Keycloak login form not found. Possible CAPTCHA or template change. ' +
      `HTML length=${loginPage.body && loginPage.body.length}`
    );
  }

  // 3. POST credentials.
  const formBody = new URLSearchParams({ username, password, credentialId: '' });
  const postResp = await http.post(action, {
    body: formBody.toString(),
    headers: {
      ...headers,
      'content-type': 'application/x-www-form-urlencoded',
      origin: KC_BASE,
      referer: loginPage.url,
    },
  });
  log.debug({ status: postResp.statusCode, finalUrl: postResp.url }, 'kc_post_done');

  // Strip the query string before logging. `postResp.url` after followRedirect
  // can carry ?code=<authcode>&session_state=... (OIDC params per RFC 6749
  // §10.10 — single-use but session-binding secrets) which would otherwise
  // leak into caller-visible error messages.
  const safeUrl = postResp.url ? postResp.url.split('?')[0] : '(none)';
  if (postResp.url.includes('loginfatturazione.aruba.it')) {
    const errorMsg = extractKeycloakError(postResp.body);
    throw new Error(
      `aruba-fe-client: Keycloak login failed. ${errorMsg ? `Reason: ${errorMsg}. ` : ''}` +
      'Likely cause: wrong credentials, reCAPTCHA after retries, or 2FA/OTP (not supported via HTTP-only).'
    );
  }
  if (!postResp.url.includes('fatturazioneelettronica.aruba.it')) {
    throw new Error(`aruba-fe-client: post-login URL unexpected: ${safeUrl} (${postResp.statusCode})`);
  }

  // 4. Verify the session was actually established.
  if (!(await isSessionValid(http))) {
    throw new Error(
      'aruba-fe-client: login appeared to succeed but session-info returns 401. ' +
      'OIDC callback likely failed to set the session cookie.'
    );
  }

  log.info({ url: safeUrl }, 'login_success');
  return { http, cookieJar };
}

async function isSessionValid(http) {
  const r = await http.get(ENDPOINTS.sessionInfo, {
    headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    responseType: 'text',
  });
  return r.statusCode === 200;
}

function extractKeycloakError(html) {
  try {
    const $ = cheerioLoad(html);
    const selectors = [
      '#input-error',
      '#input-error-username',
      '#input-error-password',
      '.pf-c-form__helper-text.pf-m-error',
      '.alert-error span',
      '.alert-error',
      '.kc-feedback-text',
      '#kc-content-wrapper .alert',
      '[role="alert"]',
    ];
    for (const sel of selectors) {
      const txt = $(sel).first().text().trim();
      if (txt) return txt;
    }
    const bodyText = $('body').text();
    const m = bodyText.match(/(credenziali|password|utente).{0,80}(non.{0,40}(valid|corrett)|errat)/i);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  } catch (_) { /* ignore */ }
  return null;
}

module.exports = { login };
