'use strict';
/**
 * FBR Digital Invoicing QR codes.
 *
 * Spec section 6 requires every issued invoice to carry the FBR Digital
 * Invoicing logo and a QR code, and fixes the format precisely:
 *
 *   QR Code Version : 2.0  (25 x 25 modules)
 *   Dimensions      : 1.0 x 1.0 inch
 *
 * The spec does NOT say what the QR must encode. Version 2 is itself the clue:
 * it holds about 47 alphanumeric characters, which fits the ~22-character
 * invoice number but not a JSON payload — so the FBR invoice number is what
 * goes in, and the content is configurable for sites told otherwise.
 *
 * The file is written to disk rather than embedded, because that is what SAP's
 * report designers can actually consume: Crystal Reports takes a picture whose
 * Graphic Location is a formula reading a path from the document.
 */
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

const QR_VERSION = 2;
const DEFAULT_DPI = 300;

/**
 * Render one invoice's QR code to a PNG.
 *
 * @param {object} o
 * @param {string} o.text        content to encode, normally the FBR invoice number
 * @param {string} o.folder      directory to write into
 * @param {string} o.fileName    file name, without extension
 * @param {number} [o.dpi]       dots per inch; the image is 1 inch square
 * @returns {Promise<{path:string, bytes:number, modules:number, pixels:number}>}
 */
async function writeInvoiceQr({ text, folder, fileName, dpi = DEFAULT_DPI }) {
  if (!text) throw new Error('Nothing to encode in the QR code.');
  if (!folder) throw new Error('No QR output folder configured.');

  const pixels = Math.round(dpi); // 1.0 x 1.0 inch
  const safeName = String(fileName).replace(/[^A-Za-z0-9._-]/g, '_');
  const outPath = path.join(folder, `${safeName}.png`);

  fs.mkdirSync(folder, { recursive: true });

  await QRCode.toFile(outPath, String(text), {
    type: 'png',
    // Pinned, not "auto": the spec mandates version 2, and letting the library
    // grow the symbol to fit would silently produce a non-compliant code.
    version: QR_VERSION,
    errorCorrectionLevel: 'M',
    width: pixels,
    margin: 4, // the quiet zone the QR standard requires
    color: { dark: '#000000ff', light: '#ffffffff' },
  });

  return {
    path: outPath,
    bytes: fs.statSync(outPath).size,
    modules: 25,
    pixels,
  };
}

/**
 * Check a value will fit the mandated symbol before trying to write it, so an
 * over-long content string is reported clearly rather than as a library error.
 */
async function canEncode(text) {
  try {
    await QRCode.toString(String(text), { version: QR_VERSION, errorCorrectionLevel: 'M' });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `"${String(text).slice(0, 40)}…" does not fit a version-2 QR code (about 47 characters at error correction M). FBR mandates version 2, so the content must be shortened.`,
      detail: err.message,
    };
  }
}

module.exports = { writeInvoiceQr, canEncode, QR_VERSION, DEFAULT_DPI };
