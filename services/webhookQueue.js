// services/webhookQueue.js
//
// The "front door" for live WhatsApp messages (called by the /webhook route).
//
// What it guarantees:
//   1. IMMEDIATE LOG — the message is printed to the terminal the instant it
//      arrives, before anything else happens (no waiting for Google).
//   2. IMMEDIATE ACK — WAHA gets its 200 straight away, so it never times
//      out and re-sends. Processing continues in the background.
//   3. NOTHING GETS LOST — each private message is first saved to
//      data/pending/ and only removed once it has been fully handled. If the
//      server crashes / is stopped mid-way, the message is picked up again
//      on the next start. A failed attempt (Google down, quota, network) is
//      retried with back-off instead of being dropped.
//   4. NO DUPLICATES — the same claim / done-list (stateStore) and the
//      column-I check (sheetsService) used by the catch-up protect every
//      path, so webhook + retry + catch-up can never write a message twice.
//   5. ORDER — messages are handed to the sheet queue in the order they
//      arrive, and the sheet queue writes them in that order.

import fs from 'node:fs';
import path from 'node:path';
import { processIncomingMessage, logIncoming } from './messageProcessor.js';
import { markMaybeWritten } from './sheetsService.js';
import { rawId } from './stateStore.js';

const PENDING_DIR = path.resolve(process.cwd(), 'data', 'pending');
const MAX_ATTEMPTS = 8;               // ~3 minutes of retrying, then the catch-up takes over
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── tiny on-disk journal ─────────────────────────────────────────────────
function journalFile(message) {
  const key = rawId(message.id).replace(/[^A-Za-z0-9_-]/g, '');
  return key ? path.join(PENDING_DIR, `${key}.json`) : null;
}

function journalWrite(message, session) {
  const file = journalFile(message);
  if (!file) return null;
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ message, session, savedAt: new Date().toISOString() }));
    fs.renameSync(tmp, file);
    return file;
  } catch (err) {
    console.warn(`⚠️  Could not save message to the crash-safety journal: ${err.message}`);
    return null;
  }
}

function journalRemove(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// Only real customer messages are worth journalling (groups / our own
// messages are skipped instantly and need no safety net).
function needsJournal(message) {
  const chatId = message.from || message.chatId || '';
  return Boolean(message.id) && !message.fromMe && !chatId.endsWith('@g.us');
}

// ── background runner ────────────────────────────────────────────────────
let active = 0;
export const activeCount = () => active;

async function run(message, session, journal, { recovered = false } = {}) {
  active++;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // NOTE: the first call starts synchronously, so the message is
        // claimed (in-flight) before this function returns to the webhook.
        const result = await processIncomingMessage(message, { source: 'webhook', session, alreadyLogged: true });
        if (result.status === 'in_progress') {
          // someone else (catch-up) is on it — look again shortly in case it fails
          await sleep(5000);
          continue;
        }
        journalRemove(journal);
        return result;
      } catch (err) {
        const wait = Math.min(60000, 2000 * 2 ** attempt);
        if (attempt === MAX_ATTEMPTS - 1) {
          console.error(
            `🚨 GAVE UP for now on message ${message.id}: ${err.message}. ` +
            `It stays saved in data/pending/ and is retried on the next start and by the periodic catch-up.`
          );
          return null;
        }
        console.warn(`🔁 Will retry message ${message.id} in ${wait / 1000}s (attempt ${attempt + 2}/${MAX_ATTEMPTS})`);
        await sleep(wait);
      }
    }
    return null;
  } finally {
    active--;
  }
}

/**
 * Accepts one live message. Prints it immediately, starts handling it in the
 * background, and returns right away (the caller answers WAHA with 200).
 */
export function acceptMessage(message, { session } = {}) {
  logIncoming(message);                                   // 1) terminal, instantly
  const journal = needsJournal(message) ? journalWrite(message, session) : null; // 2) crash safety
  run(message, session, journal).catch((err) =>           // 3) background, in arrival order
    console.error(`❌ Unexpected error while handling ${message.id}: ${err.message}`)
  );
  return { status: 'queued' };
}

/** On start-up: finish whatever a previous run did not complete. */
export function recoverPending() {
  let files = [];
  try {
    files = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  const items = [];
  for (const f of files) {
    const file = path.join(PENDING_DIR, f);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.message) items.push({ file, ...saved });
    } catch {
      journalRemove(file); // unreadable / half-written → nothing to recover
    }
  }
  // oldest first
  items.sort((a, b) => (Number(a.message.timestamp) || 0) - (Number(b.message.timestamp) || 0));
  if (items.length) console.log(`♻️  Recovering ${items.length} message(s) that were not finished before the last stop...`);
  for (const { file, message, session } of items) {
    markMaybeWritten(message.id); // it may have reached the sheet just before the stop → verify first
    run(message, session, file, { recovered: true }).catch((err) =>
      console.error(`❌ Unexpected error while recovering ${message.id}: ${err.message}`)
    );
  }
  return items.length;
}
