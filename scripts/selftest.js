'use strict';
/**
 * Offline self-test. Exercises the mapper and the FBR response interpreter
 * against fixtures, so the logic can be verified without SAP or FBR reachable.
 *
 *   node scripts/selftest.js
 */
const assert = require('node:assert');
const {
  buildFbrPayload,
  toIsoDate,
  normaliseProvince,
  formatRate,
  extractHsCode,
  matchUom,
  sanitizeText,
} = require('../src/main/mapper');
const { interpretResponse } = require('../src/main/fbrClient');
const { sapErrorCode, describeSapError, LOGIN_HINTS, SapClient } = require('../src/main/sapClient');

let passed = 0;
let failed = 0;

// Async cases are collected and awaited before the summary; without this an
// async assertion failure would surface as an unhandled rejection and the run
// would report a pass it never earned.
const pending = [];

function test(name, fn) {
  const ok = () => {
    passed++;
    console.log(`  PASS  ${name}`);
  };
  const bad = (err) => {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(ok, bad));
      return;
    }
    ok();
  } catch (err) {
    bad(err);
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

console.log('\nmapper — HS code extraction from free text');

test('an HS code is found inside free-text remarks', () => {
  assert.strictEqual(extractHsCode('4819.1000'), '4819.1000');
  assert.strictEqual(extractHsCode('  4819.1000  '), '4819.1000');
  assert.strictEqual(extractHsCode('HS Code: 4819.1000'), '4819.1000');
  assert.strictEqual(extractHsCode('4819.1000 - CARTON 5 PLY'), '4819.1000');
  assert.strictEqual(extractHsCode('Corrugated carton (hs 4819.1000), 5-ply'), '4819.1000');
});

test('bare eight-digit codes are normalised', () => {
  assert.strictEqual(extractHsCode('48191000'), '4819.1000');
  assert.strictEqual(extractHsCode('HS 48191000 5ply'), '4819.1000');
});

test('a six-digit heading is passed through, never padded', () => {
  // Inventing the last two digits would change the tariff classification.
  assert.strictEqual(extractHsCode('4819.10'), '4819.10');
});

test('free text with no code returns null rather than a guess', () => {
  assert.strictEqual(extractHsCode('CARTON 31 x 23 x 12.75" 5-PLY CBB/P+S/S+S/ND'), null);
  assert.strictEqual(extractHsCode('no code here'), null);
  assert.strictEqual(extractHsCode(''), null);
  assert.strictEqual(extractHsCode(null), null);
});

test('dimensions in a description are not mistaken for a code', () => {
  // "705 x 400 x 530MM" and "31 x 23 x 12.75" must not yield an HS code.
  assert.strictEqual(extractHsCode('CARTON 705 x 400 x 530MM'), null);
  assert.strictEqual(extractHsCode('CARTON 13 x 12 x 10" 5-PLY'), null);
});

test('Remarks is read from User_Text, the real Items property name', () => {
  // Service Layer exposes OITM.UserText on Items as `User_Text`, with an
  // underscore. Reading `UserText` silently finds nothing.
  const remarksOnly = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      User_Text: 'HS Code: 4821.1000 - printed label',
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    }],
  ]);
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: remarksOnly, config });
  assert.deepStrictEqual(r.errors, [], `unexpected errors: ${r.errors.join(' | ')}`);
  assert.strictEqual(r.payload.items[0].hsCode, '4821.1000');
});

test('the Intrastat commodity code is used when populated', () => {
  const withCommodity = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      ItemIntrastatExtension: { CommodityCode: '4819.1000' },
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    }],
  ]);
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: withCommodity, config });
  assert.strictEqual(r.payload.items[0].hsCode, '4819.1000');
});

test('an item with every source empty is reported as missing, not guessed', () => {
  // Exactly FGF-LBL-001: the UDFs exist but are null, Remarks is null.
  const empty = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      ItemName: 'LABELING & SEALING',
      U_FBR_HSCode: null,
      U_FBR_UOM: null,
      U_FBR_SaleType: null,
      User_Text: null,
      SalesUnit: null,
      InventoryUOM: null,
      CustomsGroupCode: -1,
      ItemIntrastatExtension: { CommodityCode: null },
    }],
  ]);
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: empty, config });
  assert.strictEqual(r.payload, null);
  assert.ok(r.errors.some((e) => /have no HS code/i.test(e)));
});

