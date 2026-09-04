'use strict';
/**
 * Offline self-test. Exercises the mapper and the FBR response interpreter
 * against fixtures, so the logic can be verified without SAP or FBR reachable.
 *
 *   node scripts/selftest.js
 */
const assert = require('node:assert');
const { buildFbrPayload, toIsoDate, normaliseProvince, formatRate } = require('../src/main/mapper');
const { interpretResponse } = require('../src/main/fbrClient');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const config = {
  fbr: { environment: 'sandbox' },
  seller: {
    ntnCnic: '0786909',
    businessName: 'Test Trading Co',
    province: 'Sindh',
    address: 'Karachi',
  },
  sapFields: {
    irnField: 'U_FBR_IRN',
    statusField: 'U_FBR_Status',
    bpNtnField: 'FederalTaxID',
    bpProvinceField: 'U_FBR_Province',
    bpRegTypeField: 'U_FBR_RegType',
    itemHsCodeField: 'U_FBR_HSCode',
    itemUomField: 'U_FBR_UOM',
    itemSaleTypeField: 'U_FBR_SaleType',
  },
  mapping: {
    defaultInvoiceType: 'Sale Invoice',
    defaultScenarioId: 'SN001',
    defaultSaleType: 'Goods at standard rate (default)',
    provinces: {},
    uom: {},
  },
  itemOverrides: {},
};

const invoice = {
  DocEntry: 101,
  DocNum: 5001,
  DocDate: '2025-04-21T00:00:00Z',
  CardCode: 'C001',
  CardName: 'FERTILIZER MANUFAC IRS NEW',
  Address: 'Karachi',
  DocTotal: 1180,
  DocumentLines: [
    {
      ItemCode: 'ITEM01',
      ItemDescription: 'Product Description',
      Quantity: 1,
      UnitPrice: 1000,
      LineTotal: 1000,
      TaxPercentagePerRow: 18,
      DiscountPercent: 0,
    },
  ],
};

const bp = {
  CardCode: 'C001',
  CardName: 'FERTILIZER MANUFAC IRS NEW',
  FederalTaxID: '0786909',
  U_FBR_Province: 'Sindh',
  U_FBR_RegType: 'Registered',
};

const items = new Map([
  [
    'ITEM01',
    {
      ItemCode: 'ITEM01',
      U_FBR_HSCode: '0101.2100',
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    },
  ],
]);

console.log('\nmapper — helpers');

test('toIsoDate strips the time component', () => {
  assert.strictEqual(toIsoDate('2025-04-21T00:00:00Z'), '2025-04-21');
  assert.strictEqual(toIsoDate('2025-04-21'), '2025-04-21');
});

test('formatRate renders a numeric percentage as an FBR descriptor', () => {
  assert.strictEqual(formatRate(18, {}), '18%');
  assert.strictEqual(formatRate('18%', {}), '18%');
  assert.strictEqual(formatRate('Exempt', {}), 'Exempt');
});

test('normaliseProvince accepts SAP state codes', () => {
  assert.strictEqual(normaliseProvince('SD'), 'Sindh');
  assert.strictEqual(normaliseProvince('kpk'), 'Khyber Pakhtunkhwa');
  assert.strictEqual(normaliseProvince('Nowhere'), null);
});

console.log('\nmapper — payload construction');

test('a complete invoice maps to a valid FBR payload', () => {
  const { payload, errors } = buildFbrPayload({ invoice, businessPartner: bp, items, config });
  assert.deepStrictEqual(errors, [], `unexpected errors: ${errors.join(' | ')}`);
  assert.ok(payload, 'payload should be produced');
  assert.strictEqual(payload.invoiceType, 'Sale Invoice');
  assert.strictEqual(payload.invoiceDate, '2025-04-21');
  assert.strictEqual(payload.sellerNTNCNIC, '0786909');
  assert.strictEqual(payload.buyerRegistrationType, 'Registered');
  assert.strictEqual(payload.buyerProvince, 'Sindh');
  assert.strictEqual(payload.scenarioId, 'SN001');
  assert.strictEqual(payload.items.length, 1);
});

test('line tax is derived from the row percentage when no amount is present', () => {
  const { payload } = buildFbrPayload({ invoice, businessPartner: bp, items, config });
  const line = payload.items[0];
  assert.strictEqual(line.valueSalesExcludingST, 1000);
  assert.strictEqual(line.salesTaxApplicable, 180);
  assert.strictEqual(line.totalValues, 1180);
  assert.strictEqual(line.rate, '18%');
});

