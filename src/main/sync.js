'use strict';
/**
 * Orchestrates: SAP invoice -> FBR payload -> FBR registration -> IRN back into SAP.
 *
 * Ordering here is deliberate and safety-critical. FBR registration cannot be
 * undone and is not idempotent, so a re-post risks a duplicate government
 * filing. Every submission therefore follows:
 *
 *   1. re-read the invoice from SAP and abort if an IRN is already present
 *   2. write a "sending" record to the local audit log
 *   3. POST to FBR
 *   4. write the outcome to the local log BEFORE touching SAP
 *   5. PATCH the IRN onto the SAP invoice; if that fails the log still holds
 *      the IRN and the invoice is surfaced as needing write-back repair
 */
const { SapClient } = require('./sapClient');
const { FbrClient } = require('./fbrClient');
const { buildFbrPayload, extractHsCode, normaliseProvince } = require('./mapper');
const { tableGroups } = require('./udfSpecs');

class SyncService {
  constructor({ configStore, store, log }) {
    this.configStore = configStore;
    this.store = store;
    this.log = log || (() => {});
    this.sap = null;
    this.fbr = null;
  }

  config() {
    return this.configStore.config;
  }

  sapClient() {
    const cfg = this.config().sap;
    if (!this.sap || this.sapKey !== JSON.stringify(cfg)) {
      this.sapKey = JSON.stringify(cfg);
      this.sap = new SapClient(cfg);
    }
    return this.sap;
  }

  fbrClient() {
    const cfg = this.config().fbr;
    return new FbrClient({
      environment: cfg.environment,
      token: this.configStore.activeFbrToken(),
      timeoutMs: cfg.timeoutMs,
    });
  }

  // ------------------------------------------------------------ connections

  async testSap() {
    const info = await this.sapClient().login();
    return { ok: true, ...info };
  }

  /**
   * Work out WHY a SAP login is failing, without risking an account lockout.
   *
   * Service Layer delegates login to the SLD, which both resolves the company
   * database and validates the user. A failure could be either link, and the
   * relayed message rarely says which. So we send two logins built entirely
   * from non-existent credentials and compare how Service Layer reacts:
   *
   *   probe A: the CONFIGURED company + a user that cannot exist
   *   probe B: a company that cannot exist + a user that cannot exist
   *
   * Same error for both  -> the configured company is being rejected exactly
   *                         like a non-existent one, so CompanyDB (or its SLD
   *                         registration) is the problem.
   * Different errors      -> the company resolved fine and the login got as far
   *                         as user validation, so it is the user or password.
   *
   * Neither probe uses a real account name, so no real account can be locked.
   */
  async diagnoseSap() {
    const cfg = this.config().sap;
    const client = this.sapClient();
    const findings = [];
    const nonce = Date.now().toString(36);
    const fakeUser = `zz_probe_${nonce}`;
    const fakeCompany = `ZZ_NO_SUCH_DB_${nonce}`;
    const fakePassword = `zz_${nonce}_zz`;

    if (!cfg.baseUrl) {
      return { reachable: false, findings: ['No SAP base URL configured.'], probes: {} };
    }

    const probeA = await client.probeLogin({
      companyDB: cfg.companyDB,
      username: fakeUser,
      password: fakePassword,
    });

    if (!probeA.reachable) {
      return {
        reachable: false,
        probes: { configuredCompany: probeA },
        findings: [
          `Service Layer at ${cfg.baseUrl} did not respond: ${probeA.message}`,
          'Nothing else can be tested until the endpoint is reachable. Check the host, port, protocol (http vs https) and any firewall or VPN between this machine and the server.',
        ],
      };
    }

    const probeB = await client.probeLogin({
      companyDB: fakeCompany,
      username: fakeUser,
      password: fakePassword,
    });

    findings.push(
      `Service Layer at ${cfg.baseUrl} is reachable and responding — the URL, port and protocol are correct.`
    );

    const sameAsNonexistent =
      String(probeA.code) === String(probeB.code) && probeA.status === probeB.status;

    if (sameAsNonexistent) {
      findings.push(
        `Company database "${cfg.companyDB}" is rejected with exactly the same error as a database that does not exist (${probeA.code}). Service Layer is not resolving it.`,
        'Check, in this order:',
        '  1. The exact database/schema name — it is case-sensitive, and it is the DB name, not the company display name shown in the B1 client.',
        '  2. That the database is registered in the SLD: open https://<server>:40000/ControlCenter and confirm it is listed under the database server.',
        '  3. That the SLD can still reach the database server. If the DB account it stores (HANA SYSTEM, or the SQL Server login) had its password changed or expired, every company fails this way.'
      );
    } else {
      findings.push(
        `Company database "${cfg.companyDB}" is accepted — it produces a different error (${probeA.code}) than a non-existent database (${probeB.code}), so the login is getting as far as validating the user.`,
        'That points at the user rather than the company. Check:',
        '  1. The user name is the B1 user CODE (as in the B1 client user list), not an email or a Windows/SQL account.',
        '  2. The password is correct, and the account is neither locked nor expired.',
        '  3. The user has a licence assigned that permits Service Layer / DI API access.'
      );
    }

    return {
      reachable: true,
      sameAsNonexistent,
      companyDB: cfg.companyDB,
      baseUrl: cfg.baseUrl,
      probes: { configuredCompany: probeA, nonexistentCompany: probeB },
      findings,
    };
  }

