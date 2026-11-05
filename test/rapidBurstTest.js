// test/rapidBurstTest.js — run with:  npm run test:burst
//
// End-to-end test of the REAL webhook → queue → processor → sheet pipeline
// with a FAKE Google Sheets (in memory, with realistic latency and injected
// failures). No WhatsApp, no Docker, no internet and no real sheet needed.
//
// It proves: immediate logging, instant ack, rapid bursts without loss /
// duplicates / reordering, retries on Google errors without double rows,
// replies that arrive before their row is written, background images,
// crash-recovery and the "Not an issue" dropdown value.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'raack-burst-'));
process.chdir(TMP); // state.json + journal go to a throw-away folder
process.env.SPREADSHEET_ID = 'FAKE_SHEET';
process.env.TARGET_NUMBER = '918925928564';
process.env.IMGBB_API_KEY = 'fake';
process.env.CATCHUP_ENABLED = 'false';

const imp = (rel) => import(pathToFileURL(path.join(PROJECT, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── capture console so we can check WHEN things were printed ──────────────
const logs = [];
const realLog = console.log; const realWarn = console.warn; const realErr = console.error;
const cap = (orig) => (...a) => { logs.push({ t: Date.now(), text: a.join(' ') }); if (process.env.VERBOSE) orig(...a); };
console.log = cap(realLog); console.warn = cap(realWarn); console.error = cap(realErr);
const say = (s) => realLog(s);

// ── fake Google Sheets ────────────────────────────────────────────────────
const HEADER = ['SNO', 'DATE', 'STUDIOS', 'CODE', 'ISSUE', 'IMAGE', 'STATUS', 'EMPLOYEES', 'MSG ID (internal - do not edit)'];
const fake = {
  rows: [HEADER.slice()], latency: 120, appendCalls: 0, running: 0, maxParallelAppends: 0,
  validations: [], failQueue: [], inUse: 0, failBatch: 0,
  reset() { this.rows = [HEADER.slice()]; this.appendCalls = 0; this.maxParallelAppends = 0; this.validations = []; this.failQueue = []; },
};
const rowOf = (a1) => parseInt(/(\d+)/.exec(a1.split('!')[1])[1], 10);
const colOf = (a1) => a1.split('!')[1][0];
const fakeClient = {
  spreadsheets: {
    get: async () => { await sleep(fake.latency); return { data: { sheets: [{ properties: { title: 'Parsed Issues', sheetId: 42, gridProperties: { rowCount: 500 } } }] } }; },
    batchUpdate: async ({ requestBody }) => { await sleep(fake.latency); if (fake.failBatch > 0) { fake.failBatch--; const e = new Error('Backend Error'); e.code = 500; throw e; } fake.validations.push(...requestBody.requests); return { data: {} }; },
    values: {
      append: async ({ requestBody }) => {
        fake.appendCalls++; fake.running++; fake.maxParallelAppends = Math.max(fake.maxParallelAppends, fake.running);
        try {
          await sleep(fake.latency);
          const mode = fake.failQueue.shift();
          if (mode === '429') { const e = new Error('Quota exceeded for quota metric'); e.code = 429; throw e; }
          const start = fake.rows.length + 1;
          for (const r of requestBody.values) { const copy = r.slice(); copy[0] = copy.length ? fake.rows.length : 0; fake.rows.push(copy); }
          if (mode === 'land-then-reset') { const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET'; throw e; }
          return { data: { updates: { updatedRange: `'Parsed Issues'!A${start}:I${start + requestBody.values.length - 1}`, updatedRows: requestBody.values.length } } };
        } finally { fake.running--; }
      },
      get: async ({ range }) => {
        await sleep(fake.latency / 2);
        const col = colOf(range);
        if (/^'Parsed Issues'!I:I$/.test(range)) return { data: { values: fake.rows.map((r) => [r[8] || ''].filter(() => true)).map((v) => (v[0] === '' ? [] : v)) } };
        const row = rowOf(range); const idx = 'ABCDEFGHI'.indexOf(col);
        const v = fake.rows[row - 1]?.[idx]; return { data: { values: v ? [[v]] : [] } };
      },
      update: async ({ range, requestBody }) => {
        await sleep(fake.latency / 2);
        const row = rowOf(range); const idx = 'ABCDEFGHI'.indexOf(colOf(range));
        fake.rows[row - 1][idx] = requestBody.values[0][0]; return { data: {} };
      },
    },
  },
};

// ── boot the real app ─────────────────────────────────────────────────────
const sheets = await imp('services/sheetsService.js');
sheets.__setSheetsClientForTests(fakeClient);
sheets.__setImageUploaderForTests(async () => 'https://i.ibb.co/fake/image.png');
const { app } = await imp('server.js');
const queue = await imp('services/webhookQueue.js');
const { rawId } = await imp('services/stateStore.js');
const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
const URL_ = `http://127.0.0.1:${server.address().port}/webhook`;

let n = 0;
const issue = (code, extra = {}) => ({
  id: `false_918925928564@c.us_T${String(++n).padStart(5, '0')}${code}`,
  from: '919876543210@c.us', to: '918925928564@c.us', timestamp: Math.floor(Date.now() / 1000),
  body: `24-09-2026\nVelachery\n${code}\nFees problem for ${code}`, hasMedia: false, ...extra,
});
const post = async (payload) => {
  const t0 = performance.now();
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'message', session: 'default', payload }) });
  const j = await r.json();
  return { status: r.status, body: j, ms: performance.now() - t0 };
};
const waitFor = async (cond, ms = 20000, what = 'condition') => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
};
const dataRows = () => fake.rows.slice(1);
const idle = async () => { await waitFor(() => queue.activeCount() === 0, 60000, 'all work to finish'); await sheets.whenAppendsIdle(); };

