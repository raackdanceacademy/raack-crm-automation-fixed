// config/ignoredReplies.js
//
// Messages that are just human replies/acknowledgements in the WhatsApp group
// (not new issues) should never be logged as a new row in the sheet.
// Add/remove phrases here — matching is case-insensitive and ignores
// punctuation, so "Thank you sir!" and "thank you sir" both match.

const IGNORED_REPLIES = [
  'removed',
  'kindly rectify sir',
  'thank you sir',
  'gentle reminder',
  'now its working sir',
];

/**
 * Returns true if the message text is just one of the known "reply/comment"
 * phrases and should be skipped instead of logged as a new issue row.
 */
function isIgnoredReply(text) {
  if (!text) return false;

  const cleaned = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // strip punctuation like . ! ,
    .replace(/\s+/g, ' ');

  return IGNORED_REPLIES.some((phrase) => cleaned === phrase);
}

export { IGNORED_REPLIES, isIgnoredReply };
