// services/messageProcessor.js
//
// ONE place that decides what to do with a WhatsApp message.
// Used by:
//   - the live webhook   (server.js)      → messages that arrive while the server is on
//   - the catch-up job   (catchUp.js)     → messages that arrived while it was off
//
// Because both paths use the same code and the same "already handled" list
// (stateStore), a message can never be written to the sheet twice.
//
// Every message this function sees prints exactly one outcome line to the
// terminal — TRACKED, STATUS UPDATED, SKIPPED (with a reason), or DUPLICATE —
// for both live and catch-up messages, so nothing that arrives is silent.

import { parseIssueMessage } from './messageParser.js';
import { appendToSheet, updateStatusByMessageId } from './sheetsService.js';
import { isIgnoredReply } from '../config/ignoredReplies.js';
import { detectStatusUpdate } from '../config/statusRules.js';
import { downloadMediaWithRetry, looksLikeImage } from './mediaService.js';
import { claimMessage, markDone, releaseMessage, rawId } from './stateStore.js';
import { toSeconds } from './wahaClient.js';

// Only digits, e.g. "918925928564"
const TARGET_NUMBER = (process.env.TARGET_NUMBER || '').replace(/\D/g, '');
const digits = (jid) => (jid || '').replace(/\D/g, '');

/**
 * The clock time (IST) the message actually arrived in WhatsApp — not the
 * time it happens to get processed (which, after a weekend/off-hours catch
 * -up, could be a day later). Falls back to "now" only if WAHA genuinely
 * didn't send a timestamp.
 */
function arrivalTimeIST(message) {
  const secs = toSeconds(message.timestamp) || Math.floor(Date.now() / 1000);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(secs * 1000));
}

function preview(text, max = 60) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Prints the "Message received" block. The webhook calls this the instant a
 * message arrives (before anything is queued or written), so every private
 * message shows up in the VS Code terminal immediately.
 */
export function logIncoming(message, { tag = '', chatIdOverride } = {}) {
  const textContent = message.body || message.caption || '';
  const chatId = chatIdOverride || message.from || message.chatId || '';
  const toId = message.to || '';
  const isGroupChat = chatId.endsWith('@g.us');
  const isReply = Boolean(message.replyTo && message.replyTo.id);

  let numberNote = '';
  if (TARGET_NUMBER && !isGroupChat) {
    const toNumber = digits(toId);
    numberNote = !toNumber || toNumber === TARGET_NUMBER
      ? `   Tracked number ${TARGET_NUMBER}: ✅ yes`
      : `   Tracked number ${TARGET_NUMBER}: ❌ message was sent to ${toNumber}`;
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`📩 ${tag}[${new Date().toISOString()}] Message received`);
  console.log(`   Chat: ${chatId || 'unknown'} ${isGroupChat ? '(group)' : '(individual)'}`);
  console.log(`   To: ${toId || 'unknown'}`);
  console.log(`   Author: ${message.author || chatId || 'unknown'}`);
  console.log(`   Text: "${preview(textContent, 200)}"`);
  console.log(`   hasMedia: ${Boolean(message.hasMedia)}`);
  console.log(`   isReply: ${isReply}`);
  if (numberNote) console.log(numberNote);
}

/**
 * @param {object} message   WhatsApp message (webhook payload or REST history item)
 * @param {object} opts
 * @param {string} [opts.source]            'webhook' | 'catchup'
 * @param {string} [opts.session]           WAHA session name
 * @param {string} [opts.chatIdOverride]    chat id when the message object lacks "from"
 * @param {boolean} [opts.skipStatusReplies] ignore "Fixed/Done" replies (first-ever catch-up)
 * @param {boolean} [opts.alreadyLogged]    the "Message received" block was already printed
 * @returns {Promise<{status: string, reason?: string}>}
 *   status: 'tracked' | 'updated' | 'skipped' | 'duplicate' | 'in_progress'
 *   Throws if something failed and the message should be retried later.
 */