// warm-up (first-ever HTTP request / JIT is not what we want to time)
await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'session.status' }) });
await post(issue('RK0000000')); await idle();

let passed = 0, failed = 0;
async function test(name, fn) {
  fake.reset(); fake.latency = 120;
  try { await fn(); passed++; say(`✅ ${name}`); }
  catch (e) { failed++; say(`❌ ${name}\n   ${e.stack?.split('\n').slice(0, 4).join('\n   ')}`); }
  finally { try { await idle(); await sleep(50); } catch { /* ignore */ } fake.latency = 120; }
}

// ──────────────────────────────────────────────────────────────────────────
await test('terminal shows the message immediately — before Google is even called; webhook acks instantly', async () => {
  fake.latency = 600;
  const m = issue('RK1000001');
  const t0 = Date.now();
  const r = await post(m);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'queued');
  assert.ok(r.ms < 100, `ack took ${r.ms}ms`);
  const received = logs.find((l) => l.t >= t0 && l.text.includes('Message received') && l.text.includes('T') );
  assert.ok(received, 'no "Message received" log line');
  assert.ok(received.t - t0 < 100, `log appeared after ${received.t - t0}ms`);
  assert.equal(dataRows().length, 0, 'row must not be there yet (Google is slow) — proves the log did not wait for it');
  await idle();
  assert.equal(dataRows().length, 1);
  fake.latency = 120;
});

await test('RAPID BURST: 60 issues back-to-back → all saved, once, in arrival order, few API calls', async () => {
  const msgs = Array.from({ length: 60 }, (_, i) => issue(`RK2${String(i).padStart(6, '0')}`));
  const t0 = Date.now();
  for (const m of msgs) await post(m);          // as fast as HTTP allows
  const ackDone = Date.now() - t0;
  await idle();
  const codes = dataRows().map((r) => r[3]);
  assert.deepEqual(codes, msgs.map((m) => m.body.split('\n')[2]), 'rows missing / duplicated / out of order');
  assert.equal(new Set(dataRows().map((r) => r[8])).size, 60);
  assert.equal(fake.maxParallelAppends, 1, 'appends must never overlap');
  assert.ok(fake.appendCalls < 30, `expected batching, got ${fake.appendCalls} append calls`);
  say(`   · 60 messages acked in ${ackDone} ms, all in the sheet after ${Date.now() - t0} ms using ${fake.appendCalls} append calls`);
});

