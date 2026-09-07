'use strict';
/**
 * Maps a SAP Business One A/R Invoice onto the FBR Digital Invoicing payload.
 *
 * Deliberately defensive about field names: Service Layer exposes slightly
 * different line-level tax properties across B1 versions and localisations, and
 * every HS code / UoM / sale type is site-specific master data. So each value is
 * resolved through a chain:
 *      invoice or item UDF  ->  local override table  ->  configured default
 * and anything still missing is reported as a mapping error rather than being
 * silently sent to FBR as an empty string (which FBR rejects with a vague code).
 */

const MONEY = 2;
const QTY = 4;

function round(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(dp));
}

/** First defined, non-empty value among `names` on `obj`. */
function pick(obj, names, fallback = undefined) {
  if (!obj) return fallback;
  for (const n of names) {
    if (!n) continue;
    const v = obj[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

/** SAP dates arrive as "2025-04-21" or "2025-04-21T00:00:00Z"; FBR wants YYYY-MM-DD. */
function toIsoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** FBR expects the rate as a descriptor string, e.g. "18%" or "Exempt". */
function formatRate(value, cfg) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (/%|exempt|zero|nil/i.test(s)) return s; // already a descriptor
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const dp = cfg && cfg.rateDecimals ? cfg.rateDecimals : 0;
  return `${Number(n.toFixed(dp))}%`;
}

/**
 * Line-level sales tax amount. Prefer an explicit amount from Service Layer;
 * fall back to deriving it from the row's tax percentage.
 */
function lineTaxAmount(line, netAmount) {
  const explicit = pick(line, ['VatSum', 'TaxTotal', 'TaxSum', 'LineVatSum', 'VATSum']);
  if (explicit !== undefined && Number.isFinite(Number(explicit)) && Number(explicit) !== 0) {
    return Number(explicit);
  }
  const pct = Number(pick(line, ['TaxPercentagePerRow', 'VatPrcnt', 'TaxRate'], 0));
  if (Number.isFinite(pct) && pct !== 0) return (netAmount * pct) / 100;
  return 0;
}

/** Line net (excluding sales tax). */
function lineNetAmount(line) {
  const lineTotal = pick(line, ['LineTotal', 'RowTotal'], undefined);
  if (lineTotal !== undefined) return Number(lineTotal);
  const qty = Number(pick(line, ['Quantity'], 0));
  const price = Number(pick(line, ['UnitPrice', 'Price'], 0));
  return qty * price;
}

/**
 * Build the FBR payload.
 *
 * @param {object} input
 * @param {object} input.invoice              full SAP invoice (with DocumentLines)
 * @param {object} [input.businessPartner]
 * @param {Map<string,object>} [input.items]  ItemCode -> SAP item master
 * @param {object} input.config               app config
 * @returns {{payload:object|null, errors:string[], warnings:string[]}}
 */
function buildFbrPayload({ invoice, businessPartner, items = new Map(), config }) {
  const errors = [];
  const warnings = [];
  const f = config.sapFields || {};
  const seller = config.seller || {};
  const map = config.mapping || {};
  const overrides = config.itemOverrides || {};

  // ------------------------------------------------------------------ header
  const invoiceDate = toIsoDate(invoice.DocDate);
  if (!invoiceDate) errors.push('Invoice date (DocDate) is missing or unparseable.');

  if (!seller.ntnCnic) errors.push('Seller NTN/CNIC is not configured (Settings -> Seller).');
  if (!seller.businessName) errors.push('Seller business name is not configured.');
  if (!seller.province) errors.push('Seller province is not configured.');
  if (!seller.address) errors.push('Seller address is not configured.');

  // Buyer NTN/CNIC: BP master federal tax ID, or a UDF override on the BP.
  const buyerNtn = String(
    pick(businessPartner, [f.bpNtnField, 'FederalTaxID', 'AdditionalID'], '') || ''
  ).replace(/[^0-9]/g, '');

  // Registration type: an explicit BP UDF wins; otherwise infer from the tax ID.
  // FBR treats 7/9 digits as an NTN and 13 digits as a CNIC (i.e. a consumer).
  let buyerRegistrationType = pick(businessPartner, [f.bpRegTypeField || 'U_FBR_RegType'], null);
  if (!buyerRegistrationType) {
    buyerRegistrationType = buyerNtn && buyerNtn.length !== 13 ? 'Registered' : 'Unregistered';
    warnings.push(
      `Buyer registration type inferred as "${buyerRegistrationType}" from the tax ID. Set ${
        f.bpRegTypeField || 'U_FBR_RegType'
      } on the business partner to make this explicit.`
    );
  }
  const isRegisteredBuyer = String(buyerRegistrationType).toLowerCase() === 'registered';
  if (isRegisteredBuyer && !buyerNtn) {
    errors.push(
      `Buyer is marked Registered but has no NTN/CNIC on the business partner (${
        f.bpNtnField || 'FederalTaxID'
      }).`
    );
  }

  const buyerAddress =
    typeof invoice.Address === 'string' && invoice.Address.trim()
      ? invoice.Address.replace(/\r?\n/g, ', ')
      : pick(businessPartner, ['Address'], '');

  const rawProvince =
    pick(businessPartner, [f.bpProvinceField || 'U_FBR_Province'], null) ||
    extractProvince(invoice, businessPartner);
  let buyerProvince = normaliseProvince(rawProvince, map.provinces);

  // A configured fallback keeps invoices moving when the business partner has
  // no usable state, but it is recorded as a warning every time: the province
  // affects the filing, so silently guessing it would be wrong.
  if (!buyerProvince && map.defaultProvince) {
    buyerProvince = map.defaultProvince;
    warnings.push(
      `Buyer province could not be read from the business partner; used the configured fallback "${map.defaultProvince}". Set ${
        f.bpProvinceField || 'U_FBR_Province'
      } on the business partner to record the real one.`
    );
  }

  if (!buyerProvince) {
    errors.push(
      `Buyer province could not be determined or does not match an FBR province. Set ${
        f.bpProvinceField || 'U_FBR_Province'
      } on the business partner, or add an entry under Settings -> Province mapping.`
    );
  }

  const payload = {
    invoiceType:
      pick(invoice, [f.invoiceTypeField || 'U_FBR_InvoiceType'], null) ||
      map.defaultInvoiceType ||
      'Sale Invoice',
    invoiceDate,
    sellerNTNCNIC: seller.ntnCnic || '',
    sellerBusinessName: seller.businessName || '',
    sellerProvince: seller.province || '',
    sellerAddress: seller.address || '',
    buyerNTNCNIC: buyerNtn,
    buyerBusinessName: invoice.CardName || pick(businessPartner, ['CardName'], ''),
    buyerProvince: buyerProvince || '',
    buyerAddress: String(buyerAddress || '').trim(),
    buyerRegistrationType,
    invoiceRefNo: pick(invoice, [f.refNoField || 'U_FBR_RefNo'], '') || '',
    items: [],
  };

  if (!payload.buyerBusinessName) errors.push('Buyer business name is empty.');
  if (!payload.buyerAddress) {
    errors.push('Buyer address is empty. FBR requires an address for the buyer.');
  }

  // A debit note must carry the original FBR invoice number.
  if (/debit/i.test(payload.invoiceType) && !payload.invoiceRefNo) {
    errors.push(
      `Invoice type is "${payload.invoiceType}", so invoiceRefNo (the original FBR invoice number) is mandatory. Populate ${
        f.refNoField || 'U_FBR_RefNo'
      } on the invoice.`
    );
  }

  // scenarioId is a sandbox-only requirement, so it is attached only there.
  if (config.fbr && config.fbr.environment === 'sandbox') {
    const scenarioId =
      pick(invoice, [f.scenarioField || 'U_FBR_ScenarioId'], null) || map.defaultScenarioId;
    if (!scenarioId) {
      errors.push(
        'Sandbox submissions require a scenarioId (e.g. SN001). Set a default under Settings -> Mapping, or populate the invoice UDF.'
      );
    } else {
      payload.scenarioId = scenarioId;
    }
  }

  // ------------------------------------------------------------------- items
  const lines = Array.isArray(invoice.DocumentLines) ? invoice.DocumentLines : [];
  if (lines.length === 0) errors.push('Invoice has no document lines.');

  lines.forEach((line, idx) => {
    const n = idx + 1;
    const itemCode = pick(line, ['ItemCode'], '');
    const itemMaster = items.get(itemCode) || null;
    const override = overrides[itemCode] || {};
    const label = itemCode || `line ${n}`;

    const description =
      pick(line, ['ItemDescription', 'Dscription', 'Text'], '') || itemCode || `Line ${n}`;

    const hsCode =
      override.hsCode ||
      pick(itemMaster, [f.itemHsCodeField || 'U_FBR_HSCode'], null) ||
      pick(line, [f.lineHsCodeField || 'U_FBR_HSCode'], null) ||
      map.defaultHsCode ||
      null;
    if (!hsCode) {
      errors.push(
        `Line ${n} (${label}): no HS code. Set ${
          f.itemHsCodeField || 'U_FBR_HSCode'
        } on the item master, or add an override under Settings -> Item overrides.`
      );
    }

    const uoM =
      override.uoM ||
      pick(itemMaster, [f.itemUomField || 'U_FBR_UOM'], null) ||
      mapUom(pick(line, ['MeasureUnit', 'UoMCode', 'UoMEntry'], null), map.uom) ||
      map.defaultUom ||
      null;
    if (!uoM) {
      errors.push(
        `Line ${n} (${label}): no FBR unit of measure. Set ${
          f.itemUomField || 'U_FBR_UOM'
        } on the item master, or add a UoM mapping.`
      );
    }

    const saleType =
      override.saleType ||
      pick(line, [f.lineSaleTypeField || 'U_FBR_SaleType'], null) ||
      pick(itemMaster, [f.itemSaleTypeField || 'U_FBR_SaleType'], null) ||
      map.defaultSaleType ||
      null;
    if (!saleType) {
      errors.push(`Line ${n} (${label}): no sale type. Set a default under Settings -> Mapping.`);
    }

    const net = lineNetAmount(line);
    const tax = lineTaxAmount(line, net);

    const ratePct = pick(line, ['TaxPercentagePerRow', 'VatPrcnt'], null);
    const rate =
      override.rate ||
      formatRate(ratePct, map) ||
      formatRate(net !== 0 ? (tax / net) * 100 : null, map) ||
      map.defaultRate ||
      null;
    if (!rate) {
      errors.push(`Line ${n} (${label}): sales tax rate could not be determined.`);
    }

    const furtherTax = Number(pick(line, [f.lineFurtherTaxField || 'U_FBR_FurtherTax'], 0)) || 0;
    const extraTax = Number(pick(line, [f.lineExtraTaxField || 'U_FBR_ExtraTax'], 0)) || 0;
    const fedPayable = Number(pick(line, [f.lineFedField || 'U_FBR_FED'], 0)) || 0;
    const stWithheld = Number(pick(line, [f.lineStWithheldField || 'U_FBR_STWithheld'], 0)) || 0;

    // SAP holds a discount percentage on the line; FBR wants the amount.
    const discountPct = Number(pick(line, ['DiscountPercent'], 0)) || 0;
    const discountAmount =
      discountPct && discountPct < 100
        ? round((net / (1 - discountPct / 100)) * (discountPct / 100), MONEY)
        : 0;

    const retailPrice = override.fixedNotifiedValueOrRetailPrice;
    payload.items.push({
      hsCode: hsCode || '',
      productDescription: String(description).slice(0, 250),
      rate: rate || '',
      uoM: uoM || '',
      quantity: round(pick(line, ['Quantity'], 0), QTY),
      totalValues: round(net + tax + furtherTax + extraTax + fedPayable, MONEY),
      valueSalesExcludingST: round(net, MONEY),
      fixedNotifiedValueOrRetailPrice: round(
        retailPrice !== undefined && retailPrice !== null
          ? retailPrice
          : pick(line, [f.lineRetailPriceField || 'U_FBR_RetailPrice'], 0),
        MONEY
      ),
      salesTaxApplicable: round(tax, MONEY),
      salesTaxWithheldAtSource: round(stWithheld, MONEY),
      extraTax: round(extraTax, MONEY),
      furtherTax: round(furtherTax, MONEY),
      sroScheduleNo:
        override.sroScheduleNo ||
        pick(line, [f.lineSroScheduleField || 'U_FBR_SROSchedule'], '') ||
        '',
      fedPayable: round(fedPayable, MONEY),
      discount: discountAmount,
      saleType: saleType || '',
      sroItemSerialNo:
        override.sroItemSerialNo || pick(line, [f.lineSroItemField || 'U_FBR_SROItem'], '') || '',
    });
  });

  // Sanity check against the SAP document total. A mismatch almost always means
  // the line tax amount was read from the wrong property for this B1 version.
  if (payload.items.length && invoice.DocTotal != null) {
    const computed = payload.items.reduce((s, i) => s + i.totalValues, 0);
    const docTotal = Number(invoice.DocTotal);
    if (Number.isFinite(docTotal) && Math.abs(computed - docTotal) > 1) {
      warnings.push(
        `Computed FBR total ${computed.toFixed(2)} differs from SAP DocTotal ${docTotal.toFixed(
          2
        )}. Verify the line tax field mapping before going live.`
      );
    }
  }

  return { payload: errors.length ? null : payload, errors, warnings };
}

function extractProvince(invoice, bp) {
  // Service Layer surfaces the ship-to/bill-to state in a few different places.
  const ext = invoice && invoice.AddressExtension;
  if (ext) {
    const fromInvoice = ext.ShipToState || ext.BillToState;
    if (fromInvoice) return fromInvoice;
  }
  if (bp && Array.isArray(bp.BPAddresses) && bp.BPAddresses.length) {
    const billTo = bp.BPAddresses.find((a) => a.AddressType === 'bo_BillTo') || bp.BPAddresses[0];
    return billTo.State || null;
  }
  return null;
}

/** FBR province names are a fixed list; accept common SAP state codes for them. */
const PROVINCE_ALIASES = {
  sd: 'Sindh',
  sindh: 'Sindh',
  pb: 'Punjab',
  punjab: 'Punjab',
  kp: 'Khyber Pakhtunkhwa',
  kpk: 'Khyber Pakhtunkhwa',
  'khyber pakhtunkhwa': 'Khyber Pakhtunkhwa',
  bl: 'Balochistan',
  balochistan: 'Balochistan',
  baluchistan: 'Balochistan',
  ict: 'Capital Territory',
  isb: 'Capital Territory',
  islamabad: 'Capital Territory',
  'capital territory': 'Capital Territory',
  gb: 'Gilgit Baltistan',
  'gilgit baltistan': 'Gilgit Baltistan',
  ajk: 'Azad Jammu and Kashmir',
  'azad jammu and kashmir': 'Azad Jammu and Kashmir',
};

function normaliseProvince(value, customMap) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const key = trimmed.toLowerCase();
  if (customMap) {
    if (customMap[trimmed]) return customMap[trimmed];
    if (customMap[key]) return customMap[key];
  }
  return PROVINCE_ALIASES[key] || null;
}

function mapUom(sapUom, uomMap) {
  if (!sapUom || !uomMap) return null;
  const trimmed = String(sapUom).trim();
  return uomMap[trimmed] || uomMap[trimmed.toLowerCase()] || null;
}

module.exports = {
  buildFbrPayload,
  toIsoDate,
  formatRate,
  normaliseProvince,
  PROVINCE_ALIASES,
  round,
};