test('the item Remarks field is consulted without any configuration', () => {
  // The default config still points at U_FBR_HSCode; Remarks must still work.
  const remarksOnly = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      User_Text: 'HS Code: 4821.1000 - printed label',
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    }],
  ]);
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: remarksOnly, config });
  assert.deepStrictEqual(r.errors, [], `unexpected errors: ${r.errors.join(' | ')}`);
  assert.strictEqual(r.payload.items[0].hsCode, '4821.1000');
  // Using Remarks is noted, not silent.
  assert.ok(r.warnings.some((w) => /Remarks/i.test(w)));
});

test('a dedicated field beats Remarks, but a note in it falls through', () => {
  const both = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      U_FBR_HSCode: '4819.1000',
      UserText: 'HS 4821.1000',
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    }],
  ]);
  assert.strictEqual(
    buildFbrPayload({ invoice, businessPartner: bp, items: both, config }).payload.items[0].hsCode,
    '4819.1000'
  );

  // A dedicated field holding a note must not block Remarks from being used.
  const noteInUdf = new Map([
    ['ITEM01', {
      ItemCode: 'ITEM01',
      U_FBR_HSCode: 'TBC',
      UserText: '4821.1000',
      U_FBR_UOM: 'Numbers, pieces, units',
      U_FBR_SaleType: 'Goods at standard rate (default)',
    }],
  ]);
  assert.strictEqual(
    buildFbrPayload({ invoice, businessPartner: bp, items: noteInUdf, config }).payload.items[0].hsCode,
    '4821.1000'
  );
});

test('an item whose source field holds no readable code is reported distinctly', () => {
  const remarksItems = new Map([
    ['ITEM01', { ItemCode: 'ITEM01', UserText: 'CARTON 5-PLY, no code', U_FBR_UOM: 'Numbers, pieces, units', U_FBR_SaleType: 'Goods at standard rate (default)' }],
  ]);
  const cfg = { ...config, sapFields: { ...config.sapFields, itemHsCodeField: 'UserText' } };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: remarksItems, config: cfg });
  assert.strictEqual(r.payload, null);
  assert.ok(
    r.errors.some((e) => /no code could be read from it/i.test(e)),
    `expected an unreadable-source error, got: ${r.errors.join(' | ')}`
  );
  // The message must name where the text actually came from.
  assert.ok(r.errors.some((e) => /UserText holds/i.test(e)));
});

test('reading the HS code from the Remarks field produces a valid payload', () => {
  const remarksItems = new Map([
    ['ITEM01', { ItemCode: 'ITEM01', UserText: 'HS Code: 4819.1000 (corrugated)', U_FBR_UOM: 'Numbers, pieces, units', U_FBR_SaleType: 'Goods at standard rate (default)' }],
  ]);
  const cfg = { ...config, sapFields: { ...config.sapFields, itemHsCodeField: 'UserText' } };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: remarksItems, config: cfg });
  assert.deepStrictEqual(r.errors, [], `unexpected errors: ${r.errors.join(' | ')}`);
  assert.strictEqual(r.payload.items[0].hsCode, '4819.1000');
});

console.log('\nmapper — unit of measure matching');

const FBR_UOMS = [
  { uoM_ID: 1, description: 'Numbers, pieces, units' },
  { uoM_ID: 13, description: 'KG' },
  { uoM_ID: 77, description: 'Square Metre' },
  { uoM_ID: 5, description: 'Litre' },
  { uoM_ID: 9, description: 'Meter' },
];

test('common SAP unit codes resolve to FBR units', () => {
  assert.strictEqual(matchUom('PCS', FBR_UOMS).value, 'Numbers, pieces, units');
  assert.strictEqual(matchUom('CTN', FBR_UOMS).value, 'Numbers, pieces, units');
  assert.strictEqual(matchUom('EA', FBR_UOMS).value, 'Numbers, pieces, units');
  assert.strictEqual(matchUom('kgs', FBR_UOMS).value, 'KG');
  assert.strictEqual(matchUom('LTR', FBR_UOMS).value, 'Litre');
  assert.strictEqual(matchUom('SQM', FBR_UOMS).value, 'Square Metre');
});

