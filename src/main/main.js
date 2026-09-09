'use strict';
/**
 * Electron main process.
 *
 * All network access, credentials and file I/O live here. The renderer is fully
 * sandboxed (no node integration, context isolation on) and can only reach this
 * side through the narrow, explicitly-listed IPC surface in preload.js.
 */
const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { ConfigStore } = require('./config');
const { Store } = require('./store');
const { SyncService } = require('./sync');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'config.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOG_PATH = path.join(DATA_DIR, 'app.log');

let mainWindow = null;
let configStore = null;
let store = null;
let sync = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    /* logging must never take the app down */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', line);
  }
  // eslint-disable-next-line no-console
  console.log(line);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1419',
    title: 'SAP → FBR Digital Invoicing',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(PROJECT_ROOT, 'src', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Keep external links out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Quote a CSV cell only when it needs it. */
function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Minimal RFC4180 CSV reader - handles quoted fields, embedded commas,
 * doubled quotes and both line endings. Enough for a spreadsheet round-trip,
 * and avoids a dependency for one file format.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((v) => v !== '')) rows.push(row);

  if (!rows.length) return [];

  // Map by header name so column order in the spreadsheet does not matter.
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const idx = (name) => header.indexOf(name);
  const iCode = idx('itemcode');
  const iName = idx('itemname');
  const iHs = idx('hscode');
  const iUom = idx('uom');
  const iSale = idx('saletype');

  return rows
    .slice(1)
    .map((r) => ({
      itemCode: (iCode >= 0 ? r[iCode] : r[0] || '').trim(),
      itemName: (iName >= 0 ? r[iName] : '') || '',
      hsCode: ((iHs >= 0 ? r[iHs] : '') || '').trim(),
      uoM: ((iUom >= 0 ? r[iUom] : '') || '').trim(),
      saleType: ((iSale >= 0 ? r[iSale] : '') || '').trim(),
    }))
    .filter((r) => r.itemCode);
}

