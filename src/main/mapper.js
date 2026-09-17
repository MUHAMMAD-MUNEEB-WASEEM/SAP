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

/**
 * Pull an HS code out of a field that may hold free text.
 *
 * Sites commonly keep the code in a general-purpose field such as the item
 * master's Remarks (OITM.UserText, exposed as User_Text), where it sits alongside other notes:
 * "HS Code: 4819.1000", "4819.1000 - 5 ply", or just the bare digits. FBR wants
 * the canonical nnnn.nnnn form, so the code is located and normalised rather
 * than the whole field being sent.
 *
 * Returns null when no code can be found, which the caller reports as a
 * mapping error - guessing from partial digits would risk misclassifying goods
 * on a government filing.
 */
function extractHsCode(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Canonical form, e.g. 4819.1000
  const full = s.match(/(?<!\d)(\d{4})\.(\d{4})(?!\d)/);
  if (full) return `${full[1]}.${full[2]}`;

  // Eight bare digits, e.g. 48191000
  const bare = s.match(/(?<!\d)(\d{8})(?!\d)/);
  if (bare) return `${bare[1].slice(0, 4)}.${bare[1].slice(4)}`;

  // Six-digit heading, e.g. 4819.10 - passed through as found rather than
  // padded, since inventing the last two digits would change the classification.
  const short = s.match(/(?<!\d)(\d{4})\.(\d{2})(?!\d)/);
  if (short) return `${short[1]}.${short[2]}`;

  return null;
}

/**
 * SAP unit codes that mean the same thing as an FBR unit.
 *
 * Values on the right are matched against FBR's published list rather than
 * being sent as-is, so a synonym can only ever resolve to a unit FBR actually
 * recognises. Anything unmatched is left for the user rather than guessed.
 */
const UOM_SYNONYMS = {
  // counted goods - cartons, boxes and the like are sold by the piece
  pcs: 'numbers, pieces, units',
  pc: 'numbers, pieces, units',
  pce: 'numbers, pieces, units',
  piece: 'numbers, pieces, units',
  pieces: 'numbers, pieces, units',
  ea: 'numbers, pieces, units',
  each: 'numbers, pieces, units',
  no: 'numbers, pieces, units',
  nos: 'numbers, pieces, units',
  num: 'numbers, pieces, units',
  number: 'numbers, pieces, units',
  numbers: 'numbers, pieces, units',
  unit: 'numbers, pieces, units',
  units: 'numbers, pieces, units',
  ctn: 'numbers, pieces, units',
  carton: 'numbers, pieces, units',
  cartons: 'numbers, pieces, units',
  box: 'numbers, pieces, units',
  bag: 'numbers, pieces, units',
  set: 'numbers, pieces, units',
  // weight
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  g: 'gram',
  gm: 'gram',
  gram: 'gram',
  grams: 'gram',
  ton: 'ton',
  tons: 'ton',
  tonne: 'ton',
  mt: 'ton',
  // volume and length
  l: 'litre',
  ltr: 'litre',
  lit: 'litre',
  litre: 'litre',
  liter: 'litre',
  litres: 'litre',
  m: 'meter',
  mtr: 'meter',
  meter: 'meter',
  metre: 'meter',
  meters: 'meter',
  sqm: 'square metre',
  m2: 'square metre',
  sqft: 'square foot',
  ft2: 'square foot',
  sft: 'square foot',
  cbm: 'cubic metre',
  m3: 'cubic metre',
  // energy
  kwh: 'kwh',
};

const normaliseUomKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Propose an FBR unit for a SAP unit code, choosing only from FBR's own list.
 *
 * @param {string} sapUom            e.g. "PCS"
 * @param {Array<{description:string}>} fbrList  from /pdi/v1/uom
 * @param {object} [customMap]       site overrides, SAP code -> FBR description
 * @returns {{value:string, reason:string}|null}
 */
