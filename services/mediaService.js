// services/mediaService.js
//
// Downloads the image attached to a WhatsApp message from WAHA — reliably.
//
// Why the old code failed with "HTTP 404 ... ENOENT ... index.html":
// WAHA sends the webhook the moment the message arrives, and puts a
// media.url in it, but the image file is often NOT written to WAHA's disk
// yet at that instant. Requesting the URL immediately gives a 404 (WAHA's
// file server then falls back to index.html, which is the ENOENT text you
// saw). A few seconds later the very same URL works.
//
// What this module does about it:
//   1. Retries the download several times with a growing delay.
//   2. From the 2nd attempt on, it also asks WAHA for a fresh copy of the
//      message (?downloadMedia=true) which forces WAHA to save the file and
//      returns the current media URL.
//   3. Rewrites the host of the media URL to WAHA_API_URL from .env, so a
//      URL like http://localhost:3000/... still works if WAHA runs elsewhere.
//   4. Never throws for "image not available" — returns null instead, so the
//      issue row is ALWAYS saved to the sheet (just without the image link).

const RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000]; // waits between attempts
const REQUEST_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 12) return false;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true; // GIF
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return true; // WEBP
  return false;
}

function authHeaders() {
  const apiKey = process.env.WAHA_API_KEY;
  return apiKey ? { 'X-Api-Key': apiKey } : {};
}

function wahaBase() {
  return (process.env.WAHA_API_URL || '').trim().replace(/\/+$/, '');
}

// Point the media URL at the WAHA address configured in .env.
function rewriteToWahaHost(mediaUrl) {
  const base = wahaBase();
  if (!base) return mediaUrl;
  try {
    const u = new URL(mediaUrl);
    const b = new URL(base);
    u.protocol = b.protocol;
    u.host = b.host;
    return u.toString();
  } catch {
    return mediaUrl;
  }
}

class MediaError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function downloadOnce(url) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: authHeaders() });
  } catch (err) {
    throw new MediaError(`network error: ${err.message}`);
  }

  if (!response.ok) {
    const auth = response.status === 401 || response.status === 403;
    throw new MediaError(
      auth
        ? `HTTP ${response.status} — WAHA_API_KEY in .env does not match the key WAHA was started with.`
        : `HTTP ${response.status} ${response.statusText}`,
      { status: response.status, retryable: !auth }
    );
  }

  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());

  // WAHA can answer 200 with an HTML page (index.html) when the file is not
  // there yet — treat that exactly like "not ready", not as an image.
  if (!looksLikeImage(buffer)) {
    throw new MediaError(`response is not an image yet (content-type: ${contentType})`);
  }

  return { buffer, mimeType: contentType.startsWith('image/') ? contentType.split(';')[0] : null };
}

// Asks WAHA for the message again with downloadMedia=true. This makes WAHA
// save the file to disk (if it hasn't) and returns the up-to-date media URL.
async function refreshMediaInfo({ session, chatId, messageId }) {
  const base = wahaBase();
  if (!base || !session || !chatId || !messageId) return null;

  const url =
    `${base}/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}` +
    `/messages/${encodeURIComponent(messageId)}?downloadMedia=true`;

  try {
    const response = await fetchWithTimeout(url, { headers: authHeaders() });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.media || null;
  } catch {
    return null;
  }
}

function decodeInlineBase64(data) {
  try {
    const raw = data.includes(',') ? data.split(',').pop() : data;
    const buffer = Buffer.from(raw, 'base64');
    return looksLikeImage(buffer) ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the image for a message.
 *
 * @param {object} p
 * @param {string} p.mediaUrl   media.url from the webhook payload
 * @param {string} [p.messageId] message id (for the WAHA re-fetch fallback)
 * @param {string} [p.chatId]    chat id   (for the WAHA re-fetch fallback)
 * @param {string} [p.session]   WAHA session name (default "default")
 * @returns {Promise<{buffer: Buffer, mimeType: string|null} | null>}
 *          null when the image could not be obtained (row is still saved).
 */
export async function downloadMediaWithRetry({ mediaUrl, messageId, chatId, session }) {
  if (!process.env.WAHA_API_KEY) {
    console.warn('⚠️  WAHA_API_KEY is not set in .env — sending an unauthenticated request.');
  }

  const sessionName =
    session ||
    process.env.WAHA_SESSION ||
    (mediaUrl && (mediaUrl.match(/\/api\/files\/([^/]+)\//) || [])[1]) ||
    'default';

  let currentUrl = rewriteToWahaHost(mediaUrl);
  let lastError = null;
  const totalAttempts = RETRY_DELAYS_MS.length + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const result = await downloadOnce(currentUrl);
      console.log(`✅ Image downloaded (${result.buffer.length} bytes)${attempt > 1 ? ` on attempt ${attempt}` : ''}`);
      return result;
    } catch (err) {
      lastError = err;
      if (!err.retryable) break;

      if (attempt < totalAttempts) {
        console.log(`⏳ Image not ready yet (${err.message}) — retry ${attempt}/${RETRY_DELAYS_MS.length}...`);
        await sleep(RETRY_DELAYS_MS[attempt - 1]);

        // From the 2nd attempt on, ask WAHA to (re)save the file and give us
        // the fresh URL / data.
        if (attempt >= 2) {
          const media = await refreshMediaInfo({ session: sessionName, chatId, messageId });
          if (media?.data) {
            const buffer = decodeInlineBase64(media.data);
            if (buffer) {
              console.log(`✅ Image received from WAHA message lookup (${buffer.length} bytes)`);
              return { buffer, mimeType: media.mimetype || null };
            }
          }
          if (media?.url) currentUrl = rewriteToWahaHost(media.url);
        }
      }
    }
  }

  console.warn(
    `⚠️  Image could not be downloaded (${lastError ? lastError.message : 'unknown reason'}). ` +
    `The issue will still be saved to the sheet without the image link.`
  );
  return null;
}
