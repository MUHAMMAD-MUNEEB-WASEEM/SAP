'use strict';
/**
 * SAP Business One Service Layer client (OData v3/v4 style REST at /b1s/v1).
 *
 * Session model: POST /Login returns a SessionId plus B1SESSION/ROUTEID cookies
 * that must be replayed on every subsequent call. Sessions idle out (default
 * 30 min), so every call goes through `withSession`, which transparently
 * re-logs-in once on a 401.
 */
const { request, HttpError, cookiesFromHeaders, serializeCookies } = require('./http');

class SapClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl        e.g. https://10.0.1.55:50000
   * @param {string} cfg.companyDB      e.g. SBODEMOPK
   * @param {string} cfg.username
   * @param {string} cfg.password
   * @param {boolean} [cfg.allowSelfSigned]
   * @param {number} [cfg.timeoutMs]
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.root = `${String(cfg.baseUrl).replace(/\/+$/, '')}/b1s/v1`;
    this.cookies = null;
    this.sessionId = null;
    this.loggedInAt = null;
  }

  get insecure() {
    return this.cfg.allowSelfSigned !== false;
  }

  async login() {
    const res = await request({
      url: `${this.root}/Login`,
      method: 'POST',
      insecure: this.insecure,
      timeoutMs: this.cfg.timeoutMs || 60000,
      body: {
        CompanyDB: this.cfg.companyDB,
        UserName: this.cfg.username,
        Password: this.cfg.password,
      },
    });

    if (res.status !== 200) {
      throw new HttpError(
        `SAP login failed (HTTP ${res.status}): ${describeSapError(res.body)}`,
        { status: res.status, body: res.body }
      );
    }

    this.cookies = cookiesFromHeaders(res.headers);
    this.sessionId = res.body && res.body.SessionId;
    this.loggedInAt = Date.now();
    // Some Service Layer builds omit Set-Cookie behind a load balancer; fall
    // back to constructing the session cookie from the response body.
    if (!this.cookies.B1SESSION && this.sessionId) {
      this.cookies.B1SESSION = this.sessionId;
    }
    return {
      sessionId: this.sessionId,
      version: res.body && res.body.Version,
      sessionTimeout: res.body && res.body.SessionTimeout,
    };
  }

  async logout() {
    if (!this.cookies) return;
    try {
      await this.raw('POST', '/Logout');
    } catch {
      /* logging out is best-effort */
    }
    this.cookies = null;
    this.sessionId = null;
  }

  /** Perform a request with the current session cookies, no retry logic. */
  async raw(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookies) headers.Cookie = serializeCookies(this.cookies);
    return request({
      url: path.startsWith('http') ? path : `${this.root}${path}`,
      method,
      headers,
      body,
      insecure: this.insecure,
      timeoutMs: this.cfg.timeoutMs || 60000,
    });
  }

  /** Perform a request, logging in first if needed and retrying once on 401. */
  async withSession(method, path, body, extraHeaders) {
    if (!this.cookies) await this.login();
    let res = await this.raw(method, path, body, extraHeaders);
    if (res.status === 401) {
      await this.login();
      res = await this.raw(method, path, body, extraHeaders);
    }
    if (res.status >= 400) {
      throw new HttpError(
        `SAP ${method} ${path} failed (HTTP ${res.status}): ${describeSapError(res.body)}`,
        { status: res.status, body: res.body, url: path }
      );
    }
    return res;
  }

  // ---------------------------------------------------------------- queries

  /**
   * List A/R invoices that still need to be sent to FBR.
   *
   * @param {object} o
   * @param {string} o.statusField   UDF holding submission status, e.g. U_FBR_Status
   * @param {string} o.irnField      UDF holding the FBR invoice number
   * @param {string} [o.fromDate]    YYYY-MM-DD inclusive
   * @param {string} [o.toDate]      YYYY-MM-DD inclusive
   * @param {number} [o.pageSize]
   * @param {boolean} [o.includeRegistered] also return already-registered invoices
   */
  async listInvoices(o) {
    const {
      statusField,
      irnField,
      fromDate,
      toDate,
      pageSize = 100,
      includeRegistered = false,
    } = o;

    const select = [
      'DocEntry', 'DocNum', 'DocDate', 'DocType', 'CardCode', 'CardName',
      'DocTotal', 'VatSum', 'DocCurrency', 'Comments', 'NumAtCard',
      'DocumentStatus', 'Cancelled',
      irnField, statusField,
    ].filter(Boolean).join(',');

    const filters = ["DocType eq 'dDocument_Items' or DocType eq 'dDocument_Service'"];
    const scope = [];
    if (fromDate) scope.push(`DocDate ge '${fromDate}'`);
    if (toDate) scope.push(`DocDate le '${toDate}'`);
    if (!includeRegistered) {
      // Not yet registered: IRN UDF is null or empty.
      scope.push(`(${irnField} eq null or ${irnField} eq '')`);
    }
    scope.push('Cancelled eq \'tNO\'');

    const filter = [`(${filters[0]})`, ...scope].join(' and ');
    const qs =
      `?$select=${encodeURIComponent(select)}` +
      `&$filter=${encodeURIComponent(filter)}` +
      `&$orderby=${encodeURIComponent('DocEntry desc')}`;

    const res = await this.withSession('GET', `/Invoices${qs}`, undefined, {
      Prefer: `odata.maxpagesize=${pageSize}`,
    });
    return (res.body && res.body.value) || [];
  }

  /** Full invoice including DocumentLines. */
  async getInvoice(docEntry) {
    const res = await this.withSession('GET', `/Invoices(${Number(docEntry)})`);
    return res.body;
  }

  async getBusinessPartner(cardCode) {
    const res = await this.withSession(
      'GET',
      `/BusinessPartners('${encodeURIComponent(cardCode)}')`
    );
    return res.body;
  }

  async getItem(itemCode) {
    const res = await this.withSession(
      'GET',
      `/Items('${encodeURIComponent(itemCode)}')`
    );
    return res.body;
  }

  /** Company details - used to default the seller NTN / name / address. */
  async getCompany() {
    const res = await this.withSession('GET', '/CompanyService_GetCompanyInfo', {});
    return res.body;
  }

  /**
   * Write the FBR result back onto the invoice's user-defined fields.
   * Service Layer answers PATCH with 204 No Content.
   */
  async patchInvoice(docEntry, fields) {
    await this.withSession('PATCH', `/Invoices(${Number(docEntry)})`, fields);
    return true;
  }

  /**
   * Fetch the raw $metadata document. Used by the "Inspect schema" action so
   * the exact UDF and line-field names on THIS installation can be confirmed
   * rather than assumed.
   */
  async metadata() {
    const res = await this.withSession('GET', '/$metadata', undefined, {
      Accept: 'application/xml',
    });
    return res.raw;
  }
}

/** Service Layer errors arrive as { error: { code, message: { lang, value } } }. */
function describeSapError(body) {
  if (!body) return 'no response body';
  if (typeof body === 'string') return body.slice(0, 500);
  const err = body.error;
  if (!err) return JSON.stringify(body).slice(0, 500);
  const msg = err.message;
  const text = msg && typeof msg === 'object' ? msg.value : msg;
  return `${err.code || ''} ${text || JSON.stringify(err)}`.trim();
}

module.exports = { SapClient, describeSapError };
