// services/catchUp.js
//
// Tracks the messages that arrived while your server / Docker was switched off.
//
// HOW IT WORKS
//   1. Waits until WAHA (Docker) is running and WhatsApp is connected.
//   2. Asks WAHA: "which private chats got messages since <last check>?"
//   3. Reads those messages (read OR unread — it does not matter) and puts
//      them in time order.
//   4. Runs each one through the SAME rules as live messages
//      (date + studio + student code format, replies, images ...).
//   5. Anything already in the sheet / already handled is skipped, so there
//      are never duplicate rows.
//   6. Remembers "checked up to <now>" in data/state.json for next time.
//
// It runs: once when everything is up, again ~2 min later (WhatsApp can keep
// syncing after it connects), whenever WAHA reconnects, and every
// CATCHUP_INTERVAL_MINUTES as a safety net.

import { processIncomingMessage } from './messageProcessor.js';
import { getTrackedMessageIds } from './sheetsService.js';
import {
  getSessionStatus,
  listChatsSince,
  getIncomingMessagesSince,
  fetchMessageWithMedia,
  toSeconds,
  sessionName,
  WahaError,
} from './wahaClient.js';
import {
  knownIdCount,
  getWatermark,
  setWatermark,
  seedDoneIds,
  isDone,
  flushState,
} from './stateStore.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OVERLAP_SECONDS = 300;      // re-look 5 min back so nothing slips through
const DELAY_BETWEEN_ROWS_MS = 300; // gentle pacing; rate-limit errors are now retried with back-off
const RETRY_DELAYS_MS = [5000, 15000, 30000];

let running = false;
let sheetIdsLoaded = false;

