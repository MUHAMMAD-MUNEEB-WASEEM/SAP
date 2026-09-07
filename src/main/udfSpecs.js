'use strict';
/**
 * The user-defined fields this app reads and writes in SAP.
 *
 * Single source of truth for both the readiness check and the automatic
 * creation, so the two can never drift apart. `configKey` points at the entry
 * in config.sapFields, which means a site that renames a field in Settings gets
 * that name checked and created rather than the default.
 *
 * `location` is the path in the SAP B1 client's User-Defined Fields Management
 * tree, for anyone creating them by hand.
 *
 * Types follow the DI API enumerations that Service Layer accepts:
 *   db_Alpha (text, needs EditSize), db_Date, db_Float (amount, needs SubType).
 */

const UDF_SPECS = [
  // ---------------------------------------------- A/R Invoice header (OINV)
  {
    table: 'OINV',
    label: 'A/R Invoice',
    location: 'Marketing Documents → Title',
    configKey: 'irnField',
    name: 'FBR_IRN',
    description: 'FBR Invoice Number',
    type: 'db_Alpha',
    size: 40,
    required: true,
    purpose: 'FBR invoice number written back',
  },
  {
    table: 'OINV',
    configKey: 'statusField',
    name: 'FBR_Status',
    description: 'FBR Status',
    type: 'db_Alpha',
    size: 20,
    required: true,
    purpose: 'Valid / Invalid',
  },
  {
    table: 'OINV',
    configKey: 'dateField',
    name: 'FBR_Date',
    description: 'FBR Registration Date',
    type: 'db_Date',
    required: true,
    purpose: 'date FBR issued the number',
  },
  {
    table: 'OINV',
    configKey: 'messageField',
    name: 'FBR_Message',
    description: 'FBR Message',
    type: 'db_Alpha',
    size: 254,
    required: true,
    purpose: 'rejection reason',
  },
  {
    table: 'OINV',
    configKey: 'scenarioField',
    name: 'FBR_ScenarioId',
    description: 'FBR Scenario ID',
    type: 'db_Alpha',
    size: 10,
    required: false,
    purpose: 'per-invoice sandbox scenario',
  },
  {
    table: 'OINV',
    configKey: 'invoiceTypeField',
    name: 'FBR_InvoiceType',
    description: 'FBR Invoice Type',
    type: 'db_Alpha',
    size: 30,
    required: false,
    purpose: 'Sale Invoice / Debit Note',
  },
  {
    table: 'OINV',
    configKey: 'refNoField',
    name: 'FBR_RefNo',
    description: 'FBR Reference Invoice No',
    type: 'db_Alpha',
    size: 40,
    required: false,
    purpose: 'original FBR number (debit notes)',
  },

  // ------------------------------------------------- Business Partner (OCRD)
  {
    table: 'OCRD',
    label: 'Business Partner',
    location: 'Master Data → Business Partners → Title',
    configKey: 'bpProvinceField',
    name: 'FBR_Province',
    description: 'FBR Province',
    type: 'db_Alpha',
    size: 30,
    required: false,
    purpose: 'buyer province',
  },
  {
    table: 'OCRD',
    configKey: 'bpRegTypeField',
    name: 'FBR_RegType',
    description: 'FBR Registration Type',
    type: 'db_Alpha',
    size: 15,
    required: false,
    purpose: 'Registered / Unregistered',
  },
  {
    table: 'OCRD',
    configKey: 'bpNtnField',
    name: 'FBR_NTN',
    description: 'FBR Buyer NTN or CNIC',
    type: 'db_Alpha',
    size: 20,
    required: false,
    purpose: 'buyer NTN/CNIC (defaults to the standard Federal Tax ID)',
  },

  // ------------------------------------------------------ Item master (OITM)
  {
    table: 'OITM',
    label: 'Item master',
    location: 'Master Data → Items → Title',
    configKey: 'itemHsCodeField',
    name: 'FBR_HSCode',
    description: 'FBR HS Code',
    type: 'db_Alpha',
    size: 15,
    required: true,
    purpose: 'HS code',
  },
  {
    table: 'OITM',
    configKey: 'itemUomField',
    name: 'FBR_UOM',
    description: 'FBR Unit of Measure',
    type: 'db_Alpha',
    size: 50,
    required: true,
    purpose: 'FBR unit of measure',
  },
  {
    table: 'OITM',
    configKey: 'itemSaleTypeField',
    name: 'FBR_SaleType',
    description: 'FBR Sale Type',
    type: 'db_Alpha',
    size: 60,
    required: false,
    purpose: 'sale type',
  },

  // ------------------------------------------- Invoice rows (INV1), optional
  // Only needed for further/extra tax, FED in ST mode, withholding or SRO rates.
  {
    table: 'INV1',
    label: 'A/R Invoice rows',
    location: 'Marketing Documents → Rows',
    configKey: 'lineFurtherTaxField',
    name: 'FBR_FurtherTax',
    description: 'FBR Further Tax',
    type: 'db_Float',
    subType: 'st_Sum',
    required: false,
    purpose: 'further tax amount',
  },
  {
    table: 'INV1',
    configKey: 'lineExtraTaxField',
    name: 'FBR_ExtraTax',
    description: 'FBR Extra Tax',
    type: 'db_Float',
    subType: 'st_Sum',
    required: false,
    purpose: 'extra tax amount',
  },
  {
    table: 'INV1',
    configKey: 'lineFedField',
    name: 'FBR_FED',
    description: 'FBR FED Payable',
    type: 'db_Float',
    subType: 'st_Sum',
    required: false,
    purpose: 'federal excise duty',
  },
  {
    table: 'INV1',
    configKey: 'lineStWithheldField',
    name: 'FBR_STWithheld',
    description: 'FBR ST Withheld at Source',
    type: 'db_Float',
    subType: 'st_Sum',
    required: false,
    purpose: 'sales tax withheld',
  },
  {
    table: 'INV1',
    configKey: 'lineRetailPriceField',
    name: 'FBR_RetailPrice',
    description: 'FBR Retail Price',
    type: 'db_Float',
    subType: 'st_Price',
    required: false,
    purpose: 'fixed notified / retail price',
  },
  {
    table: 'INV1',
    configKey: 'lineSroScheduleField',
    name: 'FBR_SROSchedule',
    description: 'FBR SRO Schedule No',
    type: 'db_Alpha',
    size: 30,
    required: false,
    purpose: 'SRO schedule number',
  },
  {
    table: 'INV1',
    configKey: 'lineSroItemField',
    name: 'FBR_SROItem',
    description: 'FBR SRO Item Serial No',
    type: 'db_Alpha',
    size: 30,
    required: false,
    purpose: 'SRO item serial number',
  },
];

/** Table order and display labels, derived from the first spec for each table. */
function tableGroups() {
  const groups = [];
  for (const spec of UDF_SPECS) {
    let g = groups.find((x) => x.table === spec.table);
    if (!g) {
      g = { table: spec.table, label: spec.label || spec.table, location: spec.location || '', specs: [] };
      groups.push(g);
    }
    if (spec.label) g.label = spec.label;
    if (spec.location) g.location = spec.location;
    g.specs.push(spec);
  }
  return groups;
}

module.exports = { UDF_SPECS, tableGroups };