test('punctuation in a SAP unit code does not defeat the match', () => {
  // Regression: normaliseUomKey must strip everything but letters and digits.
  assert.strictEqual(matchUom('pcs.', FBR_UOMS).value, 'Numbers, pieces, units');
  assert.strictEqual(matchUom('K.G.', FBR_UOMS).value, 'KG');
  assert.strictEqual(matchUom('sq-m', FBR_UOMS).value, 'Square Metre');
  assert.strictEqual(matchUom(' KG ', FBR_UOMS).value, 'KG');
});

test('a unit already naming an FBR value matches exactly', () => {
  assert.strictEqual(matchUom('KG', FBR_UOMS).reason, 'exact match');
  assert.strictEqual(matchUom('Numbers, pieces, units', FBR_UOMS).value, 'Numbers, pieces, units');
});

test('a configured mapping beats the built-in synonyms', () => {
  const m = matchUom('PCS', FBR_UOMS, { PCS: 'KG' });
  assert.strictEqual(m.value, 'KG');
  assert.strictEqual(m.reason, 'configured mapping');
});

test('an unknown unit is left for the user rather than guessed', () => {
  assert.strictEqual(matchUom('WIDGET', FBR_UOMS), null);
  assert.strictEqual(matchUom('', FBR_UOMS), null);
});

test('nothing is proposed when FBR returned no list', () => {
  // Never fabricate a unit FBR has not published.
  assert.strictEqual(matchUom('PCS', []), null);
  assert.strictEqual(matchUom('PCS', null), null);
});

test('the invoice line unit resolves through the site mapping table', () => {
  const noUomItems = new Map([
    ['ITEM01', { ItemCode: 'ITEM01', U_FBR_HSCode: '4819.1000', U_FBR_SaleType: 'Goods at standard rate (default)' }],
  ]);
  const inv = JSON.parse(JSON.stringify(invoice));
  inv.DocumentLines[0].MeasureUnit = 'PCS';
  const cfg = {
    ...config,
    mapping: { ...config.mapping, uom: { PCS: 'Numbers, pieces, units' } },
  };
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items: noUomItems, config: cfg });
  assert.deepStrictEqual(r.errors, [], `unexpected errors: ${r.errors.join(' | ')}`);
  assert.strictEqual(r.payload.items[0].uoM, 'Numbers, pieces, units');
});

test('a configured default unit unblocks items with nothing else set', () => {
  const noUomItems = new Map([
    ['ITEM01', { ItemCode: 'ITEM01', U_FBR_HSCode: '4819.1000', U_FBR_SaleType: 'Goods at standard rate (default)' }],
  ]);
  const cfg = {
    ...config,
    mapping: { ...config.mapping, defaultUom: 'Numbers, pieces, units' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items: noUomItems, config: cfg });
  assert.deepStrictEqual(r.errors, [], `unexpected errors: ${r.errors.join(' | ')}`);
  assert.strictEqual(r.payload.items[0].uoM, 'Numbers, pieces, units');
});

console.log('\nmapper — payload is safe to serialise');

test('control characters never reach the payload', () => {
  const dirty = {
    ...invoice,
    CardName: 'GLAXO  SMITHKLINE',
    Address: 'DOCKYARD ROAD\r\r \rKARACHI',
    DocumentLines: [
      {
        ItemCode: 'ITEM01',
        ItemDescription: 'CARTON 31 x 23 x 12.75" 5-PLY\r\nCBB/P+S',
        Quantity: 1,
        UnitPrice: 1000,
        LineTotal: 1000,
        TaxPercentagePerRow: 18,
      },
    ],
  };
  const r = buildFbrPayload({ invoice: dirty, businessPartner: bp, items, config });
  const json = JSON.stringify(r.payload);
  assert.ok(!/[ -]/.test(json), 'no control characters may be serialised');
  assert.strictEqual(JSON.stringify(JSON.parse(json)), json, 'payload must round-trip');
  assert.strictEqual(r.payload.buyerBusinessName, 'GLAXO SMITHKLINE');
  assert.strictEqual(r.payload.items[0].productDescription, "CARTON 31 x 23 x 12.75' 5-PLY CBB/P+S");
});

