import { google } from 'googleapis';
import FormData from 'form-data';
import fetch from 'node-fetch';
import { rawId, isInflight } from './stateStore.js';

// ─────────────────────────────────────────────────────────────────────────
// Google Sheets writer.
//
// What changed compared with the original (behaviour of the sheet is the
// same — same columns, same formulas, same dropdowns):
//
//  1. ONE ordered write queue. Every issue goes into a FIFO queue and a
//     single worker appends them. Rows that are waiting together are sent
//     as ONE append call (atomic, in arrival order). This is what stops
//     rapid/concurrent messages from racing each other, getting rows out
//     of order, or hitting Google's per-minute request quota.
//  2. The row is written FIRST. The image is downloaded / uploaded to
//     ImgBB afterwards in the background and its link is added to column F
//     as soon as it is ready — a slow image can no longer delay the issue
//     (or the issues queued behind it).
//  3. Dropdowns are applied off the critical path, batched, with the sheet
//     id cached (the original did 2 extra API calls for EVERY row).
//  4. Every Google call retries with back-off on 429 / 5xx / network
//     errors. A retry first checks column I, so a row whose reply was lost
//     is never written twice.
//  5. "Not an issue" is now part of the Status dropdown.
// ─────────────────────────────────────────────────────────────────────────

const TAB = 'Parsed Issues';
const q = `'${TAB}'`; // quoted tab name for A1 ranges

export const STATUS_VALUES = ['New', 'Open', 'Assigned', 'Re-Test', 'Fixed', 'Resolved', 'Bug', 'Not an issue'];
export const EMPLOYEE_VALUES = ['Bala', 'Vignesh', 'Vishali', 'Kishore', 'Rukmani', 'Cini Priya'];

const MAX_BATCH_ROWS = 25;     // rows sent in one append call
const MAX_WRITE_ATTEMPTS = 5;  // per batch, with back-off between attempts
const IMAGE_PARALLEL = 3;      // simultaneous image uploads

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});

// ── test hooks (used only by test/*.js) ──────────────────────────────────
let imageUploader = null;
export function __setSheetsClientForTests(client) { sheets = client; sheetIdCache = null; }
export function __setImageUploaderForTests(fn) { imageUploader = fn; }

const spreadsheetId = () => process.env.SPREADSHEET_ID;

// ── retry helper ─────────────────────────────────────────────────────────
function httpStatus(err) {
  const s = err?.response?.status ?? err?.status ?? err?.code;
  return typeof s === 'number' ? s : Number(s) || 0;
}

export function isRetryable(err) {
  const status = httpStatus(err);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err?.message || '');
  if (status === 403 && /rate ?limit|quota|too many/i.test(msg)) return true;
  const code = String(err?.code || err?.cause?.code || '');
  if (/^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ECONNABORTED|ENETUNREACH)$/.test(code)) return true;
  return /socket hang up|timeout|timed out|network|fetch failed|ECONNRESET|quota exceeded/i.test(msg);
}

function backoffMs(attempt, err) {
  const retryAfter = Number(err?.response?.headers?.['retry-after']);
  const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
  return Math.min(30000, base) + Math.floor(Math.random() * 300);
}

async function withRetry(label, fn, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || i >= attempts - 1) throw err;
      const wait = backoffMs(i, err);
      console.warn(`⚠️  Google Sheets (${label}) failed: ${err.message} — retrying in ${(wait / 1000).toFixed(1)}s (${i + 1}/${attempts - 1})`);
      await sleep(wait);
    }
  }
}

// ── image upload (unchanged behaviour) ───────────────────────────────────
function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // WEBP
  return false;
}

/**
 * Uploads an image Buffer to ImgBB and returns a direct, always-renders
 * image URL (not the ibb.co viewer page).
 */
