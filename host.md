# Hosting a game over the internet (WAN mode)

TrainSig has two ways to play multiplayer:

- **Same Wi-Fi (LAN)** — works exactly as before, no setup, PeerJS + STUN.
- **Over the internet (WAN)** — for playing with someone on a different
  network. You run one small script on your own computer plus a free
  tunnel; nobody needs an account with any third-party *game* service,
  and there's no usage quota to run into that would affect play.
  `game.js` and the game rules are identical in both modes — only how
  the two browsers find each other differs.

This setup uses [ngrok](https://ngrok.com) with a **free static domain**,
so once you've done the one-time setup below, your relay address is
**the same forever** — no router access, no port forwarding, and no
certificate warning for you or your friends to click through.

## One-time setup (do this once, ever)

1. Install the relay's one dependency:
   ```
   pip install websockets
   ```
2. Create a free ngrok account at https://ngrok.com (email + password,
   no credit card).
3. Download the ngrok agent for your OS from
   https://ngrok.com/download and unzip it somewhere easy to find
   (e.g. your Desktop).
4. In the ngrok dashboard, copy your auth token and run, once:
   ```
   ngrok config add-authtoken YOUR_TOKEN_HERE
   ```
5. In the ngrok dashboard under **Domains**, click **Create Domain** to
   reserve a free static domain, e.g. `kingsley-trainsig.ngrok-free.app`.
   Write it down — this is your permanent relay address from now on.

## Every time you want to host

1. Run the relay:
   ```
   python relay.py
   ```
2. In a **second** terminal (same folder as the ngrok executable),
   start the tunnel, using your static domain from setup step 5:
   ```
   ngrok http --domain=kingsley-trainsig.ngrok-free.app 8443
   ```
3. In the game: **Multiplayer → Host Room → "Over the internet (WAN)"**,
   paste your static domain (just `kingsley-trainsig.ngrok-free.app`,
   no `https://`, no port) as the relay address, then **Create Room**.
4. Click **Copy invite link** in the lobby and send it to your friend.
   Opening that link fills in both the relay address and room code for
   them automatically.

That's it — no cert warning, no IP to look up, no port to forward. The
address from step 5 of setup never changes, so you can leave it written
down (or bookmark the invite-link format) and reuse it every session.

## If a friend can't connect

- Make sure **both** `relay.py` and the `ngrok http ...` command are
  still running, each in its own terminal.
- Double-check the relay address matches your static domain exactly
  (typos are the most common cause).
- If ngrok's free tier ever shows an interstitial "visit site" warning
  page for new visitors, have your friend click through it once — it's
  ngrok's, not something TrainSig adds.
- Confirm you're on the *same* room code shown in your lobby.

## Why it works this way

- `relay.py` is a dumb message forwarder you run yourself — no game
  logic passes through anyone else's server.
- Because your game is served over HTTPS (GitHub Pages), browsers won't
  open a plain, unencrypted `ws://` connection to it. Rather than have
  `relay.py` fake its own certificate (which forces a manual "click
  through the warning" step for every player, every time your IP
  changes), the ngrok tunnel provides a **real, browser-trusted**
  HTTPS/WSS certificate at its edge and forwards plain traffic to
  `relay.py` over your own machine's local loopback — so nobody ever
  sees a security warning.
- The static domain means you're not dependent on your ISP's dynamic IP
  or a router you may not control — ngrok's free tier includes one
  reserved domain that's yours to keep reusing.