test('exotic punctuation is folded to ASCII', () => {
  assert.strictEqual(sanitizeText('smart “quotes” and —dash'), "smart 'quotes' and -dash");
  assert.strictEqual(sanitizeText('non breaking'), 'non breaking');
  assert.strictEqual(sanitizeText('tab\there'), 'tab here');
  assert.strictEqual(sanitizeText('NUL here'), 'NULhere');
});

test('the payload contains no JSON escape sequences at all', () => {
  // FBR's gateway answers "Requested JSON in Malformed" to a body containing
  // an escaped quote, even though the escaping is valid. The real failing
  // description from invoice 9170 is the fixture.
  const dirty = {
    ...invoice,
    DocumentLines: [
      {
        ItemCode: 'ITEM01',
        ItemDescription: 'KRAFT 12 x 12 x 7.5" 5 PLY',
        Quantity: 963,
        UnitPrice: 70,
        LineTotal: 67410,
        TaxPercentagePerRow: 18,
      },
    ],
  };
  const r = buildFbrPayload({ invoice: dirty, businessPartner: bp, items, config });
  const json = JSON.stringify(r.payload);
  assert.ok(!json.includes('\\"'), 'no escaped double quotes may be serialised');
  assert.ok(!json.includes('\\\\'), 'no escaped backslashes may be serialised');
  assert.strictEqual(r.payload.items[0].productDescription, "KRAFT 12 x 12 x 7.5' 5 PLY");
});

test('backslashes are folded too', () => {
  assert.strictEqual(sanitizeText('A\\B'), 'A/B');
  assert.strictEqual(sanitizeText('say "hi"'), "say 'hi'");
});

console.log('\nmapper — rate override');

test('an override forces the rate AND recalculates the tax to match', () => {
  const untaxed = JSON.parse(JSON.stringify(invoice));
  untaxed.DocumentLines[0].TaxPercentagePerRow = 0;
  untaxed.DocTotal = 1000;

  const cfg = { ...config, mapping: { ...config.mapping, rateOverride: '18%' } };
  const r = buildFbrPayload({ invoice: untaxed, businessPartner: bp, items, config: cfg });
  const line = r.payload.items[0];

  assert.strictEqual(line.rate, '18%');
  // The whole point: rate and amount must agree, or the filing contradicts itself.
  assert.strictEqual(line.salesTaxApplicable, 180);
  assert.strictEqual(line.totalValues, 1180);
  assert.ok(
    r.warnings.some((w) => /RATE OVERRIDE ACTIVE/.test(w)),
    'an override that changes the tax must be loudly flagged'
  );
  assert.ok(r.warnings.some((w) => /0\.00 -> 180\.00/.test(w)), 'the change must be quantified');
});

test('an override matching SAP changes nothing and warns about nothing', () => {
  const cfg = { ...config, mapping: { ...config.mapping, rateOverride: '18%' } };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: cfg });
  assert.strictEqual(r.payload.items[0].salesTaxApplicable, 180);
  assert.ok(!r.warnings.some((w) => /RATE OVERRIDE ACTIVE/.test(w)));
});

test('a non-numeric override sets the descriptor but leaves amounts alone', () => {
  const cfg = { ...config, mapping: { ...config.mapping, rateOverride: 'Exempt' } };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: cfg });
  assert.strictEqual(r.payload.items[0].rate, 'Exempt');
  assert.strictEqual(r.payload.items[0].salesTaxApplicable, 180, 'SAP amount must be preserved');
  assert.ok(r.warnings.some((w) => /carries no single percentage/i.test(w)));
});

test('no override leaves SAP untouched', () => {
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config });
  assert.strictEqual(r.payload.items[0].rate, '18%');
  assert.ok(!r.warnings.some((w) => /RATE OVERRIDE/.test(w)));
});

test('parseRatePercent rejects compound descriptors', () => {
  // "18% along with rupees 60 per kilogram" is a real FBR descriptor; deriving
  // a tax amount from it would silently drop the per-kilogram component.
  const cfg = {
    ...config,
    mapping: { ...config.mapping, rateOverride: '18% along with rupees 60 per kilogram' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: cfg });
  assert.strictEqual(r.payload.items[0].salesTaxApplicable, 180, 'amounts must not be guessed');
  assert.ok(r.warnings.some((w) => /carries no single percentage/i.test(w)));
});