export async function processIncomingMessage(message, opts = {}) {
  const { source = 'webhook', session, chatIdOverride, skipStatusReplies = false, alreadyLogged = false } = opts;
  // Short id in every line, so lines of rapid, overlapping messages can be told apart.
  const shortId = rawId(message.id).slice(-6);
  const tag = `${source === 'catchup' ? '[catch-up] ' : ''}${shortId ? `[#${shortId}] ` : ''}`;

  const claim = claimMessage(message.id);
  if (claim === 'done') {
    console.log(`${tag}🔁 DUPLICATE — message ${message.id} was already handled, skipping.`);
    return { status: 'duplicate' };
  }
  if (claim === 'inflight') {
    console.log(`${tag}⏳ IN PROGRESS — message ${message.id} is already being handled elsewhere right now.`);
    return { status: 'in_progress' };
  }

  try {
    const result = await handle(message, { source, session, chatIdOverride, skipStatusReplies, tag, alreadyLogged });
    markDone(message.id);
    return result;
  } catch (err) {
    releaseMessage(message.id); // allow a later retry
    console.error(`${tag}❌ FAILED — message ${message.id}: ${err.message} (will be retried)`);
    throw err;
  }
}

async function handle(message, { source, session, chatIdOverride, skipStatusReplies, tag, alreadyLogged }) {
  const textContent = message.body || message.caption || '';
  const chatId = chatIdOverride || message.from || message.chatId || '';
  const toId = message.to || '';
  const isGroupChat = chatId.endsWith('@g.us');
  const isReply = Boolean(message.replyTo && message.replyTo.id);

  if (!alreadyLogged) logIncoming(message, { tag, chatIdOverride });

  // 0) Messages WE sent (e.g. typed manually on the linked phone) are not
  // customer issues.
  if (message.fromMe) {
    console.log(`${tag}⏭️  SKIPPED — message was sent by us (fromMe), not received from a customer.`);
    return { status: 'skipped', reason: 'outgoing message (fromMe)' };
  }

  // 1) Private chats only.
  if (isGroupChat) {
    console.log(`${tag}⏭️  SKIPPED — message is from a WhatsApp group; groups are not tracked.`);
    return { status: 'skipped', reason: 'group chats are not tracked' };
  }

  // 2) Make sure it was sent to OUR number (only checkable when "to" exists).
  if (TARGET_NUMBER) {
    const toNumber = digits(toId);
    if (toNumber && toNumber !== TARGET_NUMBER) {
      console.log(`${tag}⏭️  SKIPPED — not sent to the tracked number (${TARGET_NUMBER}).`);
      return { status: 'skipped', reason: 'not the tracked number' };
    }
  }

  // 3) Replies like "Fixed" / "Done" update an existing row.
  if (isReply) {
    if (skipStatusReplies) {
      console.log(`${tag}⏭️  SKIPPED — status replies are ignored on the very first catch-up run.`);
      return { status: 'skipped', reason: 'status replies are skipped on the very first catch-up' };
    }
    const newStatus = detectStatusUpdate(textContent);
    if (!newStatus) {
      console.log(`${tag}⏭️  SKIPPED — reply text did not match a status keyword.`);
      return { status: 'skipped', reason: 'reply not a status keyword' };
    }
    console.log(`${tag}🔎 Looking for tracked row matching message ID: ${message.replyTo.id}`);
    const updated = await updateStatusByMessageId(message.replyTo.id, newStatus);
    if (updated) {
      console.log(`${tag}✅ STATUS UPDATED → "${newStatus}" for message ${message.replyTo.id}`);
      return { status: 'updated', newStatus };
    }
    console.log(`${tag}⏭️  SKIPPED — reply matched a status keyword, but the original message wasn't tracked.`);
    return { status: 'skipped', reason: 'reply did not match a tracked row' };
  }

  // 4) Chit-chat like "ok", "thanks".
  if (isIgnoredReply(textContent)) {
    console.log(`${tag}⏭️  SKIPPED — matched ignored chit-chat phrase.`);
    return { status: 'skipped', reason: 'ignored reply/comment' };
  }

  // 5) Must contain DATE + STUDIO + STUDENT CODE / PHONE.
  const parsedData = parseIssueMessage(textContent);
  if (!parsedData) {
    console.log(`${tag}⏭️  SKIPPED — message is missing Date / Studio / Student Code or Phone Number.`);
    return { status: 'skipped', reason: 'missing date, studio or student code/phone' };
  }

  // The DATE column = the date the user typed + the actual clock time the
  // message arrived in WhatsApp (IST) — not whenever it happens to get
  // processed (which can be a day later after an off-hours catch-up).
  const arrivalTime = arrivalTimeIST(message);
  parsedData.date = parsedData.date && parsedData.date !== 'N/A'
    ? `${parsedData.date} ${arrivalTime}`
    : arrivalTime;

  // 6) Image (optional). A failed image never blocks the row. Inline images
  // are decoded right now (instant); images that must be downloaded from
  // WAHA are fetched AFTER the row is saved (see sheetsService), so a slow
  // download can never delay this issue or the ones queued behind it.
  let image = null;

  const inlineBase64 = message.media?.data || message.mediaData || null;
  const mediaUrl = message.media?.url || message.mediaUrl || null;

  if (message.hasMedia && inlineBase64) {
    try {
      const raw = inlineBase64.includes(',') ? inlineBase64.split(',').pop() : inlineBase64;
      const buffer = Buffer.from(raw, 'base64');
      if (!looksLikeImage(buffer)) throw new Error('Decoded media.data does not look like a valid image.');
      image = buffer;
      console.log(`${tag}✅ Image decoded from inline base64 (${buffer.length} bytes)`);
    } catch (mediaError) {
      console.error(`${tag}❌ INLINE MEDIA DECODE FAILED: ${mediaError.message}`);
      image = null;
    }
  } else if (message.hasMedia && mediaUrl) {
    console.log(`${tag}⬇️  Image will be fetched from WAHA right after the row is saved: ${mediaUrl}`);
    image = async () => {
      const media = await downloadMediaWithRetry({
        mediaUrl,
        messageId: message.id,
        chatId,
        session: session || process.env.WAHA_SESSION,
      });
      return media ? media.buffer : null;
    };
  } else if (message.hasMedia) {
    console.warn(`${tag}⚠️  hasMedia=true but no image data/url was available — saving the issue without an image.`);
  }

  // 7) Write the row.
  console.log(`${tag}📝 Writing entry to Google Sheet...`);
  await appendToSheet(parsedData, image, null, message.id, tag);
  console.log(
    `${tag}✅ TRACKED — Date: ${parsedData.date}, Studio: ${parsedData.studio}, ` +
    `Student/Phone: ${parsedData.student_code_or_phone}`
  );

  return { status: 'tracked', data: parsedData };
}
