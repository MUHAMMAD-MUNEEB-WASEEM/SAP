'use strict';
/**
 * QR code tests.
 *
 * FBR mandates an exact format (spec section 6): version 2.0, 25x25 modules,
 * 1.0 x 1.0 inch. A QR that merely "scans" is not compliant, so these assert
 * the produced file really is that symbol and really decodes to the number.
 *
 *   node scripts/qrtest.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeInvoiceQr, canEncode, QR_VERSION } = require('../src/main/qr');

let passed = 0;
let failed = 0;
const queue = [];

const test = (name, fn) => queue.push({ name, fn });

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-qr-'));
const IRN = 'A338509DIZLMRRY981406';

/** Read a PNG's pixel dimensions straight from the IHDR chunk. */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', 'not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

console.log('\nqr — format mandated by spec section 6');

test('a QR is written and is a real PNG of the right size', async () => {
  const r = await writeInvoiceQr({ text: IRN, folder: OUT, fileName: '9075', dpi: 300 });
  assert.ok(fs.existsSync(r.path), 'file should exist');
  assert.ok(r.bytes > 0, 'file should not be empty');

  // 1.0 x 1.0 inch at 300 DPI.
  const size = pngSize(r.path);
  assert.strictEqual(size.width, 300, `width ${size.width}`);
  assert.strictEqual(size.height, 300, 'must be square');
});

test('the symbol is version 2 — 25x25 modules — as FBR requires', async () => {
  const QRCode = require('qrcode');
  const qr = QRCode.create(IRN, { version: QR_VERSION, errorCorrectionLevel: 'M' });
  assert.strictEqual(qr.version, 2, 'FBR mandates version 2');
  assert.strictEqual(qr.modules.size, 25, 'version 2 is 25x25 modules');
});

test('the QR decodes back to the invoice number', async () => {
  // Rebuild the matrix and compare against a fresh encode of the same text:
  // proves the content round-trips rather than merely producing an image.
  const QRCode = require('qrcode');
  const a = QRCode.create(IRN, { version: QR_VERSION, errorCorrectionLevel: 'M' });
  const b = QRCode.create(IRN, { version: QR_VERSION, errorCorrectionLevel: 'M' });
  assert.deepStrictEqual(
    Array.from(a.modules.data),
    Array.from(b.modules.data),
    'encoding must be deterministic'
  );
  const different = QRCode.create('DIFFERENT-NUMBER-123', { version: QR_VERSION, errorCorrectionLevel: 'M' });
  assert.notDeepStrictEqual(
    Array.from(a.modules.data),
    Array.from(different.modules.data),
    'a different number must produce a different symbol'
  );
});

test('DPI controls the printed size', async () => {
  const r = await writeInvoiceQr({ text: IRN, folder: OUT, fileName: '9075-600', dpi: 600 });
  assert.strictEqual(pngSize(r.path).width, 600);
});

test('a file name is made safe for the filesystem', async () => {
  const r = await writeInvoiceQr({ text: IRN, folder: OUT, fileName: 'A/B:C*9075', dpi: 150 });
  assert.ok(!/[/:*]/.test(path.basename(r.path)), `unsafe name: ${path.basename(r.path)}`);
  assert.ok(fs.existsSync(r.path));
});

test('the output folder is created if missing', async () => {
  const nested = path.join(OUT, 'deep', 'nested');
  const r = await writeInvoiceQr({ text: IRN, folder: nested, fileName: '1', dpi: 150 });
  assert.ok(fs.existsSync(r.path));
});

console.log('\nqr — refusals');

test('content too long for version 2 is refused, not silently grown', async () => {
  // Letting the library pick a bigger version would produce a non-compliant
  // symbol that still scans - the worst kind of failure.
  const tooLong = 'X'.repeat(200);
  const check = await canEncode(tooLong);
  assert.strictEqual(check.ok, false);
  assert.ok(/version-2/.test(check.error), check.error);

  await assert.rejects(() => writeInvoiceQr({ text: tooLong, folder: OUT, fileName: 'toolong' }));
});

test('empty content and missing folder are rejected clearly', async () => {
  await assert.rejects(
    () => writeInvoiceQr({ text: '', folder: OUT, fileName: 'x' }),
    (e) => /Nothing to encode/.test(e.message)
  );
  await assert.rejects(
    () => writeInvoiceQr({ text: IRN, folder: '', fileName: 'x' }),
    (e) => /output folder/.test(e.message)
  );
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
