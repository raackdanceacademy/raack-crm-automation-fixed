// test/sendTestMessages.js
//
// Lets YOU fire sample messages at the running webhook server directly,
// without waiting for someone to actually DM the real WhatsApp number.
//
// Usage:
//   1) Start the server in one terminal:   npm start
//   2) In another terminal, run:           npm run test:send
//
// Each test payload is shaped like what WAHA sends for an INDIVIDUAL chat,
// with `to` set to TARGET_NUMBER (our business number) so it passes the
// filter in server.js, and `from` varying per sender to simulate different
// students/counsellors DM'ing in. Change TARGET/WEBHOOK_URL below if your
// setup differs.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const WEBHOOK_URL = process.env.TEST_WEBHOOK_URL || `http://localhost:${process.env.PORT || 3001}/webhook`;
const TARGET_NUMBER_RAW = process.env.TARGET_NUMBER || '918925928564';
const TARGET_JID = `${TARGET_NUMBER_RAW.replace(/\D/g, '')}@c.us`;
const GROUP_ID = '120363330517692423@g.us'; // used only to prove groups now get skipped

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// A small public test image (safe to swap for any real image URL you have).
const SAMPLE_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/89/HTTP_logo.svg/240px-HTTP_logo.svg.png';

let idCounter = 1;
function nextId() {
  return `TEST_MSG_${Date.now()}_${idCounter++}`;
}

async function send(label, payload) {
  console.log(`\n=== Sending test: ${label} ===`);
  // Don't dump raw base64 image data to the console — just show its length.
  const loggable = payload.media?.data
    ? { ...payload, media: { ...payload.media, data: `<base64 omitted, ${payload.media.data.length} chars>` } }
    : payload;
  console.log(JSON.stringify(loggable, null, 2));
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    const data = await res.json().catch(() => ({}));
    console.log(`--> HTTP ${res.status}:`, data);
    return data;
  } catch (err) {
    console.error(`--> FAILED to reach ${WEBHOOK_URL}:`, err.message);
    console.error('    Is the server running (npm start)?');
  }
}

// Sends ONE real test message built from CLI args, e.g.:
//   npm run test:send -- "C:\Users\vigne\Downloads\screenshot.jpeg" "24-09-2026 kandigai RK04222193 Remove August month fees"
// arg 1 = path to an image on disk (optional — pass "" or "none" to skip it)
// arg 2+ = the message text/caption (joined with spaces if given as several
// args). Note: this CLI helper joins args with spaces, so it can't send
// real newlines — for testing the actual 4-line format, edit main() below
// or send a single arg containing literal \n via your shell's quoting.
async function sendCustomTest(args) {
  console.log(`Target webhook: ${WEBHOOK_URL}`);
  console.log(`Target number:  ${TARGET_JID}`);

  const [imagePathArg, ...textParts] = args;
  const text = textParts.join(' ').trim();
  const hasImage = imagePathArg && imagePathArg.toLowerCase() !== 'none';

  let media;
  if (hasImage) {
    const imagePath = path.resolve(imagePathArg);
    if (!fs.existsSync(imagePath)) {
      console.error(`❌ Image file not found: ${imagePath}`);
      process.exit(1);
    }
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mimetype = EXT_TO_MIME[ext] || 'image/jpeg';
    media = { data: buffer.toString('base64'), mimetype };
    console.log(`📎 Attaching ${imagePath} (${buffer.length} bytes, ${mimetype})`);
  }

  if (!text && !hasImage) {
    console.error('❌ Nothing to send — provide an image path, a text message, or both.');
    process.exit(1);
  }

  await send('Custom test message', {
    id: nextId(),
    from: '919876543210@c.us', // the sender (a student/counsellor DM'ing us)
    to: TARGET_JID,            // our tracked business number
    author: '919876543210@c.us',
    ...(hasImage ? { caption: text, hasMedia: true, media } : { body: text, hasMedia: false }),
  });

  console.log('\n=== Done. Check your Google Sheet for the new row (only if the text matched the exact format). ===');
}