console.log('\nmapper — consistency pre-flight checks');

const unregisteredBp = { ...bp, FederalTaxID: '', U_FBR_RegType: 'Unregistered' };

test('SN001 is switched to SN002 for an unregistered buyer', () => {
  // FBR rejects the mismatch with 0205; the pair differ only by this flag.
  const r = buildFbrPayload({ invoice, businessPartner: unregisteredBp, items, config });
  assert.strictEqual(r.payload.scenarioId, 'SN002');
  assert.ok(r.warnings.some((w) => /switched from SN001 to SN002/i.test(w)));
});

test('SN002 is switched to SN001 for a registered buyer', () => {
  const cfg = { ...config, mapping: { ...config.mapping, defaultScenarioId: 'SN002' } };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: cfg });
  assert.strictEqual(r.payload.scenarioId, 'SN001');
});

test('an already-correct scenario is left alone and unremarked', () => {
  const cfg = { ...config, mapping: { ...config.mapping, defaultScenarioId: 'SN002' } };
  const r = buildFbrPayload({ invoice, businessPartner: unregisteredBp, items, config: cfg });
  assert.strictEqual(r.payload.scenarioId, 'SN002');
  assert.ok(!r.warnings.some((w) => /switched from/i.test(w)));
});

test('no other scenario is ever switched', () => {
  // SN005 encodes a goods category; the buyer's status says nothing about it.
  const cfg = { ...config, mapping: { ...config.mapping, defaultScenarioId: 'SN005' } };
  const r = buildFbrPayload({ invoice, businessPartner: unregisteredBp, items, config: cfg });
  assert.strictEqual(r.payload.scenarioId, 'SN005');
  assert.ok(!r.warnings.some((w) => /switched from/i.test(w)));
});

test('with the switch disabled, the mismatch is warned about instead', () => {
  const cfg = { ...config, mapping: { ...config.mapping, autoScenarioByBuyer: false } };
  const r = buildFbrPayload({ invoice, businessPartner: unregisteredBp, items, config: cfg });
  assert.strictEqual(r.payload.scenarioId, 'SN001', 'the configured value must be sent as-is');
  assert.ok(r.warnings.some((w) => /0205/.test(w)), 'the user must be told what FBR will say');
});

test('an invoice-level scenario override is still corrected', () => {
  const withOverride = { ...invoice, U_FBR_ScenarioId: 'SN001' };
  const cfg = {
    ...config,
    sapFields: { ...config.sapFields, scenarioField: 'U_FBR_ScenarioId' },
  };
  const r = buildFbrPayload({
    invoice: withOverride,
    businessPartner: unregisteredBp,
    items,
    config: cfg,
  });
  assert.strictEqual(r.payload.scenarioId, 'SN002');
});

test('a standard-rate line carrying no tax is flagged', () => {
  const untaxed = JSON.parse(JSON.stringify(invoice));
  untaxed.DocumentLines[0].TaxPercentagePerRow = 0;
  untaxed.DocTotal = 1000;
  const r = buildFbrPayload({ invoice: untaxed, businessPartner: bp, items, config });
  assert.ok(r.payload, 'it is a warning, not a blocker');
  assert.ok(
    r.warnings.some((w) => /carry no sales tax but are marked/i.test(w)),
    `expected a zero-tax warning, got: ${r.warnings.join(' | ')}`
  );
});

console.log('\nmapper — buyer address resolution');

test('bare carriage returns in a SAP address are cleaned, not passed through', () => {
  // Exactly as it comes back from this installation: CR without LF.
  const inv = {
    ...invoice,
    Address: 'DOCKYARD ROAD WEST WHARF KARACHI PAKISTAN\r\r \rPAKISTAN',
  };
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(
    r.payload.buyerAddress,
    'DOCKYARD ROAD WEST WHARF KARACHI PAKISTAN, PAKISTAN'
  );
  assert.ok(!/[\r\n]/.test(r.payload.buyerAddress), 'no control characters may reach FBR');
});

test('an address of only whitespace and breaks counts as empty', () => {
  const inv = { ...invoice, Address: '\r\n  \r ' };
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(r.payload, null);
  assert.ok(r.errors.some((e) => /Buyer address is empty/i.test(e)));
});

