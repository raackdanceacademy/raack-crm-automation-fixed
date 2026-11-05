// test/mediaRetryTest.js — run with:  npm run test:media
// Starts a fake WAHA server that behaves like the real one did in your log:
// it answers 404 (JSON "ENOENT ... index.html") until the image "appears",
// and checks that downloadMediaWithRetry waits and succeeds — and that it
// returns null (no crash) when the image never appears.

import assert from 'assert';
import http from 'http';
import { downloadMediaWithRetry } from '../services/mediaService.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
let hits = 0;
let failFirst = 2; // number of 404s before the file "appears"
let neverAppears = false;
let lookupEnabled = false; // whether the fake 'get message' endpoint works

const server = http.createServer((req, res) => {
  if (lookupEnabled && req.url === '/api/files/default/fresh.jpeg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  if (req.url.startsWith('/api/files/default/')) {
    hits++;
    if (neverAppears || hits <= failFirst) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: "ENOENT: no such file or directory, stat '/tmp/whatsapp-files/index.html'", statusCode: 404 }));
    }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  // WAHA "get message" lookup: returns a fresh media URL that works.
  if (lookupEnabled && req.url.startsWith('/api/default/chats/') && req.url.includes('downloadMedia=true')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ media: { url: `http://localhost:3000/api/files/default/fresh.jpeg` } }));
  }
  if (req.url === '/api/files/default/fresh.jpeg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }
  res.writeHead(404); res.end();
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
process.env.WAHA_API_URL = `http://localhost:${port}`;
process.env.WAHA_API_KEY = 'test-key';

// The payload URL points to a DIFFERENT host (like a stale localhost:3000) —
// the service must rewrite it to WAHA_API_URL.
const payloadUrl = 'http://localhost:3000/api/files/default/false_1234@lid_ABC.jpeg';

let t = Date.now();
let r = await downloadMediaWithRetry({ mediaUrl: payloadUrl, messageId: 'false_1234@lid_ABC', chatId: '1234@lid' });
assert.ok(r && r.buffer.equals(JPEG), 'should download after 404s');
assert.equal(hits, 3, 'should have needed 3 attempts');
console.log(`✅ recovered after 2 x 404 in ${Date.now() - t} ms (${hits} attempts)`);

hits = 0; neverAppears = true;
t = Date.now();
r = await downloadMediaWithRetry({ mediaUrl: payloadUrl, messageId: 'x', chatId: 'y' });
assert.equal(r, null, 'must return null (not throw) when the image never appears');
console.log(`✅ image never available → returned null after ${Date.now() - t} ms, no exception`);

// Scenario 3: the original URL never works, but asking WAHA for the message
// again (downloadMedia=true) returns a fresh URL that does.
hits = 0; neverAppears = true; lookupEnabled = true;
t = Date.now();
r = await downloadMediaWithRetry({ mediaUrl: payloadUrl, messageId: 'false_1234@lid_ABC', chatId: '1234@lid' });
assert.ok(r && r.buffer.equals(JPEG), 'should recover through the WAHA message lookup');
console.log(`✅ recovered through WAHA message lookup in ${Date.now() - t} ms`);

server.close();
console.log('\nAll media checks passed.');
