// services/stateStore.js
//
// Remembers two things between restarts (saved in data/state.json):
//   1) WATERMARK  – "everything up to this time has been checked".
//                   On the next start, catch-up only looks at messages newer
//                   than this, so the weekend/off-hours messages are found.
//   2) DONE IDS   – WhatsApp message IDs that were already handled, so the
//                   same message is never written to the sheet twice
//                   (live webhook + catch-up can both see the same message).
//
// Nothing here talks to WhatsApp or Google — it is just a small local file.

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_IDS = 20000; // keep the file small; oldest IDs are dropped first

const doneIds = new Set();     // fully handled
const inflightIds = new Set(); // being handled right now
let watermark = null;          // unix seconds, or null on the very first run
let saveTimer = null;

/**
 * WhatsApp message ids look like  false_43100634349658@lid_3EB0AB12...
 * The webhook and the REST history API can format the front part slightly
 * differently, so we compare only the unique key part (3EB0AB12...).
 */
export function rawId(id) {
  if (!id) return '';
  const parts = String(id).split('_');
  return parts.length >= 3 ? parts[2] : String(id);
}

export function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Number.isFinite(saved.watermark)) watermark = saved.watermark;
      for (const id of saved.doneIds || []) doneIds.add(id);
    }
  } catch (err) {
    console.warn(`⚠️  Could not read ${STATE_FILE} (${err.message}) — starting with a clean state.`);
  }
  return { watermark, knownIds: doneIds.size };
}

function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ watermark, savedAt: new Date().toISOString(), doneIds: [...doneIds] })
    );
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error(`⚠️  Could not save state file: ${err.message}`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 500);
}

export function flushState() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeNow();
}

// Save when you press Ctrl+C in the VS Code terminal.
process.on('SIGINT', () => { flushState(); process.exit(0); });
process.on('SIGTERM', () => { flushState(); process.exit(0); });

export function knownIdCount() {
  return doneIds.size;
}

export function getWatermark() {
  return watermark;
}

export function setWatermark(ts) {
  watermark = ts;
  scheduleSave();
}

/** Add IDs already present in the Google Sheet (Column I) as "done". */
export function seedDoneIds(ids) {
  let added = 0;
  for (const id of ids) {
    const key = rawId(id);
    if (key && !doneIds.has(key)) {
      doneIds.add(key);
      added++;
    }
  }
  trim();
  scheduleSave();
  return added;
}

export function isDone(id) {
  return doneIds.has(rawId(id));
}

/** True while some part of the app is still handling this message. */
export function isInflight(id) {
  return inflightIds.has(rawId(id));
}

/**
 * Try to take ownership of a message.
 *   'new'      – go ahead and process it
 *   'done'     – already handled earlier, skip
 *   'inflight' – another part of the app is handling it right now
 */
export function claimMessage(id) {
  if (!id) return 'new';
  const key = rawId(id);
  if (doneIds.has(key)) return 'done';
  if (inflightIds.has(key)) return 'inflight';
  inflightIds.add(key);
  return 'new';
}

export function markDone(id) {
  if (!id) return;
  const key = rawId(id);
  inflightIds.delete(key);
  doneIds.add(key);
  trim();
  scheduleSave();
}

/** Processing failed — let it be retried later. */
export function releaseMessage(id) {
  if (!id) return;
  inflightIds.delete(rawId(id));
}

function trim() {
  while (doneIds.size > MAX_IDS) {
    doneIds.delete(doneIds.values().next().value);
  }
}
