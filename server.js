import 'dotenv/config'; // MUST be line 1
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { startCatchUpScheduler } from './services/catchUp.js';
import { loadState } from './services/stateStore.js';
import { acceptMessage, recoverPending } from './services/webhookQueue.js';
import { prepareSheet, refreshDropdowns } from './services/sheetsService.js';

// Load "what was already handled" BEFORE any message can arrive.
loadState();

export const app = express();
app.use(express.json({ limit: '50mb' }));

// Live messages: WAHA calls this the moment a WhatsApp message arrives while
// the server is running. Messages that arrived while the server / Docker was
// OFF are picked up by the catch-up (services/catchUp.js) instead.
//
// The route answers WAHA immediately. The message is printed to the terminal
// first, then saved to the sheet in the background (see services/webhookQueue.js).
app.post('/webhook', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const event = body.event || 'message'; // older WAHA configs may omit "event"
  const session = body.session || 'default';

  // WAHA can be configured to also send non-message events (session.status,
  // message.ack, message.revoked, ...) to this same URL. Log every hit so
  // nothing arriving is invisible, but only actual new messages go through
  // the tracking logic.
  console.log(`\n📡 Webhook hit — event: "${event}", session: "${session}"`);

  if (event !== 'message') {
    console.log(`ℹ️  Ignoring "${event}" event (not a new WhatsApp message) — nothing to track.`);
    return res.status(200).json({ status: 'ignored', event });
  }

  try {
    const message = body.payload || body;
    return res.status(200).json(acceptMessage(message, { session }));
  } catch (error) {
    console.error('❌ ERROR handling webhook:', error);
    // 500 tells WAHA to retry.
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

// Sets up the "Status" dropdown (incl. "Not an issue") on the existing rows.
// Never blocks start-up; retries quietly if Google is briefly unreachable.
async function prepareSheetWithRetry() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await prepareSheet();
      console.log('📋 Google Sheet ready — Status dropdown includes "Not an issue".');
      return;
    } catch (err) {
      console.warn(`⚠️  Could not prepare the sheet (attempt ${attempt}/5): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  console.warn('⚠️  Sheet preparation skipped — new rows still get the full dropdown, existing rows keep their old one until the next start.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  // A stray error must never take the tracker down.
  process.on('unhandledRejection', (reason) => console.error('⚠️  Unhandled promise rejection:', reason));
  process.on('uncaughtException', (err) => console.error('⚠️  Uncaught exception:', err));

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`WAHA Webhook Server running on port ${PORT}`);
    recoverPending();
    prepareSheetWithRetry();
    // Safety net: re-apply the dropdowns every 5 minutes (covers rows added by hand or a missed update).
    setInterval(() => refreshDropdowns().catch(() => {}), 5 * 60 * 1000).unref();
    startCatchUpScheduler();
  });
}
