'use strict';
/* Renderer. Talks to the main process only through window.api (see preload.js). */

const $ = (id) => document.getElementById(id);
let config = null;
let invoices = [];

/* Sandbox scenario IDs, spec v1.12 section 9. Required for sandbox posts. */
const SCENARIOS = [
  ['SN001', 'Goods at standard rate to registered buyers'],
  ['SN002', 'Goods at standard rate to unregistered buyers'],
  ['SN003', 'Sale of steel (melted and re-rolled)'],
  ['SN004', 'Sale by ship breakers'],
  ['SN005', 'Reduced rate sale'],
  ['SN006', 'Exempt goods sale'],
  ['SN007', 'Zero rated sale'],
  ['SN008', 'Sale of 3rd schedule goods'],
  ['SN009', 'Cotton ginners (textile sector)'],
  ['SN010', 'Telecom services'],
  ['SN011', 'Toll manufacturing sale by steel sector'],
  ['SN012', 'Sale of petroleum products'],
  ['SN013', 'Electricity supply to retailers'],
  ['SN014', 'Sale of gas to CNG stations'],
  ['SN015', 'Sale of mobile phones'],
  ['SN016', 'Processing / conversion of goods'],
  ['SN017', 'Goods (FED in ST mode)'],
  ['SN018', 'Services (FED in ST mode)'],
  ['SN019', 'Services rendered or provided'],
  ['SN020', 'Sale of electric vehicles'],
  ['SN021', 'Sale of cement / concrete block'],
  ['SN022', 'Sale of potassium chlorate'],
  ['SN023', 'Sale of CNG'],
  ['SN024', 'Goods listed in SRO 297(I)/2023'],
  ['SN025', 'Non-adjustable supplies (Eighth Schedule Table 1)'],
  ['SN026', 'Sale to end consumer by retailers — standard rate'],
  ['SN027', 'Sale to end consumer by retailers — 3rd schedule'],
  ['SN028', 'Sale to end consumer by retailers — reduced rate'],
];

/* ------------------------------------------------------------- helpers */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v)
    ? v.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function dateOnly(s) {
  return s ? String(s).slice(0, 10) : '—';
}

function appendLog(line) {
  const view = $('logView');
  view.textContent += `${line}\n`;
  view.scrollTop = view.scrollHeight;
}

function showAlert(message, kind = 'warn') {
  const bar = $('alertBar');
  bar.className = `alert ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}`;
  bar.innerHTML = message;
  bar.classList.remove('hidden');
}

function hideAlert() {
  $('alertBar').classList.add('hidden');
}

/** Unwrap the {ok, data|error} envelope, surfacing failures in the console. */
async function call(promise, context) {
  const res = await promise;
  if (!res.ok) {
    appendLog(`✗ ${context}: ${res.error}`);
    showAlert(`<strong>${esc(context)} failed.</strong> ${esc(res.error)}`, 'error');
    return null;
  }
  return res.data;
}

/* ---------------------------------------------------------------- tabs */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'audit') loadAudit();
  });
});

/* -------------------------------------------------------------- config */

function populateScenarios() {
  const sel = $('map_defaultScenarioId');
  sel.innerHTML = SCENARIOS.map(([id, desc]) => `<option value="${id}">${id} — ${esc(desc)}</option>`).join('');
}

