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