await test('PARALLEL BURST: 80 simultaneous webhooks → exactly 80 rows, no duplicates', async () => {
  const msgs = Array.from({ length: 80 }, (_, i) => issue(`RK3${String(i).padStart(6, '0')}`));
  await Promise.all(msgs.map(post));
  await idle();
  assert.equal(dataRows().length, 80);
  assert.equal(new Set(dataRows().map((r) => r[3])).size, 80);
  assert.equal(fake.maxParallelAppends, 1);
});

await test('same WhatsApp message delivered 6 times at once → ONE row', async () => {
  const m = issue('RK4000001');
  await Promise.all(Array.from({ length: 6 }, () => post(m)));
  await idle();
  await post(m); await idle();   // and once more later
  assert.equal(dataRows().length, 1);
});

await test('mixed traffic: only valid, formatted, private issues are tracked', async () => {
  const good = [issue('RK5000001'), issue('RK5000002'), issue('RK5000003')];
  const noise = [
    issue('RK5100001', { from: '120363330517692423@g.us' }),                 // group
    issue('RK5100002', { fromMe: true }),                                    // sent by us
    issue('RK5100003', { to: '919999999999@c.us' }),                         // other number
    issue('RK5100004', { body: 'ok thanks' }),                               // chit-chat
    issue('RK5100005', { body: 'thank you sir' }),                           // ignored phrase
    issue('RK5100006', { body: '24-09-2026\nVelachery\nno code here' }),     // missing code
  ];
  const all = [good[0], noise[0], noise[1], good[1], noise[2], noise[3], noise[4], good[2], noise[5]];
  for (const m of all) await post(m);
  await idle();
  assert.deepEqual(dataRows().map((r) => r[3]), ['RK5000001', 'RK5000002', 'RK5000003']);
});

await test('Google 429 twice, then OK → still exactly one row each, nothing lost', async () => {
  fake.failQueue = ['429', '429'];
  const msgs = [issue('RK6000001'), issue('RK6000002'), issue('RK6000003')];
  for (const m of msgs) await post(m);
  await idle();
  assert.deepEqual(dataRows().map((r) => r[3]), ['RK6000001', 'RK6000002', 'RK6000003']);
});

await test('write LANDS but the answer is lost (network reset) → retry does NOT create a duplicate', async () => {
  fake.failQueue = ['land-then-reset'];
  const m = issue('RK7000001');
  await post(m); await idle();
  assert.equal(dataRows().length, 1, `got ${dataRows().length} rows`);
});

await test('"Fixed" reply that arrives BEFORE its row is written still updates that row', async () => {
  fake.latency = 400;
  const orig = issue('RK8000001');
  await post(orig);
  const reply = { id: `false_918925928564@c.us_R${++n}`, from: '919876543210@c.us', to: '918925928564@c.us', body: 'Fixed', hasMedia: false,
    replyTo: { id: rawId(orig.id) } };     // WAHA may send only the short id
  await post(reply);
  await idle();
  assert.equal(dataRows().length, 1);
  assert.equal(dataRows()[0][6], 'Fixed');
  fake.latency = 120;
});

await test('image: row is saved FIRST, slow WAHA download finishes later and the link is added to the same row', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  let hits = 0;
  const waha = http.createServer((req, res) => { hits++; if (hits < 3) { res.statusCode = 404; return res.end('ENOENT'); } res.setHeader('content-type', 'image/png'); res.end(PNG); });
  await new Promise((r) => waha.listen(0, r));
  process.env.WAHA_API_URL = `http://127.0.0.1:${waha.address().port}`;
  const m = issue('RK9000001', { hasMedia: true, media: { url: `http://localhost:3000/api/files/default/x.png`, mimetype: 'image/png' } });
  const t0 = Date.now();
  await post(m);
  await waitFor(() => dataRows().length === 1, 5000, 'row');
  const rowAt = Date.now() - t0;
  assert.equal(dataRows()[0][5], 'N/A', 'image should not be there yet');
  assert.ok(rowAt < 1500, `row took ${rowAt}ms although the image is slow`);
  await idle();
  await waitFor(() => String(dataRows()[0][5]).startsWith('=HYPERLINK'), 15000, 'image link');
  assert.match(dataRows()[0][5], /i\.ibb\.co\/fake\/image\.png/);
  say(`   · row visible after ${rowAt} ms; image link added after ${Date.now() - t0} ms (WAHA needed 3 download attempts)`);
  waha.close();
});