  /**
   * Propose the seller block from SAP's own company information, so the
   * details FBR requires do not have to be retyped. Returns a suggestion for
   * the user to confirm rather than saving anything - what FBR holds must match
   * the registration, which only the user can vouch for.
   */
  async suggestSeller() {
    const info = await this.sapClient().getCompany();
    const address = composeCompanyAddress(info);
    return {
      ntnCnic: String(info.FederalTaxID || info.TaxIdNum || info.AdditionalID || '')
        .replace(/[^0-9]/g, ''),
      businessName: info.CompanyName || '',
      province: normaliseProvince(info.State || info.County || '', this.config().mapping.provinces) || '',
      address,
      raw: info,
    };
  }

  /**
   * Verify the FBR token by calling a harmless reference endpoint. A 401 here
   * means a bad or wrong-environment token; anything else means the token works.
   */
  async testFbr() {
    const client = this.fbrClient();
    const provinces = await client.getProvinces();
    return {
      ok: true,
      environment: client.environment,
      provinceCount: Array.isArray(provinces) ? provinces.length : 0,
    };
  }

  /**
   * Confirm the user-defined fields this app reads and writes actually exist in
   * SAP. Worth checking up front: the invoice query selects the IRN and status
   * UDFs by name, so a missing field fails the whole listing with an OData
   * error that says nothing about which one is absent.
   */
  async checkSetup() {
    const f = this.config().sapFields;
    const report = [];
    let missingRequired = 0;
    let missingTotal = 0;

    for (const group of tableGroups()) {
      let present;
      try {
        const udfs = await this.sapClient().getUserFields(group.table);
        present = new Set(udfs.map((u) => String(u.Name).toUpperCase()));
      } catch (err) {
        report.push({ ...group, error: err.message, fields: [] });
        continue;
      }

      const fields = group.specs
        .map((spec) => {
          // A site may rename a field in Settings; check what is configured,
          // falling back to the spec default.
          const configured = f[spec.configKey] || `U_${spec.name}`;

          // Standard (non-UDF) fields such as FederalTaxID always exist.
          if (!/^U_/i.test(configured)) {
            return { field: configured, spec, required: spec.required, purpose: spec.purpose, status: 'standard' };
          }

          const bare = configured.replace(/^U_/i, '');
          const exists = present.has(bare.toUpperCase());
          if (!exists) {
            missingTotal++;
            if (spec.required) missingRequired++;
          }
          return {
            field: configured,
            bare,
            spec,
            required: spec.required,
            purpose: spec.purpose,
            status: exists ? 'present' : 'missing',
          };
        })
        .filter(Boolean);

      report.push({ table: group.table, label: group.label, location: group.location, fields });
    }

    return { ready: missingRequired === 0, missingRequired, missingTotal, report };
  }