function matchUom(sapUom, fbrList, customMap) {
  const raw = String(sapUom || '').trim();
  if (!raw) return null;

  const options = (Array.isArray(fbrList) ? fbrList : [])
    .map((u) => (typeof u === 'string' ? u : u.description || u.uoM || u.uom || ''))
    .filter(Boolean);
  if (!options.length) return null;

  // 1. An explicit site mapping always wins.
  if (customMap) {
    const custom = customMap[raw] || customMap[raw.toLowerCase()];
    if (custom) {
      const exact = options.find((o) => o.toLowerCase() === String(custom).toLowerCase());
      return { value: exact || custom, reason: 'configured mapping' };
    }
  }

  const key = normaliseUomKey(raw);

  // 2. The SAP code already names an FBR unit.
  const direct = options.find((o) => normaliseUomKey(o) === key);
  if (direct) return { value: direct, reason: 'exact match' };

  // 3. A known synonym, resolved against the real list.
  const synonym = UOM_SYNONYMS[key];
  if (synonym) {
    const hit =
      options.find((o) => o.toLowerCase() === synonym) ||
      options.find((o) => normaliseUomKey(o) === normaliseUomKey(synonym));
    if (hit) return { value: hit, reason: `"${raw}" recognised as ${hit}` };
  }

  // 4. The FBR description starts with the SAP code, e.g. "KG" -> "KG".
  const prefix = options.find((o) => normaliseUomKey(o).startsWith(key) && key.length >= 2);
  if (prefix) return { value: prefix, reason: 'partial match — check this one' };

  return null;
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

  let buyerAddress = resolveBuyerAddress(invoice, businessPartner);
  if (!buyerAddress && map.defaultBuyerAddress) {
    buyerAddress = map.defaultBuyerAddress;
    warnings.push(
      `Buyer address could not be read from the invoice or the business partner; used the configured fallback "${map.defaultBuyerAddress}".`
    );
  }

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

  // Missing master data is collected per ITEM rather than per line. An invoice
  // with ten lines of the same unmapped product is one thing to fix, not ten,
  // and reporting it per line obscures that the fix lives on the item master.
  const missingHsCode = new Map();
  const unreadableHsCode = new Map();
  const remarksSourced = new Set();
  const missingUom = new Map();
  const missingSaleType = new Map();
  const noteMissing = (bucket, key, lineNo) => {
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(lineNo);
  };

  lines.forEach((line, idx) => {
    const n = idx + 1;
    const itemCode = pick(line, ['ItemCode'], '');
    const itemMaster = items.get(itemCode) || null;
    const override = overrides[itemCode] || {};
    const label = itemCode || `line ${n}`;

    const description =
      pick(line, ['ItemDescription', 'Dscription', 'Text'], '') || itemCode || `Line ${n}`;

    // Each candidate source is tried in turn and the first that actually yields
    // a code wins. Falling THROUGH matters: a dedicated field holding a note
    // rather than a code should not stop the Remarks field being consulted.
    const hsCandidates = [
      [override.hsCode, 'item override'],
      [pick(itemMaster, [f.itemHsCodeField || 'U_FBR_HSCode'], null), f.itemHsCodeField || 'U_FBR_HSCode'],
      [pick(line, [f.lineHsCodeField || 'U_FBR_HSCode'], null), 'the invoice line'],
      // Many sites keep the code in the item master's Remarks (OITM.UserText, exposed as User_Text)
      // rather than a dedicated field, so it is consulted without configuration.
      [pick(itemMaster, ['User_Text', 'UserText', 'Remarks'], null), 'the item Remarks'],
      // B1's own home for a commodity code, if this site populates it.
      [
        itemMaster && itemMaster.ItemIntrastatExtension
          ? itemMaster.ItemIntrastatExtension.CommodityCode
          : null,
        'the item Intrastat commodity code',
      ],
    ];

    // Last resort before the blanket default: look across the item master's
    // text-bearing fields for something shaped like an HS code. Only fields
    // whose NAME plausibly holds one are considered, so an item code or a
    // quantity can never be mistaken for a tariff classification.
    const scanned = hsCandidates.some(([raw]) => raw) ? null : scanForHsCode(itemMaster);
    if (scanned) hsCandidates.push([scanned.raw, `the item field ${scanned.field}`]);
    hsCandidates.push([map.defaultHsCode, 'the configured default']);

    let hsCode = null;
    let hsFoundIn = null;
    let hsUnparsed = null;
    for (const [raw, source] of hsCandidates) {
      if (!raw) continue;
      const parsed =
        map.extractHsFromText === false ? String(raw).trim() : extractHsCode(raw);
      if (parsed) {
        hsCode = parsed;
        hsFoundIn = source;
        break;
      }
      if (!hsUnparsed) hsUnparsed = { raw, source };
    }

    if (hsCode) {
      // Anything other than a dedicated field is worth surfacing: the user
      // should know which field their filings actually depend on.
      if (hsFoundIn === 'the item Remarks' || String(hsFoundIn).startsWith('the item field')) {
        remarksSourced.add(`${label} (from ${hsFoundIn})`);
      }
    } else if (hsUnparsed) {
      noteMissing(
        unreadableHsCode,
        `${label} → ${hsUnparsed.source} holds "${truncateText(hsUnparsed.raw, 40)}"`,
        n
      );
    } else {
      noteMissing(missingHsCode, label, n);
    }

    // SAP's own unit is consulted through the site mapping table only - it is
    // a local code like "PCS", never an FBR unit, so it is never sent raw.
    const sapUnit = pick(
      line,
      ['MeasureUnit', 'UoMCode', 'UoMEntry'],
      pick(itemMaster, ['SalesUnit', 'InventoryUOM'], null)
    );
    const uoM =
      override.uoM ||
      pick(itemMaster, [f.itemUomField || 'U_FBR_UOM'], null) ||
      mapUom(sapUnit, map.uom) ||
      map.defaultUom ||
      null;
    if (!uoM) noteMissing(missingUom, label, n);

    const saleType =
      override.saleType ||
      pick(line, [f.lineSaleTypeField || 'U_FBR_SaleType'], null) ||
      pick(itemMaster, [f.itemSaleTypeField || 'U_FBR_SaleType'], null) ||
      map.defaultSaleType ||
      null;
    if (!saleType) noteMissing(missingSaleType, label, n);

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

  if (missingHsCode.size) {
    errors.push(
      `${missingHsCode.size} item(s) have no HS code: ${describeMissing(missingHsCode)}. Set ${
        f.itemHsCodeField || 'U_FBR_HSCode'
      } on the item master — once per product, not per invoice. Use the Item mapping tab.`
    );
  }
  if (remarksSourced.size) {
    warnings.push(
      `${remarksSourced.size} item(s) took their HS code from a general-purpose field rather than a dedicated one: ${[
        ...remarksSourced,
      ]
        .slice(0, 8)
        .join('; ')}${
        remarksSourced.size > 8 ? ` and ${remarksSourced.size - 8} more` : ''
      }. That works, but a dedicated field is harder to disturb by accident.`
    );
  }
  if (unreadableHsCode.size) {
    errors.push(
      `${unreadableHsCode.size} item(s) have text where an HS code should be, but no code could be read from it: ${describeMissing(
        unreadableHsCode
      )}. An HS code looks like 4819.1000. Checked ${
        f.itemHsCodeField || 'U_FBR_HSCode'
      } and the item master's Remarks.`
    );
  }
  if (missingUom.size) {
    errors.push(
      `${missingUom.size} item(s) have no FBR unit of measure: ${describeMissing(missingUom)}. Set ${
        f.itemUomField || 'U_FBR_UOM'
      } on the item master — once per product, not per invoice. Use the Item mapping tab.`
    );
  }
  if (missingSaleType.size) {
    errors.push(
      `${missingSaleType.size} item(s) have no sale type: ${describeMissing(
        missingSaleType
      )}. Set a default under Settings -> Mapping, or ${
        f.itemSaleTypeField || 'U_FBR_SaleType'
      } on the item master.`
    );
  }

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

/**
 * Render a bucket of missing master data as "CODE (lines 1, 4)", listing at
 * most a handful of item codes so one bad import does not produce an
 * unreadable wall of text.
 */
/**
 * Search an item master record for a value shaped like an HS code.
 *
 * A deliberate last resort for sites that keep the code in a field nobody
 * documented. Only fields whose NAME plausibly holds one are considered, so an
 * item code, a quantity or a price can never be mistaken for a tariff
 * classification - and the caller reports which field it came from, so the
 * guess is never silent.
 */
const HS_BEARING_FIELD = /^u_|user|remark|note|text|comment|hs|tariff|customs|code/i;

function scanForHsCode(itemMaster) {
  if (!itemMaster || typeof itemMaster !== 'object') return null;
  for (const [field, value] of Object.entries(itemMaster)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (field === 'ItemCode' || field === 'ItemName') continue;
    if (!HS_BEARING_FIELD.test(field)) continue;
    const code = extractHsCode(value);
    if (code) return { code, field, raw: value };
  }
  return null;
}

function truncateText(value, max) {
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function describeMissing(bucket, limit = 8) {
  const entries = [...bucket.entries()];
  const shown = entries
    .slice(0, limit)
    .map(([code, lineNos]) => `${code} (line${lineNos.length > 1 ? 's' : ''} ${lineNos.join(', ')})`)
    .join(', ');
  const rest = entries.length - limit;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Flatten a SAP address block to a single clean line.
 *
 * B1 stores document addresses with embedded carriage returns, and often bare
 * CR without LF - real data looks like
 * "DOCKYARD ROAD WEST WHARF KARACHI PAKISTAN\r\r \rPAKISTAN". Sending those
 * control characters to FBR is not acceptable, so every line-break run becomes
 * a separator and the repeats are collapsed.
 */
function cleanAddress(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\r\n]+/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*)+/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

/** Join address parts, dropping the empty ones. */
function composeAddress(parts) {
  return cleanAddress(
    parts
      .filter((p) => p !== undefined && p !== null && String(p).trim() !== '')
      .map((p) => String(p).trim())
      .join(', ')
  );
}

/**
 * Find the buyer's address.
 *
 * FBR requires one, and Service Layer holds it in several different shapes
 * depending on how the document was created: a pre-formatted block on the
 * document, discrete bill-to fields in AddressExtension, or only on the
 * business partner's address collection. An empty `Address` property on the
 * invoice does not mean the address is absent from SAP - it usually just means
 * it lives in one of the other two places.
 */
function resolveBuyerAddress(invoice, bp) {
  const documentAddress = cleanAddress(invoice.Address);
  if (documentAddress) return documentAddress;

  const ext = invoice.AddressExtension;
  if (ext) {
    const billTo = composeAddress([
      ext.BillToStreet,
      ext.BillToBlock,
      ext.BillToCity,
      ext.BillToState,
      ext.BillToZipCode,
    ]);
    if (billTo) return billTo;

    const shipTo = composeAddress([
      ext.ShipToStreet,
      ext.ShipToBlock,
      ext.ShipToCity,
      ext.ShipToState,
      ext.ShipToZipCode,
    ]);
    if (shipTo) return shipTo;
  }

  if (bp) {
    const bpAddress = cleanAddress(bp.Address);
    if (bpAddress) return bpAddress;

    if (Array.isArray(bp.BPAddresses) && bp.BPAddresses.length) {
      const billTo =
        bp.BPAddresses.find((a) => a.AddressType === 'bo_BillTo') || bp.BPAddresses[0];
      const composed = composeAddress([
        billTo.Street,
        billTo.Block,
        billTo.City,
        billTo.State,
        billTo.ZipCode,
      ]);
      if (composed) return composed;
    }

    const mail = cleanAddress(bp.MailAddress);
    if (mail) return mail;
  }

  return '';
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
  extractHsCode,
  matchUom,
  UOM_SYNONYMS,
  toIsoDate,
  formatRate,
  normaliseProvince,
  PROVINCE_ALIASES,
  round,
};
