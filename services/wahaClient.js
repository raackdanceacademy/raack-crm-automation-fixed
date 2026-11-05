// services/wahaClient.js
//
// Small helper for asking WAHA (your Docker container) questions:
//   - is the WhatsApp session connected?
//   - which chats had activity since a given time?
//   - what messages did those chats receive?
//
// This is what lets the project "look back" at messages that arrived while
// the server / Docker was switched off.

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export const sessionName = () => (process.env.WAHA_SESSION || 'default').trim();

function baseUrl() {
  return (process.env.WAHA_API_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
}

function authHeaders() {
  const apiKey = process.env.WAHA_API_KEY;
  return apiKey ? { 'X-Api-Key': apiKey } : {};
}

export class WahaError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.status = status; // 0 = WAHA not reachable at all
    this.body = body;
  }
}

async function wahaGet(pathAndQuery, timeoutMs = 60000) {
  let response;
  try {
    response = await fetch(baseUrl() + pathAndQuery, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new WahaError(`cannot reach WAHA at ${baseUrl()} (${err.message})`, { status: 0 });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new WahaError(`HTTP ${response.status} ${body.slice(0, 300)}`, { status: response.status, body });
  }
  return response.json();
}

// WhatsApp timestamps are in seconds; be safe if an engine sends milliseconds.
export function toSeconds(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * Returns the session status text ("WORKING", "STARTING", "SCAN_QR_CODE",
 * "STOPPED", ...) or null if WAHA itself is not reachable (Docker is off).
 */
export async function getSessionStatus() {
  try {
    const session = await wahaGet(`/api/sessions/${encodeURIComponent(sessionName())}`, 10000);
    return session?.status || 'UNKNOWN';
  } catch (err) {
    if (err.status === 0) return null;
    if (err.status === 404) return 'NOT_FOUND';
    if (err.status === 401 || err.status === 403) return 'UNAUTHORIZED';
    return 'ERROR';
  }
}

function chatIdOf(item) {
  if (!item) return null;
  if (typeof item.id === 'string') return item.id;
  return item.id?._serialized || null;
}

async function fetchChatPages(endpoint) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await wahaGet(
      `/api/${encodeURIComponent(sessionName())}/${endpoint}${endpoint.includes('?') ? '&' : '?'}limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return items;
}

/**
 * Chats that had a message at/after `sinceTs` (unix seconds).
 * Groups, broadcasts/status and channels are ignored — this project only
 * tracks private chats.
 */
export async function listChatsSince(sinceTs) {
  let items;
  try {
    items = await fetchChatPages('chats/overview');
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 0) throw err;
    // Older WAHA versions do not have /overview — use the plain chat list.
    items = await fetchChatPages('chats');
  }

  const chats = [];
  for (const item of items) {
    const id = chatIdOf(item);
    if (!id) continue;
    if (id.endsWith('@g.us') || id.endsWith('@broadcast') || id.endsWith('@newsletter')) continue;

    const lastTs = toSeconds(item.lastMessage?.timestamp ?? item.conversationTimestamp ?? item.timestamp);
    if (lastTs && lastTs < sinceTs) continue; // nothing new in this chat
    chats.push({ id, lastTs });
  }
  return { totalChats: items.length, chats };
}

/**
 * Incoming (not sent by us) messages of one chat since `sinceTs`.
 * Media is NOT downloaded here — that happens one message at a time right
 * before it is processed (fetchMessageWithMedia), so the image file is fresh.
 */
export async function getIncomingMessagesSince(chatId, sinceTs) {
  const found = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      downloadMedia: 'false',
      'filter.timestamp.gte': String(sinceTs),
      'filter.fromMe': 'false',
    });
    const batch = await wahaGet(
      `/api/${encodeURIComponent(sessionName())}/chats/${encodeURIComponent(chatId)}/messages?${query}`,
      90000
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const m of batch) if (m?.id) found.set(m.id, m);
    if (batch.length < PAGE_SIZE) break;
  }

  // Double-check the filters ourselves in case an engine ignores them.
  return [...found.values()].filter((m) => {
    const ts = toSeconds(m.timestamp);
    return !m.fromMe && ts !== null && ts >= sinceTs;
  });
}

/** One message again, this time asking WAHA to save its image to disk. */
export async function fetchMessageWithMedia(chatId, messageId) {
  try {
    return await wahaGet(
      `/api/${encodeURIComponent(sessionName())}/chats/${encodeURIComponent(chatId)}` +
        `/messages/${encodeURIComponent(messageId)}?downloadMedia=true`,
      60000
    );
  } catch {
    return null;
  }
}