  /**
   * Create every user-defined field the check reported as missing.
   *
   * This alters the company database schema, so the caller is responsible for
   * getting the user's explicit confirmation first. Each field is created
   * individually and failures are collected rather than thrown, so one rejected
   * field does not abandon the rest.
   */
  async createMissingUdfs() {
    const check = await this.checkSetup();
    const results = [];

    for (const group of check.report) {
      for (const field of group.fields) {
        if (field.status !== 'missing') continue;
        const { spec } = field;
        try {
          await this.sapClient().createUserField({
            tableName: group.table,
            name: field.bare,
            description: spec.description,
            type: spec.type,
            subType: spec.subType,
            size: spec.size,
          });
          this.log(`Created UDF ${group.table}.U_${field.bare}`);
          results.push({ table: group.table, field: field.field, ok: true });
        } catch (err) {
          this.log(`Failed to create UDF ${group.table}.U_${field.bare}: ${err.message}`);
          results.push({ table: group.table, field: field.field, ok: false, error: err.message });
        }
      }
    }

    const created = results.filter((r) => r.ok).length;
    return {
      attempted: results.length,
      created,
      failed: results.length - created,
      results,
    };
  }

  // -------------------------------------------------------- item mapping

  /** Item master rows for the FBR mapping editor. */
  async listItemsForMapping({ missingOnly = true, skip = 0, pageSize = 200 } = {}) {
    const f = this.config().sapFields;
    const base = {
      hsField: f.itemHsCodeField,
      uomField: f.itemUomField,
      saleTypeField: f.itemSaleTypeField,
      missingOnly,
      skip,
      pageSize,
    };

    // SAP's own inventory / sales unit gives the FBR unit matcher something to
    // work from. They are standard fields, but a $select naming one that does
    // not exist fails the whole query - so fall back to the plain select rather
    // than leaving the user with an opaque OData error.
    let rows;
    try {
      rows = await this.sapClient().listItems({
        ...base,
        extraFields: ['InventoryUOM', 'SalesUnit', 'User_Text'],
      });
    } catch (err) {
      this.log(`Item list without SAP unit columns (${err.message})`);
      rows = await this.sapClient().listItems(base);
    }
    const extract = this.config().mapping.extractHsFromText !== false;
    return rows.map((r) => {
      // Same fall-through the mapper uses: the configured field, then Remarks.
      const configured = r[f.itemHsCodeField] || '';
      const fromConfigured = extract ? extractHsCode(configured) : String(configured).trim();
      const remarks = r.User_Text || '';
      const fromRemarks = extract ? extractHsCode(remarks) : '';
      const parsed = fromConfigured || fromRemarks;
      const rawHs = fromConfigured ? configured : fromRemarks ? remarks : configured || remarks;
      return {
        itemCode: r.ItemCode,
        itemName: r.ItemName,
        hsCode: parsed || '',
        // Kept so the grid can show what the source field actually holds when
        // it is free text - the user needs to see extraction working.
        hsSource: rawHs && parsed !== rawHs ? rawHs : '',
        hsUnreadable: !!rawHs && !parsed,
        uoM: r[f.itemUomField] || '',
        sapUom: r.SalesUnit || r.InventoryUOM || '',
        saleType: (f.itemSaleTypeField && r[f.itemSaleTypeField]) || '',
      };
    });
  }

