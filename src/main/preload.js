'use strict';
/**
 * The only bridge between the sandboxed renderer and the main process.
 * Every channel is listed explicitly - the renderer cannot reach ipcRenderer
 * directly, so it cannot invoke anything not named here.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => invoke('config:get'),
    save: (patch) => invoke('config:save', patch),
    path: () => invoke('config:path'),
  },
  test: {
    sap: () => invoke('test:sap'),
    fbr: () => invoke('test:fbr'),
  },
  invoices: {
    list: (filters) => invoke('invoices:list', filters),
    preview: (docEntry) => invoke('invoices:preview', docEntry),
    validate: (docEntry) => invoke('invoices:validate', docEntry),
    submit: (docEntry, opts) => invoke('invoices:submit', docEntry, opts),
    submitMany: (docEntries) => invoke('invoices:submitMany', docEntries),
  },
  repair: {
    writeBacks: () => invoke('repair:writeBacks'),
  },
  audit: {
    orphans: () => invoke('audit:orphans'),
    inFlight: () => invoke('audit:inFlight'),
    recent: (limit) => invoke('audit:recent', limit),
  },
  fbr: {
    reference: (kind, params) => invoke('fbr:reference', kind, params),
  },
  diagnostics: {
    metadata: () => invoke('sap:metadata'),
    rawInvoice: (docEntry) => invoke('sap:rawInvoice', docEntry),
  },
  app: {
    openDataDir: () => invoke('app:openDataDir'),
    exportAudit: () => invoke('app:exportAudit'),
  },
  on: {
    log: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
    batchProgress: (cb) => ipcRenderer.on('batch-progress', (_e, p) => cb(p)),
  },
});