function fillForm(c) {
  $('sap_baseUrl').value = c.sap.baseUrl || '';
  $('sap_companyDB').value = c.sap.companyDB || '';
  $('sap_username').value = c.sap.username || '';
  $('sap_password').value = c.sap.password || '';
  $('sap_allowSelfSigned').checked = c.sap.allowSelfSigned !== false;

  $('fbr_environment').value = c.fbr.environment || 'sandbox';
  $('fbr_sandboxToken').value = c.fbr.sandboxToken || '';
  $('fbr_productionToken').value = c.fbr.productionToken || '';

  $('seller_ntnCnic').value = c.seller.ntnCnic || '';
  $('seller_businessName').value = c.seller.businessName || '';
  $('seller_province').value = c.seller.province || '';
  $('seller_address').value = c.seller.address || '';

  $('map_defaultScenarioId').value = c.mapping.defaultScenarioId || 'SN001';
  $('map_defaultSaleType').value = c.mapping.defaultSaleType || '';
  $('map_defaultUom').value = c.mapping.defaultUom || '';
  $('map_defaultHsCode').value = c.mapping.defaultHsCode || '';

  $('sync_validateBeforePost').checked = c.sync.validateBeforePost !== false;
  $('sync_autoWriteBack').checked = c.sync.autoWriteBack !== false;
  $('sync_lookbackDays').value = c.sync.lookbackDays || 30;

  for (const k of [
    'irnField', 'statusField', 'dateField', 'messageField', 'scenarioField', 'refNoField',
    'bpNtnField', 'bpProvinceField', 'bpRegTypeField',
    'itemHsCodeField', 'itemUomField', 'itemSaleTypeField',
  ]) {
    const el = $(`f_${k}`);
    if (el) el.value = c.sapFields[k] || '';
  }

  $('encWarn').hidden = c._encryptionAvailable !== false;
  updateEnvBadge(c.fbr.environment);
}

function readForm() {
  const sapFields = {};
  for (const k of [
    'irnField', 'statusField', 'dateField', 'messageField', 'scenarioField', 'refNoField',
    'bpNtnField', 'bpProvinceField', 'bpRegTypeField',
    'itemHsCodeField', 'itemUomField', 'itemSaleTypeField',
  ]) {
    const el = $(`f_${k}`);
    if (el) sapFields[k] = el.value.trim();
  }

  return {
    sap: {
      baseUrl: $('sap_baseUrl').value.trim(),
      companyDB: $('sap_companyDB').value.trim(),
      username: $('sap_username').value.trim(),
      password: $('sap_password').value,
      allowSelfSigned: $('sap_allowSelfSigned').checked,
    },
    fbr: {
      environment: $('fbr_environment').value,
      sandboxToken: $('fbr_sandboxToken').value,
      productionToken: $('fbr_productionToken').value,
    },
    seller: {
      ntnCnic: $('seller_ntnCnic').value.trim(),
      businessName: $('seller_businessName').value.trim(),
      province: $('seller_province').value,
      address: $('seller_address').value.trim(),
    },
    mapping: {
      defaultScenarioId: $('map_defaultScenarioId').value,
      defaultSaleType: $('map_defaultSaleType').value.trim(),
      defaultUom: $('map_defaultUom').value.trim(),
      defaultHsCode: $('map_defaultHsCode').value.trim(),
    },
    sync: {
      validateBeforePost: $('sync_validateBeforePost').checked,
      autoWriteBack: $('sync_autoWriteBack').checked,
      lookbackDays: Number($('sync_lookbackDays').value) || 30,
    },
    sapFields,
  };
}

function updateEnvBadge(env) {
  const live = env === 'production';
  const badge = $('envBadge');
  badge.textContent = live ? 'production' : 'sandbox';
  badge.className = `badge ${live ? 'badge-production' : 'badge-sandbox'}`;
  $('envDot').className = `dot ${live ? 'live' : ''}`;
}

$('fbr_environment').addEventListener('change', (e) => updateEnvBadge(e.target.value));

$('btnSaveSettings').addEventListener('click', async () => {
  const patch = readForm();
  if (patch.fbr.environment === 'production') {
    const ok = window.confirm(
      'Switch to PRODUCTION?\n\nInvoices registered in production are real, legally binding filings with FBR and cannot be reversed from this app.'
    );
    if (!ok) return;
  }
  const saved = await call(window.api.config.save(patch), 'Save settings');
  if (saved) {
    config = saved;
    fillForm(saved);
    $('settingsStatus').textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  }
});

/* --------------------------------------------------------- connections */

$('btnTestSap').addEventListener('click', async () => {
  const r = await call(window.api.test.sap(), 'SAP connection test');
  if (r) showAlert(`<strong>SAP connected.</strong> Service Layer ${esc(r.version || '')}, session timeout ${esc(r.sessionTimeout || '?')} min.`, 'ok');
});

