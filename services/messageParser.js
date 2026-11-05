// services/messageParser.js
//
// Deterministic parser — NO AI model involved.
//
// ── What is REQUIRED ─────────────────────────────────────────────────────
// Every issue message must contain these THREE things:
//   1) DATE
//   2) STUDIO
//   3) STUDENT CODE / PHONE NUMBER
//
// ── What is FREE ─────────────────────────────────────────────────────────
// The ISSUE DESCRIPTION has NO format. It is the user's own way of
// explaining the problem: any length, any wording, one line or many lines.
// The description is never validated and never a reason to skip a message.
//
// ── Accepted layouts (all give the same result) ──────────────────────────
// A) Labeled, one item per line (labels are case-insensitive, ":" "=" or "-"):
//      Date: 17.9.2026
//      Studio: Mannivakkam
//      Student Code / Phone Number: RK02125466 /Guhan Krish.D.S/9710067007
//      Issue Description: anything the user wants to write ...
//
// B) Labeled, all on one line (comma separated):
//      Date 24-09-2026 ,Studio : Guduvanchery , Student code / Phone Number : RK00313948 , Issue Description : Remove october month fees
//
// C) Unlabeled, fixed order (line 1 date, line 2 studio, line 3 code/phone,
//    everything after that = description):
//      24-09-2026
//      Velachery
//      RK04222193
//      Remove August month fees
//
// Anything that does not contain a date + studio + student code/phone is
// treated as "not an issue" (chit-chat etc.) and parseIssueMessage returns
// null — the caller then simply does not log a row.

// ── Helpers ───────────────────────────────────────────────────────────────

// 17-09-2026, 17.9.2026, 17/9/26, 2026-09-17
const NUMERIC_DATE = /^\d{1,2}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{2,4}$|^\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}$/;
// 17 Sep 2026, 17th September 2026, 17-Sep-26
const DAY_MONTH_DATE = /^\d{1,2}(?:st|nd|rd|th)?[\s\-/.,]*[A-Za-z]{3,9}\.?[\s\-/.,]*\d{2,4}$/;
// Sep 17 2026, September 17th, 2026
const MONTH_DAY_DATE = /^[A-Za-z]{3,9}\.?\s*\d{1,2}(?:st|nd|rd|th)?,?\s*\d{2,4}$/;

function isDateLike(str) {
  const s = (str || '').trim().replace(/[.,;:]+$/, '');
  return NUMERIC_DATE.test(s) || DAY_MONTH_DATE.test(s) || MONTH_DAY_DATE.test(s);
}

// Removes WhatsApp formatting (*bold*, ~strike~), invisible characters and
// normalizes line endings, so "*Date:* 17.9.2026" is read like "Date: 17.9.2026".
function cleanText(text) {
  return String(text)
    .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[*~]/g, '')
    .trim();
}