const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function processWithRetry(message, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await processIncomingMessage(message, options);
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      console.warn(`⚠️  [catch-up] failed (${err.message}) — retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s...`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

function explainWahaProblem(err) {
  console.error(`❌ [catch-up] WAHA problem: ${err.message}`);
  if (err.status === 401 || err.status === 403) {
    console.error('   → WAHA_API_KEY in .env does not match the key WAHA was started with.');
  } else if (err.status === 422 || err.status === 501 || /store/i.test(err.body || err.message)) {
    console.error('   → WAHA cannot list old messages. If you use the NOWEB engine, the "store" must be enabled');
    console.error('     (WAHA Dashboard → session → Config → NOWEB → Store enabled) — see the README note.');
  }
}

/**
 * Runs one catch-up pass.
 * @returns {Promise<{ok: boolean, reason?: string, tracked?: number}>}
 */
export async function runCatchUp(reason = 'scheduled') {
  if (running) return { ok: false, reason: 'already running' };
  running = true;
  const startedAt = Math.floor(Date.now() / 1000);

  try {
    const status = await getSessionStatus();
    if (status !== 'WORKING') {
      return { ok: false, reason: `WAHA session is "${status ?? 'unreachable'}"` };
    }

    // Decide how far back to look.
    const previousWatermark = getWatermark();
    const firstRun = previousWatermark === null;
    const lookbackHours = envNumber('CATCHUP_LOOKBACK_HOURS', 72);
    const since = firstRun
      ? startedAt - lookbackHours * 3600
      : previousWatermark - OVERLAP_SECONDS;

    console.log('\n══════════════════════════════════════════');
    console.log(`🔄 CATCH-UP (${reason}) — looking for messages since ${new Date(since * 1000).toLocaleString()}` +
      (firstRun ? `  [first run: last ${lookbackHours}h]` : ''));

    // Load what the sheet already contains (once per program start).
    if (!sheetIdsLoaded) {
      const ids = await getTrackedMessageIds();
      const added = seedDoneIds(ids);
      sheetIdsLoaded = true;
      console.log(`   📋 ${ids.length} messages already in the sheet (${added} newly remembered).`);
    }

    // Which chats had activity?
    const { totalChats, chats } = await listChatsSince(since);
    console.log(`   💬 ${chats.length} of ${totalChats} private chats have messages in this period.`);

    // Collect all messages from those chats.
    const all = [];
    for (const chat of chats) {
      try {
        const messages = await getIncomingMessagesSince(chat.id, since);
        for (const m of messages) all.push({ chatId: chat.id, message: m });
      } catch (err) {
        if (err instanceof WahaError) explainWahaProblem(err);
        else console.error(`❌ [catch-up] could not read chat ${chat.id}: ${err.message}`);
        return { ok: false, reason: 'could not read messages from WAHA' };
      }
    }

    // Oldest first, so sheet rows stay in the order the messages were sent.
    all.sort((a, b) => (toSeconds(a.message.timestamp) || 0) - (toSeconds(b.message.timestamp) || 0));

    const counts = { tracked: 0, updated: 0, skipped: 0, duplicate: 0, failed: 0 };
    let blockedAt = null; // earliest message that could not be finished

    for (const { chatId, message } of all) {
      const ts = toSeconds(message.timestamp) || startedAt;

      if (isDone(message.id)) {
        counts.duplicate++;
        console.log(`[catch-up] 🔁 DUPLICATE — message ${message.id} (chat ${chatId}) was already handled, skipping.`);
        continue;
      }

      // Ask WAHA to save the image right now, so the download is fresh.
      let msg = message;
      if (message.hasMedia && !(message.media?.url || message.media?.data)) {
        const full = await fetchMessageWithMedia(chatId, message.id);
        if (full?.media) msg = { ...message, media: full.media };
      }

      try {
        const result = await processWithRetry(msg, {
          source: 'catchup',
          session: sessionName(),
          chatIdOverride: chatId,
          skipStatusReplies: firstRun,
        });

        if (result.status === 'in_progress') {
          blockedAt = blockedAt === null ? ts : Math.min(blockedAt, ts);
        } else if (result.status in counts) {
          counts[result.status]++;
        }
        if (result.status === 'tracked' || result.status === 'updated') {
          await sleep(DELAY_BETWEEN_ROWS_MS);
        }
      } catch (err) {
        counts.failed++;
        blockedAt = blockedAt === null ? ts : Math.min(blockedAt, ts);
        console.error(`❌ [catch-up] gave up on message ${message.id}: ${err.message} (will retry on the next run)`);
      }
    }

    // Move the "checked up to" marker forward — but never past a failed message.
    setWatermark(blockedAt !== null ? blockedAt - 1 : startedAt);
    flushState();

    console.log(
      `✅ CATCH-UP DONE — new rows: ${counts.tracked}, status updates: ${counts.updated}, ` +
      `already tracked: ${counts.duplicate}, not issues: ${counts.skipped}, failed: ${counts.failed}`
    );
    console.log('══════════════════════════════════════════\n');

    return { ok: counts.failed === 0, tracked: counts.tracked };
  } catch (err) {
    if (err instanceof WahaError) explainWahaProblem(err);
    else console.error(`❌ [catch-up] error: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    running = false;
  }
}

/**
 * Starts the background watcher. Call once, after the web server is listening.
 * Checks WAHA every 10 s; the moment WhatsApp is connected (e.g. after you
 * start Docker) it runs a catch-up.
 */
export function startCatchUpScheduler() {
  if ((process.env.CATCHUP_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('ℹ️  Catch-up is disabled (CATCHUP_ENABLED=false).');
    return;
  }

  const savedWatermark = getWatermark();
  console.log(
    savedWatermark
      ? `🕒 Last catch-up checked up to ${new Date(savedWatermark * 1000).toLocaleString()} (${knownIdCount()} messages remembered).`
      : '🕒 First start with catch-up — will look back over recent messages once WAHA is connected.'
  );

  const intervalMs = envNumber('CATCHUP_INTERVAL_MINUTES', 15) * 60 * 1000;
  const POLL_MS = 10 * 1000;
  const SETTLE_MS = 20 * 1000; // give WhatsApp a moment to finish syncing after connecting
  const FOLLOW_UP_MS = 2 * 60 * 1000;
  const RETRY_MS = 60 * 1000;

  let lastStatus = 'first-check';
  let nextRunAt = 0;
  let afterConnect = false; // true until the first catch-up after (re)connecting is done
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const status = await getSessionStatus();

      if (status !== lastStatus) {
        if (status === null) console.log('⏳ WAHA is not reachable (is Docker running?). Waiting...');
        else if (status === 'WORKING') console.log('🟢 WAHA / WhatsApp is connected.');
        else console.log(`⏳ WAHA session status: ${status}. Waiting for WORKING...`);
      }

      if (status === 'WORKING') {
        if (lastStatus !== 'WORKING') {
          // Just connected (Docker started / WhatsApp reconnected).
          afterConnect = true;
          nextRunAt = Date.now() + SETTLE_MS;
        }

        if (Date.now() >= nextRunAt) {
          const result = await runCatchUp(afterConnect ? 'startup / reconnect' : 'periodic check');
          // After connecting, look once more shortly (WhatsApp may still be
          // syncing); after that, fall back to the normal interval.
          const wait = !result.ok ? RETRY_MS : (afterConnect ? FOLLOW_UP_MS : intervalMs);
          if (result.ok) afterConnect = false;
          nextRunAt = Date.now() + wait;
        }
      }
      lastStatus = status;
    } catch (err) {
      console.error(`❌ [catch-up scheduler] ${err.message}`);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, POLL_MS);
  tick();
}