async function uploadToImgBB(imageBuffer) {
  if (!imageBuffer) return null;
  if (imageUploader) return imageUploader(imageBuffer);

  if (!looksLikeImage(imageBuffer)) {
    console.error('❌ Refusing to upload to ImgBB: buffer does not look like a valid image (would have produced a broken ImgBB link).');
    return null;
  }

  try {
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      console.error('❌ IMGBB_API_KEY missing in .env');
      return null;
    }

    const form = new FormData();
    form.append('image', imageBuffer.toString('base64'));

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45000),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      console.error(`❌ ImgBB returned a non-JSON response (HTTP ${response.status})`);
      return null;
    }

    if (data.success) return data.data.display_url || data.data.url || data.data.url_viewer;
    console.error(`❌ ImgBB Upload Error (HTTP ${response.status}):`, JSON.stringify(data.error || data));
    return null;
  } catch (err) {
    console.error('❌ Failed to upload image to ImgBB:', err.message);
    return null;
  }
}

// ── sheet id + dropdowns ─────────────────────────────────────────────────
let sheetIdCache = null;

async function loadSheetMeta() {
  const meta = await withRetry('sheet info', () =>
    sheets.spreadsheets.get({ spreadsheetId: spreadsheetId(), fields: 'sheets.properties' })
  );
  const tab = (meta.data.sheets || []).find((s) => s.properties?.title === TAB);
  const sheetId = tab ? tab.properties.sheetId : 0;
  sheetIdCache = sheetId;
  return { sheetId, rowCount: tab?.properties?.gridProperties?.rowCount || 1000 };
}

async function getSheetId() {
  if (sheetIdCache !== null) return sheetIdCache;
  return (await loadSheetMeta()).sheetId;
}

// Whole column from row 2 down to the END of the sheet (no endRowIndex = unbounded),
// so every existing row, blank row and later-added row gets the dropdown.
function columnValidationRequest(sheetId, col, values, strict) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict,
      },
    },
  };
}

function validationRequest(sheetId, firstRow, lastRow, col, values, strict) {
  return {
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: firstRow - 1,
        endRowIndex: lastRow, // exclusive, 0-based  ==  lastRow inclusive, 1-based
        startColumnIndex: col,
        endColumnIndex: col + 1,
      },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict,
      },
    },
  };
}

let refreshing = false;
let refreshAgain = false;
let refreshTimer = null;

/**
 * Applies the dropdowns to the WHOLE Status (G) and Employees (H) columns:
 * every existing row, and every row added later. Status list =
 * New, Open, Assigned, Re-Test, Fixed, Resolved, Bug, Not an issue.
 * Safe to call any time; calls are merged, and it retries on Google errors.
 */
export async function refreshDropdowns() {
  if (refreshing) { refreshAgain = true; return false; }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const sheetId = await getSheetId();
      await withRetry('dropdowns', () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId(),
          requestBody: {
            requests: [
              columnValidationRequest(sheetId, 6, STATUS_VALUES, true),    // Column G (Status)
              columnValidationRequest(sheetId, 7, EMPLOYEE_VALUES, false), // Column H (Employees)
            ],
          },
        }),
        6
      );
    } while (refreshAgain);
    return true;
  } catch (err) {
    console.error('⚠️ Could not apply dropdown validations (will try again shortly):', err.message);
    setTimeout(() => refreshDropdowns().catch(() => {}), 20000).unref?.();
    return false;
  } finally {
    refreshing = false;
  }
}

/** Run at start-up (and by the safety timer in server.js). */
export async function prepareSheet() {
  await loadSheetMeta();
  const ok = await refreshDropdowns();
  if (!ok) throw new Error('dropdown update did not complete');
}

// After rows are added, re-apply the dropdown to the whole column shortly
// afterwards (merged into one call) — a row can therefore never be left
// with just a plain "New" cell and no dropdown.
function queueDropdowns() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshDropdowns().catch(() => {});
  }, 400);
}