// Decides which of our 4 fields a label such as "Student Code / Phone Number"
// refers to. Returns 'date' | 'studio' | 'code' | 'issue' | null.
function classifyLabel(rawName) {
  const name = (rawName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (/^date$/.test(name)) return 'date';
  if (/^studio( name| location| branch)?$|^branch$|^centre$|^center$/.test(name)) return 'studio';
  if (/^(issue|description|problem|concern|complaint|details?)\b/.test(name)) return 'issue';
  if (
    /^(student|stud|phone|mobile|contact|code|id|reg|registration|admission|roll)\b/.test(name) &&
    name.length <= 45
  ) {
    return 'code';
  }
  return null;
}

// Finds label markers ("Date:", "Studio :", "Student Code / Phone Number :" …)
// that sit at the start of a line or right after a comma / semicolon / pipe.
const LABEL_SCAN = /(^|[\n,;|])[ \t]*([A-Za-z][A-Za-z ./&]{0,44}?)[ \t]*[:=\-–][ \t]*/g;

function scanLabels(text) {
  // "Date 24-09-2026 ,Studio : …"  →  "Date: 24-09-2026 ,Studio : …"
  const normalized = text.replace(/(^|[\n,;|])[ \t]*date[ \t]+(?=\d)/gi, '$1Date: ');

  const found = [];
  let m;
  LABEL_SCAN.lastIndex = 0;
  while ((m = LABEL_SCAN.exec(normalized)) !== null) {
    const kind = classifyLabel(m[2]);
    if (!kind) continue;
    found.push({ kind, start: m.index, end: m.index + m[0].length });
    // Once the issue label starts, EVERYTHING after it is description —
    // do not look for more labels inside the user's own wording.
    if (kind === 'issue') break;
  }
  return { normalized, found };
}

function tidy(str) {
  return (str || '')
    .replace(/[\s,;|]+$/g, '')
    .replace(/^[\s,;|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLineAndRest(value) {
  const parts = value.split('\n').map((p) => p.trim()).filter(Boolean);
  return { first: parts[0] || '', rest: parts.slice(1).join(' ') };
}

// ── Layout A / B : labeled ────────────────────────────────────────────────
function parseLabeledFormat(rawText) {
  const text = cleanText(rawText);
  const { normalized, found } = scanLabels(text);
  if (found.length < 3) return null;

  const values = {};
  const extras = [];

  found.forEach((label, i) => {
    const next = found[i + 1];
    const value = normalized.slice(label.end, next ? next.start : normalized.length);
    if (values[label.kind] !== undefined) {
      // A repeated label — keep the text rather than losing it.
      extras.push(tidy(value));
      return;
    }
    if (label.kind === 'issue') {
      values.issue = value.trim();
    } else {
      const { first, rest } = firstLineAndRest(value);
      values[label.kind] = tidy(first);
      if (rest) extras.push(tidy(rest));
    }
  });

  if (!values.date || !values.studio || !values.code) return null;
  if (!/\d/.test(values.date)) return null;
  if (!/\d/.test(values.code)) return null;

  const description = [values.issue ? values.issue.replace(/\s+/g, ' ').trim() : '', ...extras]
    .filter(Boolean)
    .join(' ');

  return {
    date: values.date,
    studio: values.studio,
    student_code_or_phone: values.code,
    issue_description: description,
  };
}

// ── Layout C : unlabeled, fixed order (labels on some lines are tolerated) ─
function stripKnownLabel(line, expectedKind) {
  const m = line.match(/^([A-Za-z][A-Za-z ./&]{0,44}?)[ \t]*[:=\-–][ \t]*(.*)$/);
  if (m && classifyLabel(m[1]) === expectedKind) return m[2].trim();
  return line;
}

function parseLineFormat(rawText) {
  const lines = cleanText(rawText)
    .split('\n')
    .map((l) => l.trim());

  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  if (lines.length < 3) return null;

  const dateLine = stripKnownLabel(lines[0], 'date').replace(/[.,;:]+$/, '');
  const studioLine = stripKnownLabel(lines[1], 'studio');
  const codeLine = stripKnownLabel(lines[2], 'code');
  const descLines = lines.slice(3);

  if (!isDateLike(dateLine)) return null;
  if (!studioLine || studioLine.length > 60 || isDateLike(studioLine)) return null;
  // Student code / phone: must carry a real number (RK04222193, 9710067007 …).
  if (codeLine.length > 100 || !/\d{3,}/.test(codeLine)) return null;

  return {
    date: dateLine,
    studio: studioLine,
    student_code_or_phone: codeLine,
    issue_description: descLines.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Parses a message's text.
 * Returns { date, studio, student_code_or_phone, issue_description } when the
 * three required items (date, studio, student code/phone) are present, or
 * null otherwise. issue_description is whatever the user wrote (may be '').
 */
function parseIssueMessage(text = '') {
  if (!text || typeof text !== 'string') return null;
  return parseLabeledFormat(text) || parseLineFormat(text);
}

export { parseIssueMessage, parseLabeledFormat, parseLineFormat, isDateLike };
