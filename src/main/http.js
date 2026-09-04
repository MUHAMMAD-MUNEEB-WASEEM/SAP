'use strict';
/**
 * Minimal HTTPS/HTTP client built on node:https.
 *
 * Written against the raw module rather than fetch/undici because we need two
 * things fetch makes awkward inside Electron: per-request control of
 * `rejectUnauthorized` (SAP Service Layer ships a self-signed certificate) and
 * access to raw Set-Cookie headers (Service Layer sessions are cookie-based).
 */
const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

class HttpError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method]
 * @param {object} [opts.headers]
 * @param {object|string} [opts.body]     object is JSON-encoded
 * @param {boolean} [opts.insecure]       skip TLS verification (self-signed SAP cert)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{status:number, headers:object, body:any, raw:string}>}
 */
function request(opts) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    insecure = false,
    timeoutMs = 60000,
  } = opts;

  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  let payload;
  const outHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined && body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!outHeaders['Content-Type'] && !outHeaders['content-type']) {
      outHeaders['Content-Type'] = 'application/json';
    }
    outHeaders['Content-Length'] = Buffer.byteLength(payload);
  }

  const requestOptions = {
    method,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    path: target.pathname + target.search,
    headers: outHeaders,
  };
  if (isHttps && insecure) requestOptions.rejectUnauthorized = false;

  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        const ctype = res.headers['content-type'] || '';
        if (ctype.includes('json') && raw.trim()) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* leave as text so the caller can see what actually came back */
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new HttpError(`Request timed out after ${timeoutMs}ms`, { url })
      );
    });
    req.on('error', (err) => {
      // Surface the common misconfigurations in language the user can act on.
      if (err.code === 'ECONNREFUSED') {
        reject(new HttpError(`Connection refused by ${target.host}. Is the service running and the port open?`, { url }));
      } else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
        reject(new HttpError(`Cannot reach ${target.host} (${err.code}). Check network/VPN routing to that subnet.`, { url }));
      } else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
        reject(new HttpError(`TLS rejected the self-signed certificate at ${target.host}. Enable "allow self-signed certificate" for this connection.`, { url }));
      } else {
        reject(new HttpError(`${err.code || 'Request failed'}: ${err.message}`, { url }));
      }
    });

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Collect Set-Cookie headers into a single `name=value; name=value` string. */
function cookiesFromHeaders(headers) {
  const setCookie = headers['set-cookie'] || [];
  const jar = {};
  for (const line of setCookie) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function serializeCookies(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

module.exports = { request, HttpError, cookiesFromHeaders, serializeCookies };