  /**
   * Write FBR mapping values back onto the item master.
   *
   * Only the fields actually supplied are sent, so a blank column in an
   * imported CSV leaves the existing SAP value alone rather than wiping it.
   * Each item is patched individually and failures are collected, so one bad
   * item code does not abandon the rest of the batch.
   */
  async saveItemMappings(rows) {
    const f = this.config().sapFields;
    const results = [];

    // Only user-defined fields are ever written. If HS codes are being READ
    // from a standard field such as the Remarks text (UserText), writing back
    // to it would replace whatever else that field holds - so those columns are
    // read-only and the user is told rather than silently losing data.
    const readOnly = [];
    const writable = (fieldName, label) => {
      if (!fieldName) return false;
      if (/^U_/i.test(fieldName)) return true;
      if (!readOnly.includes(label)) readOnly.push(`${label} (${fieldName})`);
      return false;
    };

    for (const row of rows || []) {
      if (!row || !row.itemCode) continue;
      const fields = {};
      if (row.hsCode !== undefined && row.hsCode !== '' && writable(f.itemHsCodeField, 'HS code')) {
        fields[f.itemHsCodeField] = row.hsCode;
      }
      if (row.uoM !== undefined && row.uoM !== '' && writable(f.itemUomField, 'unit of measure')) {
        fields[f.itemUomField] = row.uoM;
      }
      if (row.saleType !== undefined && row.saleType !== '' && writable(f.itemSaleTypeField, 'sale type')) {
        fields[f.itemSaleTypeField] = row.saleType;
      }
      if (!Object.keys(fields).length) continue;

      try {
        await this.sapClient().patchItem(row.itemCode, fields);
        results.push({ itemCode: row.itemCode, ok: true });
      } catch (err) {
        results.push({ itemCode: row.itemCode, ok: false, error: err.message });
      }
    }

    const saved = results.filter((r) => r.ok).length;
    this.log(`Item mapping save: ${saved} updated, ${results.length - saved} failed.`);
    if (readOnly.length) {
      this.log(`Skipped read-only standard field(s): ${readOnly.join(', ')}`);
    }
    return {
      attempted: results.length,
      saved,
      failed: results.length - saved,
      readOnly,
      results,
    };
  }

  /**
   * Item codes appearing on invoices in range that still lack FBR mapping data.
   * Lets the user fix exactly what is blocking the invoices they care about,
   * rather than working through the whole item master.
   */
  async itemsBlockingInvoices({ fromDate, toDate } = {}) {
    const f = this.config().sapFields;
    const sap = this.sapClient();
    const { invoices } = await this.listPending({ fromDate, toDate });

    const needed = new Map();
    for (const inv of invoices) {
      const full = await sap.getInvoice(inv.docEntry);
      for (const line of full.DocumentLines || []) {
        if (!line.ItemCode || needed.has(line.ItemCode)) continue;
        needed.set(line.ItemCode, { itemCode: line.ItemCode, docNums: [] });
      }
      for (const line of full.DocumentLines || []) {
        const entry = needed.get(line.ItemCode);
        if (entry && !entry.docNums.includes(inv.docNum)) entry.docNums.push(inv.docNum);
      }
    }

    const out = [];
    for (const entry of needed.values()) {
      try {
        const item = await sap.getItem(entry.itemCode);
        const extract = this.config().mapping.extractHsFromText !== false;
        const configured = item[f.itemHsCodeField] || '';
        const remarks = item.User_Text || '';
        const uoM = item[f.itemUomField] || '';
        // Judge readiness on the EXTRACTED code, from either source: a Remarks
        // field full of text with no code in it is not a mapped item.
        const parsedHs = extract
          ? extractHsCode(configured) || extractHsCode(remarks)
          : String(configured).trim();
        const hsCode = extract && !extractHsCode(configured) && parsedHs ? remarks : configured;
        if (parsedHs && uoM) continue; // already mapped
        out.push({
          itemCode: entry.itemCode,
          itemName: item.ItemName || '',
          hsCode: parsedHs || '',
          hsSource: hsCode && parsedHs !== hsCode ? hsCode : '',
          hsUnreadable: !!hsCode && !parsedHs,
          uoM,
          sapUom: item.SalesUnit || item.InventoryUOM || '',
          saleType: (f.itemSaleTypeField && item[f.itemSaleTypeField]) || '',
          usedOn: entry.docNums,
        });
      } catch (err) {
        out.push({ itemCode: entry.itemCode, itemName: '', hsCode: '', uoM: '', saleType: '', error: err.message, usedOn: entry.docNums });
      }
    }
    return out;
  }