$('btnTestFbr').addEventListener('click', async () => {
  const r = await call(window.api.test.fbr(), 'FBR connection test');
  if (r) showAlert(`<strong>FBR ${esc(r.environment)} token accepted.</strong> Reference API returned ${r.provinceCount} provinces.`, 'ok');
});

/* ------------------------------------------------------------ invoices */

$('btnRefresh').addEventListener('click', refreshInvoices);

async function refreshInvoices() {
  hideAlert();
  const filters = {
    fromDate: $('fromDate').value || undefined,
    toDate: $('toDate').value || undefined,
    includeRegistered: $('includeRegistered').checked,
  };
  const rows = await call(window.api.invoices.list(filters), 'Load invoices');
  if (!rows) return;
  invoices = rows;
  renderInvoices();

  const needsRepair = rows.filter((r) => r.needsWriteBack);
  if (needsRepair.length) {
    showAlert(
      `<strong>${needsRepair.length} invoice(s) were registered with FBR but the number never reached SAP.</strong> Open the Audit log tab and use “Repair pending write-backs”.`,
      'error'
    );
  }
}

function renderInvoices() {
  const body = $('invoiceBody');
  if (!invoices.length) {
    body.innerHTML = '<tr class="empty"><td colspan="9">No invoices match the current filter.</td></tr>';
    return;
  }

  body.innerHTML = invoices
    .map((inv) => {
      const irn = inv.irn || inv.localIrn;
      let pill = '<span class="pill pill-idle">Not sent</span>';
      if (inv.irn) pill = '<span class="pill pill-ok">Registered</span>';
      else if (inv.needsWriteBack) pill = '<span class="pill pill-warn">Write-back due</span>';
      else if (inv.localStatus === 'rejected') pill = '<span class="pill pill-err">Rejected</span>';
      else if (inv.localStatus === 'sending') pill = '<span class="pill pill-warn">In flight</span>';

      return `<tr data-doc="${inv.docEntry}">
        <td><input type="checkbox" class="rowcheck" data-doc="${inv.docEntry}" ${inv.irn ? 'disabled' : ''} /></td>
        <td>${esc(inv.docNum)}</td>
        <td>${esc(dateOnly(inv.docDate))}</td>
        <td title="${esc(inv.cardCode)}">${esc(inv.cardName || inv.cardCode)}</td>
        <td class="num">${money(inv.docTotal)}</td>
        <td class="num">${money(inv.vatSum)}</td>
        <td>${pill}</td>
        <td class="mono">${esc(irn || '—')}</td>
        <td>
          <button class="btn btn-sm act-preview" data-doc="${inv.docEntry}">Preview</button>
          <button class="btn btn-sm act-validate" data-doc="${inv.docEntry}">Validate</button>
          <button class="btn btn-sm btn-accent act-submit" data-doc="${inv.docEntry}" ${inv.irn ? 'disabled' : ''}>Register</button>
        </td>
      </tr>`;
    })
    .join('');
}

$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.rowcheck:not(:disabled)').forEach((c) => {
    c.checked = e.target.checked;
  });
});

function selectedDocEntries() {
  return [...document.querySelectorAll('.rowcheck:checked')].map((c) => Number(c.dataset.doc));
}

$('invoiceBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const docEntry = Number(btn.dataset.doc);
  if (btn.classList.contains('act-preview')) return previewInvoice(docEntry);
  if (btn.classList.contains('act-validate')) return validateInvoice(docEntry);
  if (btn.classList.contains('act-submit')) return submitInvoice(docEntry);
});

async function previewInvoice(docEntry) {
  const r = await call(window.api.invoices.preview(docEntry), `Preview invoice ${docEntry}`);
  if (!r) return;
  openDrawer(
    `Invoice ${r.docNum ?? docEntry} — payload preview`,
    `${issueList('Blocking problems', r.errors, 'err')}
     ${issueList('Warnings', r.warnings, 'warn')}
     <h4>FBR payload</h4>
     <pre class="output">${esc(r.payload ? JSON.stringify(r.payload, null, 2) : 'Not generated — resolve the problems above first.')}</pre>`
  );
}

