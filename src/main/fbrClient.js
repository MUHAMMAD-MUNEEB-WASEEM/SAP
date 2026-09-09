'use strict';
/**
 * FBR / PRAL Digital Invoicing (DI) API client.
 *
 * Per "Technical Specification for DI API" v1.12 (PRAL, 24-Jul-2025):
 *  - Auth is a bearer token issued from the IRIS portal, valid 5 years.
 *  - The DI data URLs are fixed; sandbox vs production is decided by the
 *    _sb suffix on the path AND by which token is presented.
 *  - `scenarioId` is required for sandbox submissions only.
 *  - A 200 response does NOT mean acceptance: validationResponse.statusCode
 *    must be "00" and status "Valid". Item-level failures come back inside
 *    validationResponse.invoiceStatuses[] even when the envelope says 00.
 */
const { request, HttpError } = require('./http');

const GATEWAY = 'https://gw.fbr.gov.pk';

const ENDPOINTS = {
  sandbox: {
    post: `${GATEWAY}/di_data/v1/di/postinvoicedata_sb`,
    validate: `${GATEWAY}/di_data/v1/di/validateinvoicedata_sb`,
  },
  production: {
    post: `${GATEWAY}/di_data/v1/di/postinvoicedata`,
    validate: `${GATEWAY}/di_data/v1/di/validateinvoicedata`,
  },
};

/** Reference / lookup endpoints (spec section 5). */
const REFERENCE = {
  provinces: `${GATEWAY}/pdi/v1/provinces`,
  docTypeCode: `${GATEWAY}/pdi/v1/doctypecode`,
  itemDescCode: `${GATEWAY}/pdi/v1/itemdesccode`,
  sroItemCode: `${GATEWAY}/pdi/v1/sroitemcode`,
  transTypeCode: `${GATEWAY}/pdi/v1/transtypecode`,
  uom: `${GATEWAY}/pdi/v1/uom`,
  sroSchedule: `${GATEWAY}/pdi/v1/SroSchedule`,       // ?rate_id=&date=DD-MMM-YYYY
  saleTypeToRate: `${GATEWAY}/pdi/v2/SaleTypeToRate`, // ?date=DD-MMM-YYYY&transTypeId=&originationSupplier=
  hsUom: `${GATEWAY}/pdi/v2/HS_UOM`,                  // ?hs_code=&annexure_id=3
  sroItem: `${GATEWAY}/pdi/v2/SROItem`,               // ?date=YYYY-MM-DD&sro_id=
  statl: `${GATEWAY}/dist/v1/statl`,
  regType: `${GATEWAY}/dist/v1/Get_Reg_Type`,
};

class FbrClient {
  /**
   * @param {object} cfg
   * @param {'sandbox'|'production'} cfg.environment
   * @param {string} cfg.token            IRIS bearer token for that environment
   * @param {number} [cfg.timeoutMs]
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  get environment() {
    return this.cfg.environment === 'production' ? 'production' : 'sandbox';
  }

  get isSandbox() {
    return this.environment === 'sandbox';
  }

  headers() {
    if (!this.cfg.token) {
      throw new HttpError(`No FBR ${this.environment} token configured.`);
    }
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      'Content-Type': 'application/json',
    };
  }

  async call(url, method, body) {
    const res = await request({
      url,
      method,
      headers: this.headers(),
      body,
      timeoutMs: this.cfg.timeoutMs || 90000,
    });

    if (res.status === 401) {
      throw new HttpError(
        `FBR rejected the ${this.environment} token (HTTP 401 Unauthorized). Check the token and that it belongs to this environment.`,
        { status: 401, body: res.body, url }
      );
    }
    if (res.status >= 500) {
      throw new HttpError(
        `FBR gateway error (HTTP ${res.status}). This is an FBR-side fault; retry later.`,
        { status: res.status, body: res.body, url }
      );
    }
    if (res.status >= 400) {
      throw new HttpError(
        `FBR request failed (HTTP ${res.status}): ${typeof res.body === 'string' ? res.body.slice(0, 400) : JSON.stringify(res.body).slice(0, 400)}`,
        { status: res.status, body: res.body, url }
      );
    }
    return res.body;
  }

  /** Dry-run an invoice against FBR validation without registering it. */
  async validateInvoice(payload) {
    const raw = await this.call(ENDPOINTS[this.environment].validate, 'POST', payload);
    return interpretResponse(raw);
  }