  // -------------------------------------------------------------- listing

  async listPending({ fromDate, toDate, includeRegistered = false } = {}) {
    const cfg = this.config();
    const f = cfg.sapFields;
    let rows;
    let truncated = false;
    try {
      const page = await this.sapClient().listInvoices({
        statusField: f.statusField,
        irnField: f.irnField,
        fromDate: fromDate || defaultFromDate(cfg.sync.lookbackDays),
        toDate,
        pageSize: cfg.sync.pageSize,
        maxResults: cfg.sync.maxResults,
        includeRegistered,
      });
      rows = page.rows;
      truncated = page.truncated;
      this.log(
        `Loaded ${rows.length} invoice(s)${truncated ? ` (capped at ${cfg.sync.maxResults})` : ''}.`
      );
    } catch (err) {
      // By far the most common cause: the UDFs have not been created, or the
      // Service Layer has not been restarted since they were.
      if (/does not exist|invalid field|no property|not found/i.test(err.message)) {
        throw new Error(
          `${err.message}\n\nThis usually means the FBR user-defined fields have not been created in SAP yet, or the Service Layer has not been restarted since they were added. Run Tools -> Check SAP setup to see exactly which fields are missing.`
        );
      }
      throw err;
    }

    const local = this.store.latestByDocEntry();
    const invoices = rows.map((r) => {
      const localRec = local.get(r.DocEntry);
      return {
        docEntry: r.DocEntry,
        docNum: r.DocNum,
        docDate: r.DocDate,
        cardCode: r.CardCode,
        cardName: r.CardName,
        docTotal: r.DocTotal,
        vatSum: r.VatSum,
        currency: r.DocCurrency,
        irn: r[f.irnField] || null,
        status: r[f.statusField] || null,
        // Local knowledge can be ahead of SAP if write-back failed.
        localStatus: localRec ? localRec.event : null,
        localIrn: localRec ? localRec.invoiceNumber || null : null,
        needsWriteBack: !!(localRec && localRec.invoiceNumber && localRec.writtenBack === false),
      };
    });

    return { invoices, truncated, limit: cfg.sync.maxResults };
  }

  /** Build the payload for one invoice without sending anything. */
  async preview(docEntry) {
    const cfg = this.config();
    const sap = this.sapClient();
    const invoice = await sap.getInvoice(docEntry);

    // Failures to LOAD master data are reported as their own errors. Left to
    // the mapper they are indistinguishable from master data that loaded fine
    // but is empty - which sends the user off editing an item that was never
    // read in the first place.
    const loadErrors = [];

    let businessPartner = null;
    try {
      businessPartner = await sap.getBusinessPartner(invoice.CardCode);
    } catch (err) {
      loadErrors.push(
        `Could not read business partner ${invoice.CardCode} from SAP: ${err.message}. Buyer details cannot be checked until this succeeds.`
      );
      this.log(`Could not load business partner ${invoice.CardCode}: ${err.message}`);
    }

    const items = new Map();
    const codes = [
      ...new Set((invoice.DocumentLines || []).map((l) => l.ItemCode).filter(Boolean)),
    ];
    for (const code of codes) {
      try {
        items.set(code, await sap.getItem(code));
      } catch (err) {
        loadErrors.push(
          `Could not read item ${code} from SAP: ${err.message}. Its HS code and unit cannot be read until this succeeds — this is a read failure, not missing master data.`
        );
        this.log(`Could not load item ${code}: ${err.message}`);
      }
    }

    const result = buildFbrPayload({ invoice, businessPartner, items, config: cfg });
    return {
      ...result,
      payload: loadErrors.length ? null : result.payload,
      errors: [...loadErrors, ...result.errors],
      invoice,
      docEntry,
    };
  }

