# What was fixed (speed + reliability only — formats, filters, issue rules unchanged)

## Setup
1. Unzip, open the folder in VS Code.
2. `npm install` (only needed if you removed `node_modules`; no new packages were added).
3. Keep your existing `.env` and `credentials.json` (already in the ZIP). No new settings are required.
4. Start Docker/WAHA, then `npm start` in the VS Code terminal.
5. On start you should see: `WAHA Webhook Server running...` then `📋 Google Sheet ready — Status dropdown includes "Not an issue".`
6. Optional self-test (no WhatsApp / Google needed): `npm run test:burst`, `npm run test:parser`, `npm run test:media`.

## What you will see for every message
    📡 Webhook hit — event: "message"
    📩 [time] Message received  (chat, to, author, text, hasMedia, isReply, tracked-number ✅/❌)   <- printed instantly
    [#a1b2c3] 📝 Writing entry to Google Sheet...
    [#a1b2c3] ✅ TRACKED — Date..., Studio..., Student/Phone...
    [#a1b2c3] 🖼️  Image link added to row N          <- only for issues with an image
The `[#a1b2c3]` tag is the end of the WhatsApp message id, so lines of rapid messages can be told apart.

## Problems found -> fix
| Problem in the ZIP | Fix |
|---|---|
| Webhook answered WAHA only AFTER Google + image work finished (seconds) -> WAHA timeouts/re-sends | Message is printed first, WAHA gets 200 immediately, saving continues in the background |
| Image download (up to ~15 s of retries) and ImgBB upload happened BEFORE the row was written, delaying that issue | Row is written first; image link is added to the same row (column F) as soon as it is ready |
| Every row cost 3 Google calls (append + sheet-info + dropdown) -> slow, quota errors on bursts | Rows waiting together go out in ONE append call; dropdowns are batched in the background; sheet id cached |
| Concurrent webhooks wrote independently -> rows could land out of order | Single ordered write queue (arrival order) |
| Any Google error (429/5xx/network) = message dropped until the 15-min catch-up | Automatic retry with back-off. Before a retry, column I is checked, so a write whose answer was lost is never duplicated |
| A quick "Fixed" reply could be processed before its issue row existed -> status update lost | Status updates wait for queued rows, then look the row up (matches on the unique part of the message id) |
| Server crash while a message was being handled | Each private message is saved to `data/pending/` until fully handled and re-processed on the next start |
| Stray errors could stop the process | Global error handlers keep the tracker running |
| Status dropdown | "Not an issue" added (all old options kept). Applied to all existing rows at start-up and to every new row |

## Notes
* Tracking rule is unchanged: private chat, not sent by us, `to` = TARGET_NUMBER (918925928564), Date + Studio + Student code/Phone present. Only formatted issues reach the sheet; everything else is logged as SKIPPED with the reason.
* Replying "not an issue" in WhatsApp does NOT change status automatically (existing status rules untouched); pick "Not an issue" in the dropdown.
* `data/pending/` is normal: files appear for a moment and are deleted when the message is done. Do not delete `data/state.json`.
* Catch-up/periodic check is the same technology; only the pause between rows was shortened (800 ms -> 300 ms).

## Status dropdown update (v2.1)
* The dropdown (Status + Employees) is now applied to the WHOLE column G / H, not row by row: at start-up, again a moment after every new row, and every 5 minutes as a safety net. Failed attempts are retried, so a row can no longer be left with only a plain "New" cell.
* Status list: New, Open, Assigned, Re-Test, Fixed, Resolved, Bug, **Not an issue**.
* IMPORTANT: restart with `npm start` — existing rows only get "Not an issue" once this version has started and printed
  `📋 Google Sheet ready — Status dropdown includes "Not an issue".`