test('the line tax amount is read from TaxTotal', () => {
  // This installation exposes the line tax as TaxTotal, not VatSum.
  const inv = JSON.parse(JSON.stringify(invoice));
  delete inv.DocumentLines[0].TaxPercentagePerRow;
  inv.DocumentLines[0].TaxTotal = 180;
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(r.payload.items[0].salesTaxApplicable, 180);
  assert.strictEqual(r.payload.items[0].totalValues, 1180);
});

test('the address is found in AddressExtension when the document has none', () => {
  const inv = {
    ...invoice,
    Address: '',
    AddressExtension: {
      BillToStreet: '12 Industrial Rd',
      BillToCity: 'Karachi',
      BillToState: 'Sindh',
      BillToZipCode: '74900',
    },
  };
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(r.payload.buyerAddress, '12 Industrial Rd, Karachi, Sindh, 74900');
});

test('the address is found on the business partner address collection', () => {
  const inv = { ...invoice, Address: '' };
  const withAddresses = {
    ...bp,
    BPAddresses: [{ AddressType: 'bo_BillTo', Street: '5 Mall Rd', City: 'Lahore', State: 'Punjab' }],
  };
  const r = buildFbrPayload({ invoice: inv, businessPartner: withAddresses, items, config });
  assert.strictEqual(r.payload.buyerAddress, '5 Mall Rd, Lahore, Punjab');
});

test('a default seller address unblocks, and says so', () => {
  const noSeller = { ...config, seller: { ...config.seller, address: '' } };
  const blocked = buildFbrPayload({ invoice, businessPartner: bp, items, config: noSeller });
  assert.strictEqual(blocked.payload, null);
  assert.ok(blocked.errors.some((e) => /Seller address is not configured/i.test(e)));

  const withDefault = {
    ...noSeller,
    mapping: { ...config.mapping, defaultSellerAddress: 'Plot 5, SITE Area, Karachi' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: withDefault });
  assert.strictEqual(r.payload.sellerAddress, 'Plot 5, SITE Area, Karachi');
  assert.ok(r.warnings.some((w) => /configured default/i.test(w)));
});

test('a seller address in Settings beats the default', () => {
  const both = {
    ...config,
    mapping: { ...config.mapping, defaultSellerAddress: 'Should not be used' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: bp, items, config: both });
  assert.strictEqual(r.payload.sellerAddress, 'Karachi');
  assert.ok(!r.warnings.some((w) => /configured default/i.test(w)));
});

test('a fallback address unblocks, and says so', () => {
  const inv = { ...invoice, Address: '' };
  const blocked = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config });
  assert.strictEqual(blocked.payload, null);
  assert.ok(blocked.errors.some((e) => /Buyer address is empty/i.test(e)));

  const cfg = { ...config, mapping: { ...config.mapping, defaultBuyerAddress: 'Karachi' } };
  const r = buildFbrPayload({ invoice: inv, businessPartner: bp, items, config: cfg });
  assert.strictEqual(r.payload.buyerAddress, 'Karachi');
  assert.ok(r.warnings.some((w) => /fallback/i.test(w)));
});

console.log('\nmapper — consolidated reporting');

test('missing master data is reported per item, not per line', () => {
  // Four lines of the SAME unmapped product is one thing to fix, not four.
  const repeated = {
    ...invoice,
    DocumentLines: [1, 2, 3, 4].map(() => ({
      ItemCode: 'SAME-1',
      ItemDescription: 'Repeated product',
      Quantity: 1,
      UnitPrice: 10,
      LineTotal: 10,
      TaxPercentagePerRow: 18,
    })),
  };
  const r = buildFbrPayload({
    invoice: repeated,
    businessPartner: bp,
    items: new Map(),
    config,
  });
  const hsErrors = r.errors.filter((e) => /HS code/i.test(e));
  assert.strictEqual(hsErrors.length, 1, 'one consolidated HS code error expected');
  assert.ok(/^1 item\(s\)/.test(hsErrors[0]), `expected a count of 1, got: ${hsErrors[0]}`);
  assert.ok(/lines 1, 2, 3, 4/.test(hsErrors[0]), 'affected lines should still be named');
  // The wording has to answer "do I set this per invoice?" — it is per product.
  assert.ok(/once per product, not per invoice/.test(hsErrors[0]));
});

