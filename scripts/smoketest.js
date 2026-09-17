'use strict';
/**
 * Renderer smoke test.
 *
 * The unit tests cover the main process, but the renderer is plain DOM code
 * that only executes when a user clicks something - so a mistake like referring
 * to a variable that no longer exists surfaces as a runtime ReferenceError in
 * front of the user rather than as a failing test.
 *
 * This loads app.js against a minimal DOM stub and a mocked window.api, then
 * fires every registered event handler and reports anything that throws. It
 * proves the code paths RUN; the unit tests prove they are correct.
 *
 *   node scripts/smoketest.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');

const knownIds = new Set([...htmlSource.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/* ------------------------------------------------------------- DOM stub */

const handlers = []; // { id, type, fn }
const elements = new Map();

function makeElement(id) {
  const el = {
    id,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    disabled: false,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    addEventListener(type, fn) {
      handlers.push({ id, type, fn });
    },
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
  };
  return el;
}

function getElementById(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

const document = {
  getElementById,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => makeElement('created'),
  addEventListener() {},
};

/* -------------------------------------------------------- mocked window.api */

const wrap = (data) => Promise.resolve({ ok: true, data });

const sampleInvoices = {
  invoices: [
    {
      docEntry: 9075,
      docNum: 9075,
      docDate: '2026-09-01T00:00:00Z',
      cardCode: 'C0010',
      cardName: 'GLAXO SMITHKLINE PAKISTAN LIMITED',
      docTotal: 52917,
      vatSum: 0,
      currency: 'PKR',
      irn: null,
      status: null,
      localStatus: null,
      localIrn: null,
      needsWriteBack: true,
    },
  ],
  truncated: true,
  limit: 1000,
};

const sampleItems = [
  {
    itemCode: 'FGF-LBL-001',
    itemName: 'LABELING & SEALING',
    hsCode: '',
    hsSource: '',
    hsUnreadable: false,
    uoM: '',
    sapUom: 'PCS',
    saleType: '',
    usedOn: [9075],
  },
];

const api = {
  config: {
    get: () =>
      wrap({
        sap: { baseUrl: 'http://10.0.1.55:50001', companyDB: 'APH_TEST', username: 'ismail', password: '********', allowSelfSigned: true },
        fbr: { environment: 'sandbox', sandboxToken: '********', productionToken: '' },
        seller: { ntnCnic: '', businessName: '', province: '', address: '' },
        mapping: { defaultScenarioId: 'SN001', defaultProvince: '', defaultBuyerAddress: '', defaultSaleType: '', defaultUom: '', defaultHsCode: '' },
        sync: { validateBeforePost: true, autoWriteBack: true, lookbackDays: 30 },
        sapFields: {
          irnField: 'U_FBR_IRN', statusField: 'U_FBR_Status', dateField: 'U_FBR_Date',
          messageField: 'U_FBR_Message', scenarioField: 'U_FBR_ScenarioId', refNoField: 'U_FBR_RefNo',
          bpNtnField: 'FederalTaxID', bpProvinceField: 'U_FBR_Province', bpRegTypeField: 'U_FBR_RegType',
          itemHsCodeField: 'U_FBR_HSCode', itemUomField: 'U_FBR_UOM', itemSaleTypeField: 'U_FBR_SaleType',
        },
        _encryptionAvailable: true,
      }),
    save: () => wrap({}),
    path: () => wrap('config/config.json'),
  },
  test: {
    sap: () => wrap({ version: '10.0', sessionTimeout: 30 }),
    fbr: () => wrap({ environment: 'sandbox', provinceCount: 7 }),
    diagnoseSap: () => wrap({ reachable: true, findings: ['ok'], probes: { a: { status: 400, code: -304, message: 'x' } } }),
    checkSetup: () => wrap({ ready: false, missingRequired: 1, missingTotal: 1, report: [{ table: 'OINV', label: 'A/R Invoice', location: 'x', fields: [{ field: 'U_FBR_IRN', status: 'missing', required: true, purpose: 'irn', spec: {} }] }] }),
    createUdfs: () => wrap({ attempted: 1, created: 1, failed: 0, results: [{ table: 'OINV', field: 'U_FBR_IRN', ok: true }] }),
    suggestSeller: () => wrap({ ntnCnic: '0786909', businessName: 'ACME', province: 'Sindh', address: 'Karachi' }),
  },
  invoices: {
    list: () => wrap(sampleInvoices),
    preview: () => wrap({ docEntry: 9075, docNum: 9075, payload: null, errors: ['x'], warnings: ['y'] }),
    validate: () => wrap({ ok: false, stage: 'mapping', errors: ['x'], warnings: [], payload: null }),
    submit: () => wrap({ ok: true, stage: 'done', invoiceNumber: 'ABC123', writtenBack: true, warnings: [], errors: [] }),
    submitMany: () => wrap([{ docEntry: 9075, ok: true, invoiceNumber: 'ABC123' }]),
  },
  items: {
    list: () => wrap(sampleItems),
    blocking: () => wrap(sampleItems),
    save: () => wrap({ attempted: 1, saved: 1, failed: 0, readOnly: [], results: [{ itemCode: 'X', ok: true }] }),
    matchUnits: () => wrap([{ itemCode: 'FGF-LBL-001', value: 'Numbers, pieces, units', reason: 'synonym' }]),
    exportCsv: () => wrap('C:/tmp/x.csv'),
    importCsv: () => wrap([{ itemCode: 'FGF-LBL-001', hsCode: '4821.1000', uoM: '', saleType: '' }]),
  },
  repair: { writeBacks: () => wrap([{ docEntry: 1, ok: true }]) },
  audit: {
    orphans: () => wrap([]),
    inFlight: () => wrap([]),
    recent: () => wrap([{ ts: '2026-09-18T00:00:00Z', event: 'posted', docNum: 1, environment: 'sandbox', invoiceNumber: 'A1', writtenBack: true }]),
  },
  fbr: {
    reference: (kind) =>
      wrap(
        kind === 'uom'
          ? [{ uoM_ID: 1, description: 'Numbers, pieces, units' }]
          : kind === 'hsCodes'
            ? [{ hS_CODE: '4819.1000', description: 'CARTONS OF CORRUGATED PAPER' }]
            : [{ stateProvinceCode: 1, stateProvinceDesc: 'Sindh' }]
      ),
  },
  diagnostics: {
    metadata: () => wrap({ path: 'x', bytes: 10 }),
    rawInvoice: () => wrap({ DocEntry: 1 }),
    rawItem: () => wrap({ ItemCode: 'FGF-LBL-001', User_Text: null, U_FBR_HSCode: null }),
  },
  app: { openDataDir: () => wrap('x'), exportAudit: () => wrap('x.jsonl') },
  on: { log() {}, batchProgress() {} },
};

/* ---------------------------------------------------------------- run it */

const failures = [];
const sandbox = {
  document,
  console: { log() {}, warn() {}, error() {} },
  window: { api, confirm: () => true, alert() {} },
  setTimeout,
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  RegExp,
  Error,
  isNaN,
  parseInt,
  parseFloat,
};
sandbox.globalThis = sandbox;
sandbox.window.document = document;

console.log('\nrenderer — load');
try {
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox, { filename: 'app.js' });
  console.log(`  ok    app.js loaded and registered ${handlers.length} handler(s)`);
} catch (err) {
  console.log(`  BUG   app.js threw while loading: ${err.message}`);
  failures.push(`load: ${err.message}`);
}

