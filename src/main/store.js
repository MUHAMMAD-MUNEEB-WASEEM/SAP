'use strict';
/**
 * Append-only audit log of every FBR interaction, kept as JSON Lines.
 *
 * This exists for one critical reason: posting to FBR is NOT idempotent and NOT
 * reversible. Once FBR issues an invoice number, that number is the only record
 * linking the SAP document to the government filing. If the app crashes, or the
 * write-back to SAP fails, the IRN must still be recoverable. So the flow is
 * always: mark in-flight -> post -> record the result here -> then write to SAP.
 *
 * JSON Lines (rather than a database) keeps this dependency-free and means a
 * partially written file still yields every complete record before it.
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'submissions.jsonl');
    fs.mkdirSync(dir, { recursive: true });
  }

  append(record) {
    const entry = { ts: new Date().toISOString(), ...record };
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /** All records, oldest first. Malformed trailing lines are skipped. */
  all() {
    if (!fs.existsSync(this.file)) return [];
    const out = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* ignore a torn final line */
      }
    }
    return out;
  }

  /** Latest record per SAP DocEntry. */
  latestByDocEntry() {
    const byDoc = new Map();
    for (const r of this.all()) {
      if (r.docEntry == null) continue;
      byDoc.set(r.docEntry, r);
    }
    return byDoc;
  }

  /**
   * Invoices that FBR accepted but which we could not write back to SAP.
   * These need operator attention: the filing exists, SAP does not know it.
   */
  orphanedIrns() {
    const out = [];
    for (const r of this.latestByDocEntry().values()) {
      if (r.event === 'posted' && r.invoiceNumber && r.writtenBack === false) out.push(r);
    }
    return out;
  }

  /**
   * Records left in-flight - a post was sent but no response was recorded,
   * usually a crash or a network drop mid-request. These must be reconciled by
   * a human against the IRIS portal before retrying, or a duplicate filing
   * could be created.
   */
  inFlight() {
    const out = [];
    for (const r of this.latestByDocEntry().values()) {
      if (r.event === 'sending') out.push(r);
    }
    return out;
  }

  findByDocEntry(docEntry) {
    return this.all().filter((r) => r.docEntry === docEntry);
  }
}

module.exports = { Store };