// ── reading message ids from column I ────────────────────────────────────
/** Map of rawId(messageId) → 1-based row number, from Column I. */
async function readMessageIdRows() {
  const res = await withRetry('read message ids', () =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${q}!I:I` })
  );
  const map = new Map();
  (res.data.values || []).forEach((row, i) => {
    const key = rawId(row?.[0]);
    if (key && !map.has(key)) map.set(key, i + 1);
  });
  return map;
}

/**
 * Returns every WhatsApp message ID already stored in the sheet (Column I).
 * Used by the catch-up so messages that were already tracked earlier are
 * never added a second time.
 */
export async function getTrackedMessageIds() {
  const response = await withRetry('read message ids', () =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${q}!I:I` })
  );
  return (response.data.values || []).map((row) => row[0]).filter(Boolean);
}

// ── ordered append queue ─────────────────────────────────────────────────
const appendQueue = [];
let draining = false;
let idleWaiters = [];
// Messages whose last write ended in an unknown state (error after the
// request may already have landed) → verified against column I before the
// next write so they can never be added twice.
const suspectIds = new Set();

/**
 * Call for a message that MIGHT already be in the sheet (e.g. recovered after
 * a crash): its next write is checked against column I first.
 */
export function markMaybeWritten(messageId) {
  const key = rawId(messageId);
  if (key) suspectIds.add(key);
}

/** Resolves once every row queued so far has been written (or failed). */
export function whenAppendsIdle() {
  if (!draining && appendQueue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * Adds one issue to the sheet. Resolves with { row } once the row is in the
 * sheet. `imageBuffer` may be a Buffer, a function returning a Promise of a
 * Buffer (downloaded in the background), or null.
 *
 * Column A gets =ROW()-1 so numbering is race-free (see original note).
 */
export function appendToSheet(parsedData, imageBuffer, mimeType, messageId, logTag = '') {
  return new Promise((resolve, reject) => {
    const key = rawId(messageId);
    appendQueue.push({
      parsedData, image: imageBuffer, mimeType, messageId, logTag,
      verifyFirst: Boolean(key && suspectIds.has(key)),
      resolve, reject,
    });
    if (!draining) drain();
  });
}

function buildRow(job) {
  const d = job.parsedData;
  return [
    '=ROW()-1',                         // Column A: SNO (auto, race-free)
    d.date || 'N/A',                    // Column B: DATE
    d.studio || 'N/A',                  // Column C: STUDIOS
    d.student_code_or_phone || 'N/A',   // Column D: STUDENT CODE / PHONE
    d.issue_description || 'N/A',       // Column E: ISSUE
    'N/A',                              // Column F: IMAGE (link is added in the background)
    'New',                              // Column G: STATUS (Default: New)
    '',                                 // Column H: EMPLOYEES
    job.messageId || '',                // Column I: Message ID
  ];
}

async function drain() {
  draining = true;
  try {
    while (appendQueue.length) {
      const batch = appendQueue.splice(0, MAX_BATCH_ROWS);
      try {
        await writeBatch(batch);
      } catch (err) {
        // never let one bad batch kill the worker
        for (const job of batch) job.reject(err);
      }
    }
  } finally {
    draining = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }
}

function finishJob(job, row) {
  const key = rawId(job.messageId);
  if (key) suspectIds.delete(key);
  job.resolve({ row });
  if (job.image) scheduleImage(job, row);
}

async function writeBatch(batch) {
  let pending = batch.slice();
  let lastErr = null;
  const landed = []; // rows (1-based) written by this batch

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS && pending.length; attempt++) {
    const mustVerify = attempt > 0 || pending.some((j) => j.verifyFirst);

    if (attempt > 0) await sleep(backoffMs(attempt - 1, lastErr));

    if (mustVerify) {
      // A failed request may still have landed. Never write blind.
      try {
        const existing = await readMessageIdRows();
        pending = pending.filter((job) => {
          const row = job.messageId ? existing.get(rawId(job.messageId)) : null;
          if (!row) return true;
          console.log(`${job.logTag}🔁 Row for ${job.messageId} is already in the sheet (row ${row}) — not writing it twice.`);
          finishJob(job, row);
          return false;
        });
        if (!pending.length) return;
      } catch (err) {
        lastErr = err;
        continue; // can't verify right now → wait and try again rather than risk a duplicate
      }
    }

    try {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId(),
        range: `${q}!A:I`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: pending.map(buildRow) },
      });

      // e.g. "'Parsed Issues'!A93:I95"  → first row 93
      const m = String(res?.data?.updates?.updatedRange || '').match(/!\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?/);
      const first = m ? parseInt(m[1], 10) : null;

      pending.forEach((job, i) => {
        const row = first ? first + i : null;
        if (row) landed.push(row);
        finishJob(job, row);
      });
      pending = [];
      queueDropdowns();
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) break;
      console.warn(`⚠️  Google Sheets append failed: ${err.message} (attempt ${attempt + 1}/${MAX_WRITE_ATTEMPTS})`);
    }
  }

  // Gave up on whatever is left: remember them as "unknown state".
  for (const job of pending) {
    const key = rawId(job.messageId);
    if (key) suspectIds.add(key);
    job.reject(lastErr || new Error('Google Sheets write failed'));
  }
  if (landed.length) queueDropdowns();
}