async function validateInvoice(docEntry) {
  const r = await call(window.api.invoices.validate(docEntry), `Validate invoice ${docEntry}`);
  if (!r) return;
  openDrawer(
    `Invoice ${docEntry} — FBR validation`,
    `<div class="alert ${r.ok ? 'ok' : 'err'}">${
      r.ok
        ? 'FBR validation passed. This invoice is ready to register.'
        : `FBR validation failed at stage “${esc(r.stage)}”.`
    }</div>
     ${issueList('Problems', r.errors, 'err')}
     ${issueList('Warnings', r.warnings, 'warn')}
     ${r.payload ? `<h4>Payload sent</h4><pre class="output">${esc(JSON.stringify(r.payload, null, 2))}</pre>` : ''}`
  );
}

async function submitInvoice(docEntry) {
  const live = config && config.fbr.environment === 'production';
  const ok = window.confirm(
    live
      ? `Register invoice ${docEntry} with FBR PRODUCTION?\n\nThis creates a real, irreversible filing.`
      : `Register invoice ${docEntry} with the FBR sandbox?`
  );
  if (!ok) return;

  const r = await call(window.api.invoices.submit(docEntry), `Register invoice ${docEntry}`);
  if (!r) return;

  openDrawer(
    `Invoice ${docEntry} — registration result`,
    `<div class="alert ${r.ok ? 'ok' : 'err'}">${
      r.ok
        ? `Registered. FBR invoice number <strong class="mono">${esc(r.invoiceNumber)}</strong>${
            r.writtenBack ? ' and written back to SAP.' : ' — write-back pending.'
          }`
        : `Not registered (stage “${esc(r.stage)}”).${
            r.indeterminate
              ? ' <strong>The outcome is unknown</strong> — verify on the IRIS portal before retrying.'
              : ''
          }`
    }</div>
     ${issueList('Problems', r.errors, 'err')}
     ${issueList('Warnings', r.warnings, 'warn')}`
  );
  refreshInvoices();
}

$('btnValidateSel').addEventListener('click', async () => {
  const docs = selectedDocEntries();
  if (!docs.length) return showAlert('Select at least one invoice first.');
  const lines = [];
  for (const d of docs) {
    const r = await call(window.api.invoices.validate(d), `Validate invoice ${d}`);
    lines.push(`${d}: ${r ? (r.ok ? 'PASS' : `FAIL — ${(r.errors || []).join(' | ')}`) : 'ERROR'}`);
  }
  openDrawer('Batch validation', `<pre class="output">${esc(lines.join('\n'))}</pre>`);
});

$('btnSubmitSel').addEventListener('click', async () => {
  const docs = selectedDocEntries();
  if (!docs.length) return showAlert('Select at least one invoice first.');
  const live = config && config.fbr.environment === 'production';
  const ok = window.confirm(
    `Register ${docs.length} invoice(s) with FBR ${live ? 'PRODUCTION' : 'sandbox'}?${
      live ? '\n\nThese are real, irreversible filings.' : ''
    }`
  );
  if (!ok) return;

  const results = await call(window.api.invoices.submitMany(docs), 'Batch registration');
  if (!results) return;
  const summary = results
    .map((r) => `${r.docEntry}: ${r.ok ? `OK ${r.invoiceNumber}` : `FAILED — ${(r.errors || []).join(' | ')}`}`)
    .join('\n');
  openDrawer('Batch registration', `<pre class="output">${esc(summary)}</pre>`);
  refreshInvoices();
});

window.api.on.batchProgress((p) => {
  appendLog(`Batch ${p.index}/${p.total} — DocEntry ${p.docEntry}: ${p.result.ok ? 'registered' : 'failed'}`);
});

/* -------------------------------------------------------------- drawer */

function issueList(title, items, kind) {
  if (!items || !items.length) return '';
  return `<h4>${esc(title)}</h4><ul class="${kind}">${items
    .map((i) => `<li>${esc(typeof i === 'string' ? i : JSON.stringify(i))}</li>`)
    .join('')}</ul>`;
}

