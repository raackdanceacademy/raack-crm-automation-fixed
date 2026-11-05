# Catch-up of messages received while the server / Docker was off

## What changed
* On start (and whenever WhatsApp reconnects) the project now asks WAHA for every
  private-chat message received since it last checked, read or unread, and runs
  them through the same rules as live messages (Date + Studio + Student Code/Phone).
* Messages already in the sheet are never added twice.
* Progress is remembered in `data/state.json` (do not delete it; if you do, the
  next start simply looks back `CATCHUP_LOOKBACK_HOURS` hours and skips anything
  already in the sheet).

## Daily use
Start Docker (WAHA) and `npm start` in any order. Watch the console for:
    🟢 WAHA / WhatsApp is connected.
    🔄 CATCH-UP (startup / reconnect) ...
    ✅ CATCH-UP DONE — new rows: N ...

## Important WAHA notes
1. Stop/start the SAME container (Docker Desktop stop button, then start). Do not
   delete the container, or WhatsApp will ask you to scan the QR code again.
2. If the console says WAHA "cannot list old messages" and you use the NOWEB
   engine, enable the NOWEB store (WAHA Dashboard -> session -> Config -> NOWEB ->
   Store enabled). WAHA warns this must be set when the session is created,
   before scanning the QR code, so it may need a new session. The WEBJS engine
   does not need this.
3. WhatsApp only delivers messages to a linked device that reconnects within
   about 2 weeks. Keep the phone online and don't stay off for weeks.