async function main() {
  console.log(`Target webhook: ${WEBHOOK_URL}`);
  console.log(`Target number:  ${TARGET_JID}`);

  // 1) The REAL format users actually send: 4 plain lines, no labels.
  //    DM'd to our number from user A -> should be logged as a new row.
  const textMsgId = nextId();
  await send('Valid real-format issue (individual DM from user A)', {
    id: textMsgId,
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: '24-09-2026\nkandigai\nRK04222193\nRemove August month fees',
    hasMedia: false,
  });

  // 2) Same real format, WITH an image caption, from a DIFFERENT user B ->
  //    proves different senders all get tracked as long as the caption
  //    matches and it was sent to our number. This mirrors exactly what
  //    users send: photo + 4-line caption.
  await send('Valid real-format issue with screenshot (individual DM from user B)', {
    id: nextId(),
    from: '919876500000@c.us',
    to: TARGET_JID,
    author: '919876500000@c.us',
    caption: '24-09-2026\nmylapore\n9876543210\nPayment shows failed but amount got debited',
    hasMedia: true,
    media: {
      url: SAMPLE_IMAGE_URL,
      mimetype: 'image/png',
    },
  });

  // 3) The labeled format also still works, as a fallback.
  await send('Valid labeled-format issue (individual DM)', {
    id: nextId(),
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: 'Date 24-09-2026 ,Studio : Guduvanchery , Student code / Phone Number : RK00313948 , Issue Description : Remove october month fees',
    hasMedia: false,
  });

  // 3b) Labeled, multi-line message with a free-form description (this exact
  //     shape used to be rejected). Must be logged.
  await send('Valid labeled multi-line issue with free-form description', {
    id: nextId(),
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: 'Date: 17.9.2026\nStudio: Mannivakkam\nStudent Code / Phone Number: RK02125466 /Guhan Krish.D.S/9710067007\nIssue Description:  The above mentioned kid has joined the flow batch. Their fees amount is not showing while making the payment. Please rectify the issue earliest.',
    hasMedia: false,
  });

  // 4) Only 3 lines (missing the code line) -> must be SKIPPED, not logged
  //    as a partial/"N/A" row.
  await send('Malformed — only 3 lines (should be skipped, NOT logged as N/A)', {
    id: nextId(),
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: '24-09-2026\nkandigai\nplease remove fees for this month',
    hasMedia: false,
  });

  // 5) Casual chit-chat -> should be skipped.
  await send('Casual chit-chat (individual DM, should be skipped)', {
    id: nextId(),
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: 'Good morning!',
    hasMedia: false,
  });

  // 6) Known ignored-reply phrase -> should be skipped before even
  //    attempting to match a format.
  await send('Ignored reply phrase (individual DM, should be skipped)', {
    id: nextId(),
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: 'Thank you sir',
    hasMedia: false,
  });

  // 7) A reply/tag that matches a status keyword, targeting the message
  //    logged in step 1 -> should flip its STATUS.
  await send('Status-update reply (individual DM)', {
    id: nextId(),
    from: '919000000000@c.us',
    to: TARGET_JID,
    author: '919000000000@c.us',
    body: 'Issue rectified, working fine now',
    hasMedia: false,
    replyTo: { id: textMsgId },
  });

  // 8) Same real-format issue, but posted in a GROUP -> should be skipped
  //    entirely, even though the text matches perfectly, since we only
  //    track the individual number now.
  await send('Valid real-format issue from a GROUP (should be skipped)', {
    id: nextId(),
    from: GROUP_ID,
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: '24-09-2026\nKilpauk\nRK00399999\nApp crashes on opening',
    hasMedia: false,
  });

  // 9) Sending the exact same message id twice in a row -> the second one
  //    should be skipped as a duplicate delivery (simulates a WAHA retry).
  const dupeId = nextId();
  const dupePayload = {
    id: dupeId,
    from: '919876543210@c.us',
    to: TARGET_JID,
    author: '919876543210@c.us',
    body: '24-09-2026\npadur\nRK00355555\nClass timing changed, please update',
    hasMedia: false,
  };
  await send('Duplicate delivery, attempt 1 (should log)', dupePayload);
  await send('Duplicate delivery, attempt 2, same id (should be skipped)', dupePayload);

  console.log('\n=== Done. Check your Google Sheet: rows 1, 2, 3 and 9 (first attempt only) should appear as "New", row 1 should have flipped to "Solved" via the reply, and NOTHING else (rows 4-8 and the 2nd duplicate) should have created a row. ===');
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  sendCustomTest(cliArgs);
} else {
  main();
}