// ── background image step ────────────────────────────────────────────────
let imageActive = 0;
const imageWaiting = [];

function scheduleImage(job, row) {
  imageWaiting.push({ job, row });
  pumpImages();
}

function pumpImages() {
  while (imageActive < IMAGE_PARALLEL && imageWaiting.length) {
    const { job, row } = imageWaiting.shift();
    imageActive++;
    attachImage(job, row)
      .catch((err) => console.error(`${job.logTag}⚠️  Image step failed: ${err.message} — the issue row itself is already saved.`))
      .finally(() => { imageActive--; pumpImages(); });
  }
}

async function locateRow(job, hintRow) {
  if (!job.messageId) return hintRow;
  const want = rawId(job.messageId);
  if (hintRow) {
    const res = await withRetry('check row', () =>
      sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `${q}!I${hintRow}:I${hintRow}` })
    );
    if (rawId(res.data.values?.[0]?.[0]) === want) return hintRow;
  }
  // rows were inserted/sorted meanwhile → look it up
  return (await readMessageIdRows()).get(want) || null;
}

async function attachImage(job, hintRow) {
  let buffer = job.image;
  if (typeof buffer === 'function') buffer = await buffer();
  if (!buffer) return; // download failed → row stays "N/A", same as before

  console.log(`${job.logTag}📤 Uploading image to ImgBB...`);
  const url = await uploadToImgBB(buffer);
  if (!url) {
    console.warn(`${job.logTag}⚠️  Image could not be uploaded — the issue row stays saved without an image link.`);
    return;
  }

  const row = await locateRow(job, hintRow);
  if (!row) {
    console.warn(`${job.logTag}⚠️  Could not find the row again to add the image link.`);
    return;
  }
  await withRetry('image link', () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${q}!F${row}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[`=HYPERLINK("${url}", "📷 View")`]] },
    })
  );
  console.log(`${job.logTag}🖼️  Image link added to row ${row}`);
}

// ── status updates from replies ──────────────────────────────────────────
let statusChain = Promise.resolve();

/**
 * Updates status column when a reply matches an original message ID.
 * Waits for rows that are still queued, so a quick "Fixed" reply can never
 * overtake the issue it refers to. Matching uses the unique part of the id
 * so it works whichever id format WAHA sends.
 */
export function updateStatusByMessageId(messageId, newStatus) {
  const run = statusChain.then(() => doStatusUpdate(messageId, newStatus));
  statusChain = run.catch(() => {});
  return run;
}

async function doStatusUpdate(messageId, newStatus) {
  const want = rawId(messageId);
  for (let attempt = 0; attempt < 4; attempt++) {
    await whenAppendsIdle();
    const row = (await readMessageIdRows()).get(want);
    if (row) {
      await withRetry('status update', () =>
        sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId(),
          range: `${q}!G${row}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[newStatus]] },
        })
      );
      return true;
    }
    if (!isInflight(messageId)) return false; // genuinely not a tracked issue
    await sleep(1000); // the original issue is still being saved — look again
  }
  throw new Error('the original issue is still being saved; will retry this status update');
}
