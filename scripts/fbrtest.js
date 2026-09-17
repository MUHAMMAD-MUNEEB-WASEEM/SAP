'use strict';
/**
 * FBR transport tests.
 *
 * Kept separate from selftest.js because these need the HTTP layer replaced
 * before fbrClient is first required, which would otherwise interfere with the
 * pure-function tests there.
 *
 * The safety property under test is the important one: validation may be
 * retried freely because it files nothing, while registration must never be
 * retried automatically — FBR may have recorded a filing before failing to
 * respond, so a retry risks a duplicate government submission.
 *
 *   node scripts/fbrtest.js
 */
const assert = require('node:assert');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const httpPath = require.resolve(path.join(MAIN, 'http.js'));

let calls = [];
let responder = () => ({ status: 200, body: {}, raw: '', headers: {} });

class StubHttpError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    Object.assign(this, extra);
  }
}

// Replace the HTTP layer before fbrClient is loaded.
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: {
    request: async (opts) => {
      calls.push(opts.url);
      return responder(calls.length);
    },
    HttpError: StubHttpError,
    cookiesFromHeaders: () => ({}),
    serializeCookies: () => '',
  },
};

const { FbrClient } = require(path.join(MAIN, 'fbrClient.js'));

let passed = 0;
let failed = 0;

// These cases share the stubbed request recorder, so they MUST run one at a
// time. Running them concurrently lets one test's reset() clobber another's
// mid-await, which produces confident-looking passes that mean nothing.
const queue = [];

function section(title) {
  queue.push({ title });
}

function test(name, fn) {
  queue.push({ name, fn });
}

async function run() {
  for (const entry of queue) {
    if (entry.title) {
      console.log(`\n${entry.title}`);
      continue;
    }
    try {
      await entry.fn();
      passed++;
      console.log(`  PASS  ${entry.name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${entry.name}\n        ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

const client = () => new FbrClient({ environment: 'sandbox', token: 'tok', timeoutMs: 100 });
const reset = (fn) => {
  calls = [];
  responder = fn;
};

const serverError = (raw) => () => ({ status: 500, body: null, raw, headers: {} });

section('fbrClient — gateway failures');

test('a 500 surfaces what FBR actually said', async () => {
  reset(serverError('<html><body>Internal Server Error: bad hsCode</body></html>'));
  await assert.rejects(
    () => client().validateInvoice({}),
    (err) => {
      assert.ok(/Internal Server Error: bad hsCode/.test(err.message), 'body must be included');
      assert.ok(!/<html>/.test(err.message), 'HTML markup must be stripped');
      return true;
    }
  );
});

test('a JSON error body is surfaced verbatim', async () => {
  reset(() => ({ status: 500, body: { message: 'Invalid hsCode format' }, raw: '', headers: {} }));
  await assert.rejects(
    () => client().postInvoice({}),
    (err) => /Invalid hsCode format/.test(err.message)
  );
});

test('an empty error body says so rather than showing nothing', async () => {
  reset(serverError(''));
  await assert.rejects(
    () => client().validateInvoice({}),
    (err) => /empty response body/.test(err.message)
  );
});

section('fbrClient — retry safety');

test('validation is retried, because it files nothing', async () => {
  reset(serverError('busy'));
  await assert.rejects(() => client().validateInvoice({}));
  assert.strictEqual(calls.length, 3, 'expected the initial call plus two retries');
});

test('registration is NEVER retried, to avoid a duplicate filing', async () => {
  reset(serverError('busy'));
  await assert.rejects(() => client().postInvoice({}));
  assert.strictEqual(
    calls.length,
    1,
    'postinvoicedata must be attempted exactly once — FBR may have filed before failing to reply'
  );
});

test('a transient failure recovers on retry', async () => {
  reset((n) =>
    n < 2
      ? { status: 500, body: null, raw: 'busy', headers: {} }
      : {
          status: 200,
          body: {
            invoiceNumber: 'A338509DIZLMRRY981406',
            validationResponse: { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [] },
          },
          raw: '',
          headers: {},
        }
  );
  const res = await client().validateInvoice({});
  assert.strictEqual(res.accepted, true);
  assert.strictEqual(calls.length, 2);
});

test('a 401 is reported as a token problem, not retried', async () => {
  reset(() => ({ status: 401, body: null, raw: 'Unauthorized', headers: {} }));
  await assert.rejects(
    () => client().validateInvoice({}),
    (err) => /token/i.test(err.message) && /401/.test(err.message)
  );
  assert.strictEqual(calls.length, 1, 'a bad token will not fix itself on retry');
});

test('the sandbox endpoint is used in sandbox, production in production', async () => {
  reset(() => ({ status: 200, body: { validationResponse: {} }, raw: '', headers: {} }));
  await client().validateInvoice({});
  assert.ok(calls[0].endsWith('/validateinvoicedata_sb'), calls[0]);

  reset(() => ({ status: 200, body: { validationResponse: {} }, raw: '', headers: {} }));
  const live = new FbrClient({ environment: 'production', token: 'tok' });
  await live.postInvoice({});
  assert.ok(calls[0].endsWith('/postinvoicedata'), calls[0]);
  assert.ok(!calls[0].endsWith('_sb'), 'production must not hit the sandbox endpoint');
});

run();