function openDrawer(title, html) {
  $('drawerTitle').textContent = title;
  $('drawerBody').innerHTML = html;
  $('drawer').classList.remove('hidden');
}

$('drawerClose').addEventListener('click', () => $('drawer').classList.add('hidden'));

/* --------------------------------------------------------------- audit */

async function loadAudit() {
  const [records, orphans, inFlight] = await Promise.all([
    call(window.api.audit.recent(200), 'Load audit log'),
    call(window.api.audit.orphans(), 'Load pending write-backs'),
    call(window.api.audit.inFlight(), 'Load in-flight submissions'),
  ]);

  const alerts = [];
  if (orphans && orphans.length) {
    alerts.push(
      `<div class="alert err"><strong>${orphans.length} FBR number(s) not yet in SAP.</strong> FBR accepted these invoices but the write-back failed. Press “Repair pending write-backs”.</div>`
    );
  }
  if (inFlight && inFlight.length) {
    alerts.push(
      `<div class="alert"><strong>${inFlight.length} submission(s) ended without a recorded response.</strong> Check the IRIS portal before retrying — re-posting could duplicate a filing.</div>`
    );
  }
  $('auditAlerts').innerHTML = alerts.join('');

  const body = $('auditBody');
  if (!records || !records.length) {
    body.innerHTML = '<tr class="empty"><td colspan="6">No submissions recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = records
    .map((r) => {
      const detail = r.errors
        ? r.errors.map((e) => (typeof e === 'string' ? e : `${e.errorCode || ''} ${e.error || ''}`)).join(' | ')
        : r.error || (r.writtenBack === false ? 'write-back pending' : '');
      return `<tr>
        <td class="mono">${esc(String(r.ts).replace('T', ' ').slice(0, 19))}</td>
        <td>${esc(r.event)}</td>
        <td>${esc(r.docNum ?? r.docEntry ?? '—')}</td>
        <td>${esc(r.environment || '—')}</td>
        <td class="mono">${esc(r.invoiceNumber || '—')}</td>
        <td>${esc(detail)}</td>
      </tr>`;
    })
    .join('');
}

$('btnLoadAudit').addEventListener('click', loadAudit);

$('btnRepair').addEventListener('click', async () => {
  const r = await call(window.api.repair.writeBacks(), 'Repair write-backs');
  if (!r) return;
  const done = r.filter((x) => x.ok).length;
  appendLog(`Write-back repair: ${done}/${r.length} succeeded.`);
  loadAudit();
  refreshInvoices();
});

$('btnExportAudit').addEventListener('click', async () => {
  const p = await call(window.api.app.exportAudit(), 'Export audit log');
  if (p) appendLog(`Audit log exported to ${p}`);
});

$('btnOpenData').addEventListener('click', () => window.api.app.openDataDir());

/* --------------------------------------------------------------- tools */

function showTool(data) {
  $('toolOutput').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

document.querySelectorAll('button.ref').forEach((b) => {
  b.addEventListener('click', async () => {
    const d = await call(window.api.fbr.reference(b.dataset.ref, {}), `FBR ${b.dataset.ref}`);
    if (d) showTool(d);
  });
});

$('btnHsUom').addEventListener('click', async () => {
  const hsCode = $('ref_hsCode').value.trim();
  if (!hsCode) return;
  const d = await call(window.api.fbr.reference('hsUom', { hsCode }), 'HS code lookup');
  if (d) showTool(d);
});

$('btnRegType').addEventListener('click', async () => {
  const regNo = $('ref_regNo').value.trim();
  if (!regNo) return;
  const d = await call(window.api.fbr.reference('regType', { regNo }), 'Registration type lookup');
  if (d) showTool(d);
});

$('btnStatl').addEventListener('click', async () => {
  const regNo = $('ref_regNo').value.trim();
  if (!regNo) return;
  const d = await call(
    window.api.fbr.reference('statl', { regNo, date: new Date().toISOString().slice(0, 10) }),
    'STATL lookup'
  );
  if (d) showTool(d);
});

$('btnCheckSetup').addEventListener('click', async () => {
  const d = await call(window.api.test.checkSetup(), 'SAP setup check');
  if (!d) return;
  const lines = [
    d.ready
      ? 'READY — every required user-defined field exists.'
      : `NOT READY — ${d.missingRequired} required field(s) missing. Create them per scripts/sap-udf-setup.md, then restart the Service Layer.`,
    '',
  ];
  for (const g of d.report) {
    lines.push(`${g.label} (${g.table})`);
    if (g.error) {
      lines.push(`  could not read: ${g.error}`);
    } else if (!g.fields.length) {
      lines.push('  nothing configured');
    } else {
      for (const f of g.fields) {
        const mark =
          f.status === 'present' ? 'ok      ' : f.status === 'standard' ? 'standard' : 'MISSING ';
        const req = f.status === 'missing' ? (f.required ? '  [required]' : '  [optional]') : '';
        lines.push(`  ${mark} ${f.field.padEnd(22)} ${f.purpose}${req}`);
      }
    }
    lines.push('');
  }
  showTool(lines.join('\n'));
});

$('btnCreateUdfs').addEventListener('click', async () => {
  const check = await call(window.api.test.checkSetup(), 'SAP setup check');
  if (!check) return;

  const missing = check.report.flatMap((g) =>
    g.fields.filter((f) => f.status === 'missing').map((f) => `${g.table}.${f.field}`)
  );
  if (!missing.length) {
    showTool('Nothing to create — every user-defined field already exists.');
    return;
  }

  const ok = window.confirm(
    `Create ${missing.length} user-defined field(s) in the SAP company database?\n\n` +
      `${missing.join('\n')}\n\n` +
      'This alters the database schema. Removing a UDF later discards any data stored in it, ' +
      'so do this on a test company first, with other users logged off.'
  );
  if (!ok) return;

  const r = await call(window.api.test.createUdfs(), 'Create user-defined fields');
  if (!r) return;

  const lines = [
    `${r.created} created, ${r.failed} failed.`,
    '',
    ...r.results.map((x) => `  ${x.ok ? 'ok     ' : 'FAILED '} ${x.table}.${x.field}${x.ok ? '' : ` — ${x.error}`}`),
    '',
    'Restart the SAP Service Layer service now, then run "Check SAP setup" again —',
    'Service Layer caches its metadata and will not expose the new fields until it does.',
  ];
  showTool(lines.join('\n'));
});

$('btnDiagnoseSap').addEventListener('click', async () => {
  const d = await call(window.api.test.diagnoseSap(), 'SAP login diagnostics');
  if (!d) return;
  const probes = Object.entries(d.probes || {})
    .map(([k, v]) => `  ${k}: HTTP ${v.status ?? '—'}  code ${v.code ?? '—'}  ${v.message || ''}`)
    .join('\n');
  showTool(`${d.findings.join('\n')}\n\nProbe detail\n${probes}`);
});

$('btnMetadata').addEventListener('click', async () => {
  const d = await call(window.api.diagnostics.metadata(), 'Download $metadata');
  if (d) showTool(`Saved ${d.bytes.toLocaleString()} bytes to:\n${d.path}`);
});

$('btnRawInvoice').addEventListener('click', async () => {
  const docEntry = Number($('diag_docEntry').value);
  if (!docEntry) return;
  const d = await call(window.api.diagnostics.rawInvoice(docEntry), 'Fetch raw invoice');
  if (d) showTool(d);
});

$('btnClearLog').addEventListener('click', () => {
  $('logView').textContent = '';
});

/* ----------------------------------------------------------- bootstrap */

window.api.on.log(appendLog);

(async function init() {
  populateScenarios();
  config = await call(window.api.config.get(), 'Load configuration');
  if (config) fillForm(config);

  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - (config && config.sync ? config.sync.lookbackDays : 30));
  $('fromDate').value = from.toISOString().slice(0, 10);
  $('toDate').value = today.toISOString().slice(0, 10);

  appendLog('Ready. Configure SAP and FBR under Settings, then press Refresh.');
})();
