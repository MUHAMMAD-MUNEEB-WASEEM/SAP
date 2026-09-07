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
const { buildFbrPayload } = require('./mapper');
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

  // -------------------------------------------------------------- listing

  async listPending({ fromDate, toDate, includeRegistered = false } = {}) {
    const cfg = this.config();
    const f = cfg.sapFields;
    let rows;
    try {
      rows = await this.sapClient().listInvoices({
        statusField: f.statusField,
        irnField: f.irnField,
        fromDate: fromDate || defaultFromDate(cfg.sync.lookbackDays),
        toDate,
        pageSize: cfg.sync.pageSize,
        includeRegistered,
      });
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
    return rows.map((r) => {
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
  }

  /** Build the payload for one invoice without sending anything. */
  async preview(docEntry) {
    const cfg = this.config();
    const sap = this.sapClient();
    const invoice = await sap.getInvoice(docEntry);

    let businessPartner = null;
    try {
      businessPartner = await sap.getBusinessPartner(invoice.CardCode);
    } catch (err) {
      this.log(`Could not load business partner ${invoice.CardCode}: ${err.message}`);
    }

    const items = new Map();
    const codes = [
      ...new Set(
        (invoice.DocumentLines || []).map((l) => l.ItemCode).filter(Boolean)
      ),
    ];
    for (const code of codes) {
      try {
        items.set(code, await sap.getItem(code));
      } catch (err) {
        this.log(`Could not load item ${code}: ${err.message}`);
      }
    }

    const result = buildFbrPayload({ invoice, businessPartner, items, config: cfg });
    return { ...result, invoice, docEntry };
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

module.exports = { SyncService };