await test('inline base64 image works and an issue behind a slow image is not delayed', async () => {
  const PNG64 = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082';
  const withImg = issue('RK9100001', { hasMedia: true, media: { data: Buffer.from(PNG64, 'hex').toString('base64'), mimetype: 'image/png' } });
  await post(withImg); await post(issue('RK9100002'));
  await idle();
  await waitFor(() => String(dataRows()[0]?.[5]).startsWith('=HYPERLINK'), 5000, 'image link');
  assert.deepEqual(dataRows().map((r) => r[3]), ['RK9100001', 'RK9100002']);
});

await test('crash recovery: unfinished journal entries are processed once; ones already in the sheet are not duplicated', async () => {
  const dir = path.join(TMP, 'data', 'pending'); fs.mkdirSync(dir, { recursive: true });
  const a = issue('RKA000001'); const b = issue('RKA000002');
  for (const m of [a, b]) fs.writeFileSync(path.join(dir, `${rawId(m.id)}.json`), JSON.stringify({ message: m, session: 'default' }));
  fake.rows.push(['1', 'x', 'Velachery', 'RKA000001', 'x', 'N/A', 'New', '', a.id]); // 'a' had already reached the sheet before the crash
  assert.equal(queue.recoverPending(), 2);
  await idle();
  assert.deepEqual(dataRows().map((r) => r[3]), ['RKA000001', 'RKA000002']);
  assert.equal(fs.readdirSync(dir).length, 0, 'journal not cleaned');
});

await test('Status dropdown (whole column) has every old value plus "Not an issue"; re-applied after new rows', async () => {
  const want = ['New', 'Open', 'Assigned', 'Re-Test', 'Fixed', 'Resolved', 'Bug', 'Not an issue'];
  await sheets.prepareSheet();
  const g0 = fake.validations.find((v) => v.setDataValidation.range.startColumnIndex === 6).setDataValidation;
  assert.deepEqual(g0.rule.condition.values.map((v) => v.userEnteredValue), want);
  assert.equal(g0.range.startRowIndex, 1); assert.equal(g0.range.endRowIndex, undefined, 'must cover the whole column');
  fake.validations = [];
  await post(issue('RKB000001')); await post(issue('RKB000002')); await idle(); await sleep(900);
  const g = fake.validations.filter((v) => v.setDataValidation.range.startColumnIndex === 6);
  const h = fake.validations.filter((v) => v.setDataValidation.range.startColumnIndex === 7);
  assert.ok(g.length >= 1 && h.length >= 1, 'dropdown not re-applied after new rows');
  assert.deepEqual(g[0].setDataValidation.rule.condition.values.map((v) => v.userEnteredValue), want);
  assert.equal(h[0].setDataValidation.rule.condition.values.length, 6);
  assert.equal(g[0].setDataValidation.rule.strict, true); assert.equal(h[0].setDataValidation.rule.strict, false);
});

await test('dropdown update fails once (Google 500) → retried, rows are not left without a dropdown', async () => {
  fake.failBatch = 1;
  await post(issue('RKC000001')); await idle(); await sleep(3500);
  assert.ok(fake.validations.some((v) => v.setDataValidation.range.startColumnIndex === 6), 'dropdown never applied after failure');
  fake.failBatch = 0;
});

console.log = realLog; console.warn = realWarn; console.error = realErr;
server.close();
console.log(`\n${passed} passed, ${failed} failed.`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
