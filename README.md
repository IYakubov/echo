# Echo

A Simon-style memory game for **1–4 players** on [Shared Couch](https://sharedcouch.online). The big screen lights up four pads in a sequence, and every player repeats it on their phone. The sequence keeps growing by one step each round.

## How to play
- Open the game on any screen and press **Create game**. Phones scan the QR code.
- When everyone in the room has pressed **Ready**, the game starts after 2.5 s (a phone that joins during that time cancels it). One phone alone plays solo.
- **Watch:** the big screen plays the sequence. It starts at 3 steps and plays faster as it grows.
- **Your turn:** tap the pads on your phone in the same order before the timer runs out (2.5 s + 0.75 s per step).
- A wrong pad or running out of time costs one of your **3 lives**. Your score is the longest sequence you repeated.
- **Multiplayer:** the last player with lives left wins. If the last players drop out in the same round, the longest sequence wins, and a tie is a draw.
- **Solo:** play until you're out. The best score is kept on the big screen's browser.

## Run locally
```
npm install
npm start        # http://localhost:3000
```
Phones on the same Wi-Fi join through the QR code, which uses the machine's LAN IP.

## Shared Couch conventions
- It runs behind the front door at `/echo/`, with relative asset and socket.io paths, and the QR link is built from `X-Forwarded-Proto/Host/Prefix`.
- **Menu button:** on the phone (top-right) and on the big screen (bottom-right), or press Esc. It opens Resume / Back to lobby / Game catalog, and pausing freezes the timers and mutes the sound.
- One phone holds one slot (`echo_client` in localStorage).
- All sounds are synthesised with Web Audio, so there are no audio files.

## Socket events
| Event | Direction | Payload |
|---|---|---|
| create_game → game_created | host↔server | → `{code, joinUrl, qrSvg}` |
| join_game / rejoin_game → joined / join_error | phone↔server | `{code, clientId[, slot]}` → `{slot, code, started, ready}` |
| player_ready / player_unready | phone→server | |
| game_event `lobby_ready_update` | server→all | `{slots:{A:{on,ready},…}, starting, startsAt, started}` |
| game_start | server→all | `{players:['A','C',…]}` |
| ctrl_pad | phone→host | `{slot, pad}` (0–3) |
| ctrl_pick | phone→host | `{slot, index}`, a tapped menu row |
| ctrl_menu | phone→host | toggles the pause menu |
| host_ui | host→phones | `{phase, menu, items, focus, status, pads, pos, len, lives, caption}` |
| to_player → player_msg | host→one phone | `{t:'ok'|'done'|'wrong'|'slow', pos, len, lives, expected}` |
| host_back_to_lobby → back_to_lobby, host_exit | host→phones | |
| player_joined, player_left, host_disconnected, replaced | server→clients | |