test('a missing buyer province blocks unless a fallback is configured', () => {
  const noProvince = { ...bp, U_FBR_Province: '' };

  const blocked = buildFbrPayload({ invoice, businessPartner: noProvince, items, config });
  assert.strictEqual(blocked.payload, null);
  assert.ok(blocked.errors.some((e) => /province/i.test(e)));

  const withFallback = {
    ...config,
    mapping: { ...config.mapping, defaultProvince: 'Punjab' },
  };
  const r = buildFbrPayload({ invoice, businessPartner: noProvince, items, config: withFallback });
  assert.ok(r.payload, 'fallback should let the payload build');
  assert.strictEqual(r.payload.buyerProvince, 'Punjab');
  // Using the fallback must never be silent - the province affects the filing.
  assert.ok(r.warnings.some((w) => /fallback/i.test(w)));
});

console.log('\nsapClient — invoice paging');

/** A SapClient whose HTTP layer is replaced by fixed pages. */
function pagedClient(totalRows, pageSize) {
  const client = new SapClient({ baseUrl: 'http://x', companyDB: 'd', username: 'u', password: 'p' });
  client.requests = [];
  client.withSession = async (method, path) => {
    const skipMatch = path.match(/\$skip=(\d+)/);
    const skip = skipMatch ? Number(skipMatch[1]) : 0;
    client.requests.push(skip);
    const page = [];
    for (let i = skip; i < Math.min(skip + pageSize, totalRows); i++) {
      page.push({ DocEntry: i + 1, DocNum: i + 1, DocDate: '2013-06-01' });
    }
    return { body: { value: page } };
  };
  return client;
}

const listArgs = { statusField: 'U_FBR_Status', irnField: 'U_FBR_IRN', pageSize: 20 };

test('paging keeps going until a short page is returned', async () => {
  const client = pagedClient(55, 20);
  const { rows, truncated } = await client.listInvoices(listArgs);
  assert.strictEqual(rows.length, 55, 'every matching invoice should be returned');
  assert.strictEqual(truncated, false);
  // 0, 20, 40 -> the 40 page is short (15), so it stops there.
  assert.deepStrictEqual(client.requests, [0, 20, 40]);
});

test('a single short page needs only one request', async () => {
  const client = pagedClient(7, 20);
  const { rows } = await client.listInvoices(listArgs);
  assert.strictEqual(rows.length, 7);
  assert.deepStrictEqual(client.requests, [0]);
});

test('an exact multiple of the page size still terminates', async () => {
  const client = pagedClient(40, 20);
  const { rows } = await client.listInvoices(listArgs);
  assert.strictEqual(rows.length, 40);
  // Needs the empty third page to know it has finished.
  assert.deepStrictEqual(client.requests, [0, 20, 40]);
});

test('the result is capped and flagged rather than fetched forever', async () => {
  const client = pagedClient(10000, 20);
  const { rows, truncated } = await client.listInvoices({ ...listArgs, maxResults: 50 });
  assert.strictEqual(rows.length, 50);
  assert.strictEqual(truncated, true, 'the caller must be told the list was cut short');
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

console.log('\nsapClient — error interpretation');

test('sapErrorCode extracts the numeric B1 code', () => {
  const body = {
    error: { code: -306, message: { lang: 'en-us', value: 'Fail to NONE-SSO login from SLD' } },
  };
  assert.strictEqual(sapErrorCode(body), -306);
  assert.strictEqual(sapErrorCode({}), null);
  assert.strictEqual(sapErrorCode('plain text'), null);
  assert.strictEqual(sapErrorCode(null), null);
});

test('describeSapError renders code and message together', () => {
  const body = {
    error: { code: -306, message: { lang: 'en-us', value: 'Fail to NONE-SSO login from SLD' } },
  };
  assert.strictEqual(describeSapError(body), '-306 Fail to NONE-SSO login from SLD');
});

test('the SLD login failure carries actionable guidance', () => {
  const hint = LOGIN_HINTS['-306'];
  assert.ok(hint, 'expected a hint for -306');
  assert.ok(/CompanyDB/.test(hint), 'hint should mention the company database');
  assert.ok(/SLD/.test(hint), 'hint should mention the SLD');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
});