  /** Dry-run against FBR's validate endpoint. Registers nothing. */
  async validate(docEntry) {
    const { payload, errors, warnings } = await this.preview(docEntry);
    if (!payload) return { ok: false, stage: 'mapping', errors, warnings };

    const res = await this.fbrClient().validateInvoice(payload);
    return {
      ok: res.accepted,
      stage: 'fbr-validate',
      warnings,
      errors: res.errors.map(describeFbrError),
      response: res,
      payload,
    };
  }

  /**
   * Register one invoice with FBR and write the IRN back to SAP.
   * @param {number} docEntry
   * @param {{force?:boolean}} [opts] force skips the "already registered" guard
   */
  async submit(docEntry, opts = {}) {
    const cfg = this.config();
    const f = cfg.sapFields;
    const sap = this.sapClient();

    // 1. Guard against double submission.
    const fresh = await sap.getInvoice(docEntry);
    const existingIrn = fresh[f.irnField];
    if (existingIrn && !opts.force) {
      return {
        ok: false,
        stage: 'guard',
        errors: [
          `Invoice ${fresh.DocNum} already carries FBR number ${existingIrn}. Re-posting would create a duplicate filing.`,
        ],
        invoiceNumber: existingIrn,
      };
    }

    const priorLocal = this.store.latestByDocEntry().get(docEntry);
    if (priorLocal && priorLocal.event === 'sending' && !opts.force) {
      return {
        ok: false,
        stage: 'guard',
        errors: [
          `A previous submission for invoice ${fresh.DocNum} was interrupted before a response was recorded. Check the IRIS portal for an existing filing before retrying, then use Force resubmit.`,
        ],
      };
    }

    // 2. Map.
    const { payload, errors, warnings } = await this.preview(docEntry);
    if (!payload) return { ok: false, stage: 'mapping', errors, warnings };

    // 3. Optional pre-validation.
    const fbr = this.fbrClient();
    if (cfg.sync.validateBeforePost) {
      const v = await fbr.validateInvoice(payload);
      if (!v.accepted) {
        this.store.append({
          event: 'validation-failed',
          docEntry,
          docNum: fresh.DocNum,
          environment: fbr.environment,
          errors: v.errors,
        });
        return {
          ok: false,
          stage: 'fbr-validate',
          warnings,
          errors: v.errors.map(describeFbrError),
          response: v,
          payload,
        };
      }
    }

    // 4. Mark in-flight, then post.
    this.store.append({
      event: 'sending',
      docEntry,
      docNum: fresh.DocNum,
      environment: fbr.environment,
      payload,
    });

    let res;
    try {
      res = await fbr.postInvoice(payload);
    } catch (err) {
      // The request failed in transit. We cannot know whether FBR processed it,
      // so the in-flight marker deliberately stays as the latest record.
      this.store.append({
        event: 'send-error',
        docEntry,
        docNum: fresh.DocNum,
        environment: fbr.environment,
        error: err.message,
        indeterminate: true,
      });
      return {
        ok: false,
        stage: 'fbr-post',
        errors: [
          `${err.message} — the invoice may or may not have reached FBR. Verify on the IRIS portal before retrying.`,
        ],
        indeterminate: true,
        payload,
      };
    }

    if (!res.accepted) {
      this.store.append({
        event: 'rejected',
        docEntry,
        docNum: fresh.DocNum,
        environment: fbr.environment,
        statusCode: res.statusCode,
        errors: res.errors,
      });
      if (cfg.sync.autoWriteBack) {
        await this.safeWriteBack(docEntry, {
          [f.statusField]: 'Invalid',
          [f.messageField]: truncate(res.errorSummary, 250),
        });
      }
      return {
        ok: false,
        stage: 'fbr-post',
        warnings,
        errors: res.errors.map(describeFbrError),
        response: res,
        payload,
      };
    }

    // 5. Accepted. Persist locally BEFORE touching SAP.
    const record = this.store.append({
      event: 'posted',
      docEntry,
      docNum: fresh.DocNum,
      environment: fbr.environment,
      invoiceNumber: res.invoiceNumber,
      dated: res.dated,
      writtenBack: false,
      payload,
    });

    // 6. Write back to SAP.
    let writeBackError = null;
    if (cfg.sync.autoWriteBack) {
      try {
        await sap.patchInvoice(docEntry, {
          [f.irnField]: res.invoiceNumber,
          [f.statusField]: 'Valid',
          [f.dateField]: res.dated ? res.dated.slice(0, 10) : new Date().toISOString().slice(0, 10),
          [f.messageField]: '',
        });
        this.store.append({ ...record, event: 'posted', writtenBack: true });
      } catch (err) {
        writeBackError = err.message;
        this.log(`WRITE-BACK FAILED for DocEntry ${docEntry}: ${err.message}`);
      }
    }

    return {
      ok: true,
      stage: 'done',
      warnings: [
        ...warnings,
        ...(writeBackError
          ? [
              `FBR accepted the invoice as ${res.invoiceNumber}, but writing it back to SAP failed: ${writeBackError}. The number is saved in the local log — use "Repair write-back" once SAP is reachable.`,
            ]
          : []),
      ],
      invoiceNumber: res.invoiceNumber,
      dated: res.dated,
      writtenBack: !writeBackError && cfg.sync.autoWriteBack,
      response: res,
      payload,
    };
  }