/** Wrap a handler so the renderer always receives {ok, data|error}. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      log(`ERROR ${channel}: ${err.stack || err.message}`);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

app.whenReady().then(() => {
  configStore = new ConfigStore(CONFIG_PATH, safeStorage);
  try {
    configStore.load();
  } catch (err) {
    log(`Failed to read config, starting from defaults: ${err.message}`);
  }
  store = new Store(DATA_DIR);
  sync = new SyncService({ configStore, store, log });

  registerHandlers();
  createWindow();

  log(
    `Started. FBR environment: ${configStore.config.fbr.environment}. SAP: ${
      configStore.config.sap.baseUrl || 'not configured'
    }`
  );

  if (!configStore.encryptionAvailable) {
    log(
      'safeStorage encryption is unavailable on this machine — credentials will NOT be written to disk and must be re-entered each run.'
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function registerHandlers() {
  // ------------------------------------------------------------- config
  handle('config:get', async () => configStore.redacted());

  handle('config:save', async (patch) => {
    // A masked secret means "unchanged" — never overwrite a real one with stars.
    const clean = JSON.parse(JSON.stringify(patch || {}));
    if (clean.sap && clean.sap.password === '********') delete clean.sap.password;
    if (clean.fbr) {
      if (clean.fbr.sandboxToken === '********') delete clean.fbr.sandboxToken;
      if (clean.fbr.productionToken === '********') delete clean.fbr.productionToken;
    }
    configStore.save(clean);
    log('Configuration saved.');
    return configStore.redacted();
  });

  handle('config:path', async () => CONFIG_PATH);

  // -------------------------------------------------------- connections
  handle('test:sap', async () => {
    const r = await sync.testSap();
    log(`SAP login OK — Service Layer ${r.version || 'unknown version'}, session timeout ${r.sessionTimeout || '?'} min.`);
    return r;
  });

  handle('diagnose:setup', async () => {
    const r = await sync.checkSetup();
    log(
      r.ready
        ? 'SAP setup check: all required user-defined fields are present.'
        : `SAP setup check: ${r.missingRequired} required user-defined field(s) missing.`
    );
    return r;
  });

  handle('setup:createUdfs', async () => {
    log('Creating missing user-defined fields in SAP…');
    const r = await sync.createMissingUdfs();
    log(`UDF creation finished: ${r.created} created, ${r.failed} failed.`);
    return r;
  });

  handle('diagnose:sap', async () => {
    log('Running SAP login diagnostics (probe logins use fake credentials only)…');
    const r = await sync.diagnoseSap();
    r.findings.forEach((line) => log(`  ${line}`));
    return r;
  });

  handle('test:fbr', async () => {
    const r = await sync.testFbr();
    log(`FBR ${r.environment} token OK — reference API returned ${r.provinceCount} provinces.`);
    return r;
  });

  // ------------------------------------------------------------ invoices
  handle('invoices:list', async (filters) => sync.listPending(filters || {}));

  handle('invoices:preview', async (docEntry) => {
    const r = await sync.preview(docEntry);
    return {
      docEntry: r.docEntry,
      payload: r.payload,
      errors: r.errors,
      warnings: r.warnings,
      docNum: r.invoice ? r.invoice.DocNum : null,
    };
  });

  handle('invoices:validate', async (docEntry) => {
    log(`Validating DocEntry ${docEntry} against FBR ${configStore.config.fbr.environment}…`);
    return sync.validate(docEntry);
  });

  handle('invoices:submit', async (docEntry, opts) => {
    log(`Submitting DocEntry ${docEntry} to FBR ${configStore.config.fbr.environment}…`);
    const r = await sync.submit(docEntry, opts || {});
    if (r.ok) {
      log(`DocEntry ${docEntry} registered as ${r.invoiceNumber}${r.writtenBack ? ' and written back to SAP.' : ' (write-back pending).'}`);
    } else {
      log(`DocEntry ${docEntry} not registered [${r.stage}]: ${(r.errors || []).join(' | ')}`);
    }
    return r;
  });

  handle('invoices:submitMany', async (docEntries) =>
    sync.submitMany(docEntries || [], (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('batch-progress', p);
      }
    })
  );

  // -------------------------------------------------------- item mapping
  handle('items:list', async (opts) => sync.listItemsForMapping(opts || {}));

  handle('items:blocking', async (filters) => sync.itemsBlockingInvoices(filters || {}));

  handle('items:save', async (rows) => {
    log(`Writing FBR mapping to ${(rows || []).length} item(s)…`);
    return sync.saveItemMappings(rows || []);
  });

  handle('items:exportCsv', async (rows) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export item mapping',
      defaultPath: path.join(app.getPath('documents'), 'fbr-item-mapping.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const header = 'ItemCode,ItemName,HSCode,UoM,SaleType\n';
    const body = (rows || [])
      .map((r) => [r.itemCode, r.itemName, r.hsCode, r.uoM, r.saleType].map(csvCell).join(','))
      .join('\n');
    fs.writeFileSync(res.filePath, header + body + '\n', 'utf8');
    log(`Item mapping exported to ${res.filePath}`);
    return res.filePath;
  });

  handle('items:importCsv', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import item mapping',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const rows = parseCsv(fs.readFileSync(res.filePaths[0], 'utf8'));
    log(`Imported ${rows.length} row(s) from ${res.filePaths[0]}`);
    return rows;
  });

  // ------------------------------------------------------------- repair
  handle('repair:writeBacks', async () => {
    const r = await sync.repairWriteBacks();
    log(`Write-back repair processed ${r.length} record(s).`);
    return r;
  });

  handle('audit:orphans', async () => store.orphanedIrns());
  handle('audit:inFlight', async () => store.inFlight());
  handle('audit:recent', async (limit) => store.all().slice(-(limit || 200)).reverse());

  // ------------------------------------------------------- FBR reference
  handle('fbr:reference', async (kind, params) => {
    const client = sync.fbrClient();
    switch (kind) {
      case 'provinces':
        return client.getProvinces();
      case 'uom':
        return client.getUom();
      case 'docTypes':
        return client.getDocTypes();
      case 'transTypes':
        return client.getTransactionTypes();
      case 'hsCodes':
        return client.getHsCodes();
      case 'hsUom':
        return client.getHsUom(params.hsCode, params.annexureId);
      case 'saleTypeToRate':
        return client.getSaleTypeToRate(params.date, params.transTypeId, params.originationSupplier);
      case 'statl':
        return client.checkStatl(params.regNo, params.date);
      case 'regType':
        return client.getRegistrationType(params.regNo);
      default:
        throw new Error(`Unknown reference lookup: ${kind}`);
    }
  });

  // ---------------------------------------------------------- diagnostics
  handle('sap:metadata', async () => {
    const xml = await sync.sapClient().metadata();
    const out = path.join(DATA_DIR, 'sap-metadata.xml');
    fs.writeFileSync(out, xml, 'utf8');
    log(`Service Layer $metadata written to ${out} (${xml.length} bytes).`);
    return { path: out, bytes: xml.length };
  });

  handle('sap:rawInvoice', async (docEntry) => sync.sapClient().getInvoice(docEntry));

  handle('app:openDataDir', async () => {
    await shell.openPath(DATA_DIR);
    return DATA_DIR;
  });

  handle('app:exportAudit', async () => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export FBR submission log',
      defaultPath: path.join(app.getPath('documents'), 'fbr-submissions.jsonl'),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.copyFileSync(store.file, res.filePath);
    return res.filePath;
  });
}