console.log('\nrenderer — every handler fires without throwing');

(async () => {
  // Give the bootstrap IIFE (which awaits config) a chance to settle.
  await new Promise((r) => setTimeout(r, 50));

  for (const { id, type, fn } of handlers) {
    const target = {
      value: '9075',
      checked: true,
      dataset: { doc: '9075', i: '0', k: 'hsCode', ref: 'provinces', code: '4819.1000', tab: 'items' },
      classList: { contains: () => false, add() {}, remove() {} },
      closest: () => null,
    };
    const event = { target, key: 'Enter', preventDefault() {} };
    try {
      await fn(event);
      console.log(`  ok    ${id} (${type})`);
    } catch (err) {
      console.log(`  BUG   ${id} (${type}) threw: ${err.message}`);
      failures.push(`${id}.${type}: ${err.message}`);
    }
  }

  // Cross-check: nothing may reference an element the HTML does not define.
  const referenced = [...appSource.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((x) => !knownIds.has(x));
  console.log('\nrenderer — element references');
  if (missing.length) {
    missing.forEach((x) => {
      console.log(`  BUG   $('${x}') has no matching element in index.html`);
      failures.push(`missing element: ${x}`);
    });
  } else {
    console.log(`  ok    all ${new Set(referenced).size} referenced ids exist in index.html`);
  }

  console.log(
    failures.length
      ? `\n${failures.length} renderer problem(s):\n  - ${failures.join('\n  - ')}\n`
      : '\nrenderer clean — every handler ran\n'
  );
  process.exit(failures.length ? 1 : 0);
})();
