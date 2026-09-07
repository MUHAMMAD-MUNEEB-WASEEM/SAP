'use strict';
/**
 * Configuration load/save.
 *
 * Secrets (SAP password, FBR bearer tokens) are encrypted at rest with
 * Electron's safeStorage, which is backed by DPAPI on Windows. They are stored
 * as base64 blobs under `*_enc` keys and never written back to disk in plain
 * text. If safeStorage is unavailable the value is kept in memory only and the
 * user is told to re-enter it, rather than silently persisting a secret.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  sap: {
    baseUrl: 'https://10.0.1.55:50000',
    companyDB: '',
    username: '',
    password: '',
    allowSelfSigned: true,
    timeoutMs: 60000,
  },
  fbr: {
    environment: 'sandbox', // 'sandbox' | 'production'
    sandboxToken: '',
    productionToken: '',
    timeoutMs: 90000,
  },
  seller: {
    ntnCnic: '',
    businessName: '',
    province: '',
    address: '',
  },
  // Names of the user-defined fields this app reads and writes in SAP.
  sapFields: {
    // Written back onto the A/R Invoice after a successful registration:
    irnField: 'U_FBR_IRN',
    statusField: 'U_FBR_Status',
    dateField: 'U_FBR_Date',
    messageField: 'U_FBR_Message',
    // Read from the invoice (optional per-document overrides):
    invoiceTypeField: 'U_FBR_InvoiceType',
    scenarioField: 'U_FBR_ScenarioId',
    refNoField: 'U_FBR_RefNo',
    // Read from the business partner:
    bpNtnField: 'FederalTaxID',
    bpProvinceField: 'U_FBR_Province',
    bpRegTypeField: 'U_FBR_RegType',
    // Read from the item master:
    itemHsCodeField: 'U_FBR_HSCode',
    itemUomField: 'U_FBR_UOM',
    itemSaleTypeField: 'U_FBR_SaleType',
    // Read from invoice lines (optional):
    lineHsCodeField: 'U_FBR_HSCode',
    lineSaleTypeField: 'U_FBR_SaleType',
    lineFurtherTaxField: 'U_FBR_FurtherTax',
    lineExtraTaxField: 'U_FBR_ExtraTax',
    lineFedField: 'U_FBR_FED',
    lineStWithheldField: 'U_FBR_STWithheld',
    lineRetailPriceField: 'U_FBR_RetailPrice',
    lineSroScheduleField: 'U_FBR_SROSchedule',
    lineSroItemField: 'U_FBR_SROItem',
  },
  mapping: {
    defaultInvoiceType: 'Sale Invoice',
    defaultScenarioId: 'SN001',
    defaultProvince: '',
    defaultSaleType: 'Goods at standard rate (default)',
    defaultUom: '',
    defaultHsCode: '',
    defaultRate: '',
    rateDecimals: 0,
    provinces: {}, // SAP state code/name -> FBR province name
    uom: {},       // SAP UoM code -> FBR UoM name
  },
  itemOverrides: {}, // ItemCode -> { hsCode, uoM, saleType, rate, ... }
  sync: {
    pageSize: 100,
    lookbackDays: 30,
    validateBeforePost: true,
    autoWriteBack: true,
  },
};

const SECRET_PATHS = [
  ['sap', 'password'],
  ['fbr', 'sandboxToken'],
  ['fbr', 'productionToken'],
];

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object') return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getAt(obj, pathParts) {
  return pathParts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setAt(obj, pathParts, value) {
  let cur = obj;
  for (let i = 0; i < pathParts.length - 1; i++) {
    if (typeof cur[pathParts[i]] !== 'object' || cur[pathParts[i]] === null) {
      cur[pathParts[i]] = {};
    }
    cur = cur[pathParts[i]];
  }
  cur[pathParts[pathParts.length - 1]] = value;
}

class ConfigStore {
  /**
   * @param {string} filePath
   * @param {import('electron').SafeStorage} [safeStorage]
   */
  constructor(filePath, safeStorage) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.config = JSON.parse(JSON.stringify(DEFAULTS));
  }

  get encryptionAvailable() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.config = JSON.parse(JSON.stringify(DEFAULTS));
      return this.config;
    }
    const onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.config = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), onDisk);

    // Decrypt any secrets stored as *_enc.
    for (const p of SECRET_PATHS) {
      const encKey = [...p.slice(0, -1), `${p[p.length - 1]}_enc`];
      const blob = getAt(this.config, encKey);
      if (blob && this.encryptionAvailable) {
        try {
          setAt(this.config, p, this.safeStorage.decryptString(Buffer.from(blob, 'base64')));
        } catch {
          setAt(this.config, p, '');
        }
      }
      setAt(this.config, encKey, undefined);
      const parent = getAt(this.config, encKey.slice(0, -1));
      if (parent) delete parent[encKey[encKey.length - 1]];
    }
    return this.config;
  }

  save(next) {
    if (next) this.config = deepMerge(this.config, next);

    const onDisk = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      const value = getAt(this.config, p);
      const leaf = p[p.length - 1];
      const parent = getAt(onDisk, p.slice(0, -1));
      if (!parent) continue;
      delete parent[leaf];
      if (value) {
        if (this.encryptionAvailable) {
          parent[`${leaf}_enc`] = this.safeStorage.encryptString(value).toString('base64');
        } else {
          // Never persist a secret in the clear; keep it for this session only.
          delete parent[`${leaf}_enc`];
        }
      } else {
        delete parent[`${leaf}_enc`];
      }
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(onDisk, null, 2), 'utf8');
    return this.config;
  }

  /** Config with secrets masked, safe to hand to the renderer. */
  redacted() {
    const c = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      const value = getAt(this.config, p);
      setAt(c, p, value ? '********' : '');
    }
    c._encryptionAvailable = this.encryptionAvailable;
    return c;
  }

  /** The active FBR token for the currently selected environment. */
  activeFbrToken() {
    return this.config.fbr.environment === 'production'
      ? this.config.fbr.productionToken
      : this.config.fbr.sandboxToken;
  }
}

module.exports = { ConfigStore, DEFAULTS, SECRET_PATHS };