  /** Best-effort field update that never masks the caller's real outcome. */
  async safeWriteBack(docEntry, fields) {
    try {
      await this.sapClient().patchInvoice(docEntry, fields);
      return true;
    } catch (err) {
      this.log(`Status write-back failed for DocEntry ${docEntry}: ${err.message}`);
      return false;
    }
  }

  /** Re-apply IRNs that FBR issued but SAP never received. */
  async repairWriteBacks() {
    const f = this.config().sapFields;
    const orphans = this.store.orphanedIrns();
    const results = [];
    for (const o of orphans) {
      try {
        await this.sapClient().patchInvoice(o.docEntry, {
          [f.irnField]: o.invoiceNumber,
          [f.statusField]: 'Valid',
          [f.dateField]: o.dated ? o.dated.slice(0, 10) : String(o.ts).slice(0, 10),
          [f.messageField]: '',
        });
        this.store.append({ ...o, event: 'posted', writtenBack: true, repaired: true });
        results.push({ docEntry: o.docEntry, ok: true, invoiceNumber: o.invoiceNumber });
      } catch (err) {
        results.push({ docEntry: o.docEntry, ok: false, error: err.message });
      }
    }
    return results;
  }

  /** Submit a batch sequentially, stopping nothing on individual failures. */
  async submitMany(docEntries, onProgress) {
    const results = [];
    for (let i = 0; i < docEntries.length; i++) {
      const docEntry = docEntries[i];
      let result;
      try {
        result = await this.submit(docEntry);
      } catch (err) {
        result = { ok: false, stage: 'exception', errors: [err.message] };
      }
      results.push({ docEntry, ...result });
      if (onProgress) onProgress({ index: i + 1, total: docEntries.length, docEntry, result });
    }
    return results;
  }
}

function describeFbrError(e) {
  if (typeof e === 'string') return e;
  const where = e.itemSNo ? `Item ${e.itemSNo}: ` : '';
  return `${where}${e.errorCode ? `[${e.errorCode}] ` : ''}${e.error || ''}`.trim();
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function defaultFromDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number(days) || 30));
  return d.toISOString().slice(0, 10);
}


/** Assemble a single-line address from SAP's company information fields. */
function composeCompanyAddress(info) {
  if (!info) return '';
  const parts = [info.Street, info.Block, info.City, info.State, info.ZipCode]
    .filter((p) => p && String(p).trim())
    .map((p) => String(p).trim());
  return parts.join(', ');
}

module.exports = { SyncService };