  /** Register an invoice and obtain the FBR invoice number (IRN). */
  async postInvoice(payload) {
    const raw = await this.call(ENDPOINTS[this.environment].post, 'POST', payload);
    return interpretResponse(raw);
  }

  // ------------------------------------------------------------- reference

  async getProvinces() {
    return this.call(REFERENCE.provinces, 'GET');
  }

  async getUom() {
    return this.call(REFERENCE.uom, 'GET');
  }

  async getTransactionTypes() {
    return this.call(REFERENCE.transTypeCode, 'GET');
  }

  async getDocTypes() {
    return this.call(REFERENCE.docTypeCode, 'GET');
  }

  /**
   * FBR's full HS code list with descriptions. Takes no parameters and returns
   * the whole catalogue, so callers should fetch once and search locally.
   */
  async getHsCodes() {
    return this.call(REFERENCE.itemDescCode, 'GET');
  }

  /** Valid UoMs for a given HS code (annexure_id 3 = sales). */
  async getHsUom(hsCode, annexureId = 3) {
    const url = `${REFERENCE.hsUom}?hs_code=${encodeURIComponent(hsCode)}&annexure_id=${annexureId}`;
    return this.call(url, 'GET');
  }

  /**
   * Rate list for a sale type on a given date.
   * @param {string} dateDMY  DD-MMM-YYYY, e.g. 24-Feb-2025
   */
  async getSaleTypeToRate(dateDMY, transTypeId, originationSupplier) {
    const params = new URLSearchParams({ date: dateDMY });
    if (transTypeId != null) params.set('transTypeId', String(transTypeId));
    if (originationSupplier != null) params.set('originationSupplier', String(originationSupplier));
    return this.call(`${REFERENCE.saleTypeToRate}?${params}`, 'GET');
  }

  /** Active-Taxpayer-List check for a registration number. */
  async checkStatl(regNo, dateYMD) {
    return this.call(REFERENCE.statl, 'POST', { regno: regNo, date: dateYMD });
  }

  /** Registered vs Unregistered for a buyer NTN/CNIC. */
  async getRegistrationType(regNo) {
    return this.call(REFERENCE.regType, 'POST', { Registration_No: regNo });
  }
}

/**
 * Normalise an FBR response into a decision we can act on.
 *
 * Three distinct failure shapes exist in the spec and all arrive as HTTP 200:
 *   1. statusCode "01" at envelope level with an errorCode  -> header rejected
 *   2. statusCode "00" but status "invalid" with per-item failures
 *   3. statusCode "00" / "Valid" with an invoiceNumber      -> accepted
 */
function interpretResponse(raw) {
  const vr = (raw && raw.validationResponse) || {};
  const itemStatuses = Array.isArray(vr.invoiceStatuses) ? vr.invoiceStatuses : [];

  const itemErrors = itemStatuses
    .filter((s) => s && String(s.statusCode) !== '00')
    .map((s) => ({
      itemSNo: s.itemSNo,
      errorCode: s.errorCode,
      error: s.error,
    }));

  const envelopeOk = String(vr.statusCode) === '00';
  const statusText = String(vr.status || '').toLowerCase();
  const accepted =
    envelopeOk && statusText === 'valid' && itemErrors.length === 0 && !!raw.invoiceNumber;

  const errors = [];
  if (vr.error) errors.push({ errorCode: vr.errorCode || vr.statusCode, error: vr.error });
  errors.push(...itemErrors);

  return {
    accepted,
    invoiceNumber: raw ? raw.invoiceNumber || null : null,
    dated: raw ? raw.dated || null : null,
    statusCode: vr.statusCode || null,
    status: vr.status || null,
    errors,
    errorSummary: errors.length
      ? errors.map((e) => `${e.itemSNo ? `item ${e.itemSNo}: ` : ''}${e.errorCode || ''} ${e.error || ''}`.trim()).join(' | ')
      : '',
    raw,
  };
}

module.exports = { FbrClient, ENDPOINTS, REFERENCE, interpretResponse };
