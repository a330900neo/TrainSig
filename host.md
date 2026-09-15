# Hosting a game over the internet (WAN mode)

TrainSig has two ways to play multiplayer:

- **Same Wi-Fi (LAN)** — works exactly as before, no setup, PeerJS + STUN.
- **Over the internet (WAN)** — for playing with someone on a different
  network. You run one small script on your own computer; nobody needs an
  account with any third-party service, and there's no usage quota to run
  into. `game.js` and the game rules are identical in both modes — only
  how the two browsers find each other differs.

## One-time setup

```
pip install websockets cryptography
```

## Every time you want to host over the internet

1. Run the relay:
   ```
   python relay.py
   ```
2. It prints something like:
   ```
   STEP 1 - open this yourself once, and click through the browser's
   certificate warning ("Advanced" -> "Proceed"):
      https://203.0.113.10:8443

   STEP 2 - in the game, choose Host Room -> Over the internet (WAN),
   and paste this as the relay address:
      203.0.113.10:8443
   ```
3. Do Step 1 in a browser tab (one click through the warning — this is
   your own script's certificate, not a real security problem).
4. In the game: **Multiplayer → Host Room → "Over the internet (WAN)"**,
   paste the address from Step 2, then **Create Room**.
5. Click **Copy invite link** in the lobby and send it to your friend.
   Opening that link fills in both the relay address and room code for
   them automatically.
6. Your friend will also see the certificate warning the first time they
   connect — that's expected, they click through it too.

## If a friend can't connect

- Make sure `relay.py` is still running in your terminal.
- The script tries to forward its port on your router automatically
  (UPnP). If that failed, it prints the port to forward manually —
  open your router's admin page and forward that TCP port to this
  computer.
- Double check the relay address and room code match exactly what's
  currently printed/shown (a restarted `relay.py` may get a new public
  IP if your ISP doesn't give you a static one).

## Why it works this way

- No STUN/TURN, no PeerJS cloud, no paid or quota-limited service —
  `relay.py` is a dumb message forwarder you run yourself. The only
  requirement is that your computer stays reachable from the internet
  while you're hosting (via the forwarded port).
- The HTTPS certificate step exists because the game is served over
  HTTPS (GitHub Pages) and browsers refuse plain, unencrypted `ws://`
  connections from an HTTPS page. `relay.py` generates its own
  certificate so it can speak `wss://` instead — there's no domain name
  or paid certificate involved.