test('an explicit VatSum on the line wins over the percentage', () => {
  const inv = JSON.parse(JSON.stringify(invoice));
  inv.DocumentLines[0].VatSum = 175.5;
  const { payload } = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(payload.items[0].salesTaxApplicable, 175.5);
});

test('a missing HS code is reported instead of sending an empty string', () => {
  const { payload, errors } = buildFbrPayload({
    invoice,
    businessPartner: bp,
    items: new Map(),
    config,
  });
  assert.strictEqual(payload, null);
  assert.ok(
    errors.some((e) => /HS code/i.test(e)),
    `expected an HS code error, got: ${errors.join(' | ')}`
  );
});

test('a registered buyer without an NTN is rejected', () => {
  const noNtn = { ...bp, FederalTaxID: '' };
  const { payload, errors } = buildFbrPayload({
    invoice,
    businessPartner: noNtn,
    items,
    config,
  });
  assert.strictEqual(payload, null);
  assert.ok(errors.some((e) => /NTN/i.test(e)));
});

test('sandbox requires a scenario ID; production omits it', () => {
  const prodConfig = { ...config, fbr: { environment: 'production' } };
  const { payload } = buildFbrPayload({ invoice, businessPartner: bp, items, config: prodConfig });
  assert.ok(payload);
  assert.strictEqual(payload.scenarioId, undefined);

  const noScenario = {
    ...config,
    mapping: { ...config.mapping, defaultScenarioId: '' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: noScenario });
  assert.strictEqual(r.payload, null);
  assert.ok(r.errors.some((e) => /scenarioId/i.test(e)));
});

test('a debit note without a reference number is rejected', () => {
  const dn = { ...invoice, U_FBR_InvoiceType: 'Debit Note' };
  const cfg = {
    ...config,
    sapFields: { ...config.sapFields, invoiceTypeField: 'U_FBR_InvoiceType', refNoField: 'U_FBR_RefNo' },
  };
  const { payload, errors } = buildFbrPayload({
    invoice: dn,
    businessPartner: bp,
    items,
    config: cfg,
  });
  assert.strictEqual(payload, null);
  assert.ok(errors.some((e) => /invoiceRefNo/i.test(e)));
});

test('a total that disagrees with DocTotal raises a warning, not an error', () => {
  const inv = { ...invoice, DocTotal: 9999 };
  const { payload, warnings } = buildFbrPayload({
    invoice: inv,
    businessPartner: bp,
    items,
    config,
  });
  assert.ok(payload, 'payload should still be produced');
  assert.ok(warnings.some((w) => /differs from SAP DocTotal/i.test(w)));
});

console.log('\nfbrClient — response interpretation');

test('a valid response yields the invoice number', () => {
  const r = interpretResponse({
    invoiceNumber: '7000007DI1747119701593',
    dated: '2025-05-13 12:01:41',
    validationResponse: {
      statusCode: '00',
      status: 'Valid',
      error: '',
      invoiceStatuses: [
        { itemSNo: '1', statusCode: '00', status: 'Valid', invoiceNo: '7000007DI1747119701593-1', errorCode: '', error: '' },
      ],
    },
  });
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(r.invoiceNumber, '7000007DI1747119701593');
  assert.deepStrictEqual(r.errors, []);
});

test('a header-level rejection is not treated as accepted', () => {
  const r = interpretResponse({
    dated: '2025-05-13 13:09:05',
    validationResponse: {
      statusCode: '01',
      status: 'Invalid',
      errorCode: '0052',
      error: 'Provide proper HS Code with invoice no. null',
      invoiceStatuses: null,
    },
  });
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.invoiceNumber, null);
  assert.ok(/0052/.test(r.errorSummary));
});

test('an item-level rejection under a 00 envelope is not treated as accepted', () => {
  const r = interpretResponse({
    dated: '2025-05-13 13:10:00',
    validationResponse: {
      statusCode: '00',
      status: 'invalid',
      error: '',
      invoiceStatuses: [
        { itemSNo: '1', statusCode: '01', status: 'Invalid', invoiceNo: null, errorCode: '0046', error: 'Provide rate.' },
      ],
    },
  });
  assert.strictEqual(r.accepted, false);
  assert.ok(/item 1/i.test(r.errorSummary));
  assert.ok(/0046/.test(r.errorSummary));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
