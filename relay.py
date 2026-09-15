#!/usr/bin/env python3
"""
relay.py - TrainSig WAN relay.

A dumb message router, nothing more. It never looks at, understands, or
modifies the game traffic it forwards - it just relays bytes between
whichever WebSocket connections it's told to.

WHY THIS EXISTS
----------------
TrainSig's normal "LAN" multiplayer uses WebRTC (PeerJS + a public STUN
server + PeerJS's free cloud signaling service) which works great on the
same Wi-Fi, but relies on someone else's server and doesn't reliably reach
across the open internet without a TURN relay.

This script replaces all of that for "WAN" mode: you run it once on your
own computer, forward one port on your router (this script tries to do
that automatically), and both you and your friends' browsers connect to
it directly over a plain WebSocket. No STUN, no TURN, no third-party
service, no usage limits or quotas - the only thing between you and your
friends is this script and your own network.

WHAT IT DOES
------------
1. Generates a self-signed TLS certificate on first run (reused after
   that) so the browser can connect with wss:// - required because the
   game is served over HTTPS (GitHub Pages) and browsers refuse to open
   a plain, unencrypted ws:// connection from an HTTPS page.
2. Starts a WebSocket server on 0.0.0.0:<port> (default 8443).
3. Tries to forward that port automatically on your router via UPnP.
   If that fails (some routers don't support it), it prints manual
   instructions instead - the relay still runs fine, friends just won't
   be able to reach it until the port is forwarded some other way.
4. Prints your public IP and two ready-to-use links: one for you to open
   once yourself (to accept the certificate), one to share with friends.
5. Relays messages between the room's host and its clients until you
   press Ctrl+C.

SETUP
-----
    pip install websockets cryptography
    python relay.py

That's it. Re-running later reuses the same certificate, so subsequent
runs are instant.

WIRE PROTOCOL (JSON text frames)
---------------------------------
  -> {"t":"hello","role":"host"|"client","room":"<id>"}      (first frame)
  <- {"t":"hello_ok","id":"<selfId>"}                        (accepted)
  <- {"t":"error","reason":"room_taken"|"no_such_room"}      (rejected)
  <- {"t":"join","id":"<clientId>"}                          (to host)
  <- {"t":"leave","id":"<clientId>"}                         (to host)
  <- {"t":"host_left"}                                       (to clients)
  -> {"t":"data","to":"<clientId>"?,"payload":<any>}         (host: omit "to" to broadcast)
  -> {"t":"data","payload":<any>}                            (client -> host)
  <- {"t":"data","from":"<clientId>"?,"payload":<any>}       (relay adds "from" for the host)
"""

import argparse
import asyncio
import json
import re
import secrets
import socket
import ssl
import sys
import urllib.request
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Missing dependency. Run:  pip install websockets cryptography")
    sys.exit(1)


# ============================================================
# --- Room state (all in memory, nothing persisted) ---
# ============================================================

rooms = {}  # room_id -> {"host": websocket, "clients": {client_id: websocket}}


async def handler(ws):
    role = None
    room_id = None
    my_id = None
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        hello = json.loads(raw)
        if hello.get("t") != "hello":
            await ws.close()
            return
        role = hello.get("role")
        room_id = hello.get("room")

        if role == "host":
            if not room_id or room_id in rooms:
                await ws.send(json.dumps({"t": "error", "reason": "room_taken"}))
                await ws.close()
                return
            rooms[room_id] = {"host": ws, "clients": {}}
            my_id = room_id
            await ws.send(json.dumps({"t": "hello_ok", "id": my_id}))
            print(f"[+] Host connected - room {room_id}")

        elif role == "client":
            room = rooms.get(room_id)
            if not room:
                await ws.send(json.dumps({"t": "error", "reason": "no_such_room"}))
                await ws.close()
                return
            my_id = secrets.token_hex(4)
            room["clients"][my_id] = ws
            await ws.send(json.dumps({"t": "hello_ok", "id": my_id}))
            await room["host"].send(json.dumps({"t": "join", "id": my_id}))
            print(f"[+] Client {my_id} joined room {room_id}")

        else:
            await ws.close()
            return

        async for raw in ws:
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if frame.get("t") != "data":
                continue

            if role == "host":
                room = rooms.get(room_id)
                if not room:
                    continue
                out = json.dumps({"t": "data", "payload": frame.get("payload")})
                to = frame.get("to")
                if to:
                    target = room["clients"].get(to)
                    if target:
                        await target.send(out)
                else:
                    for c in list(room["clients"].values()):
                        await c.send(out)
            else:
                room = rooms.get(room_id)
                if not room:
                    continue
                out = json.dumps({"t": "data", "from": my_id, "payload": frame.get("payload")})
                await room["host"].send(out)

    except (websockets.exceptions.ConnectionClosed, asyncio.TimeoutError):
        pass
    finally:
        if role == "host" and room_id in rooms:
            room = rooms.pop(room_id, None)
            if room:
                for c in list(room["clients"].values()):
                    try:
                        await c.send(json.dumps({"t": "host_left"}))
                        await c.close()
                    except Exception:
                        pass
            print(f"[-] Host left - room {room_id} closed")
        elif role == "client" and room_id in rooms:
            room = rooms[room_id]
            room["clients"].pop(my_id, None)
            try:
                await room["host"].send(json.dumps({"t": "leave", "id": my_id}))
            except Exception:
                pass
            print(f"[-] Client {my_id} left room {room_id}")


# ============================================================
# --- TLS: self-signed cert, generated once and reused ---
# ============================================================

def ensure_cert(cert_dir: Path):
    cert_path = cert_dir / "cert.pem"
    key_path = cert_dir / "key.pem"
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path

    try:
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("Missing dependency. Run:  pip install websockets cryptography")
        sys.exit(1)

    print("First run - generating a self-signed certificate (only happens once)...")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "trainsig-relay")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_dir.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


# ============================================================
# --- Best-effort convenience: UPnP port mapping + IP lookups ---
# Every function here fails silently (returns None/False) rather than
# crashing the relay - none of this is required for the relay to work,
# it just saves the host a trip into their router's settings page.
# ============================================================

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def get_public_ip():
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            with urllib.request.urlopen(url, timeout=4) as r:
                ip = r.read().decode().strip()
                if ip:
                    return ip
        except Exception:
            continue
    return None


def try_upnp_map(port: int) -> bool:
    try:
        req = (
            "M-SEARCH * HTTP/1.1\r\n"
            "HOST: 239.255.255.250:1900\r\n"
            'MAN: "ssdp:discover"\r\n'
            "MX: 2\r\n"
            "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
        ).encode()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(3)
        sock.sendto(req, ("239.255.255.250", 1900))
        data, _ = sock.recvfrom(4096)
        sock.close()
        text = data.decode(errors="ignore")
        loc_match = re.search(r"(?i)location:\s*(\S+)", text)
        if not loc_match:
            return False
        location = loc_match.group(1).strip()

        with urllib.request.urlopen(location, timeout=3) as r:
            desc = r.read().decode(errors="ignore")
        control_match = re.search(r"<controlURL>(.*?)</controlURL>", desc)
        if not control_match:
            return False
        control_path = control_match.group(1)
        base_match = re.match(r"(https?://[^/]+)", location)
        base = base_match.group(1) if base_match else ""
        control_url = control_path if control_path.startswith("http") else base + control_path

        local_ip = get_local_ip()
        body = f"""<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:AddPortMapping xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort>
<NewProtocol>TCP</NewProtocol><NewInternalPort>{port}</NewInternalPort>
<NewInternalClient>{local_ip}</NewInternalClient><NewEnabled>1</NewEnabled>
<NewPortMappingDescription>TrainSig relay</NewPortMappingDescription>
<NewLeaseDuration>0</NewLeaseDuration>
</u:AddPortMapping></s:Body></s:Envelope>"""
        req2 = urllib.request.Request(
            control_url,
            data=body.encode(),
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPAction": '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"',
            },
        )
        urllib.request.urlopen(req2, timeout=3)
        return True
    except Exception:
        return False


# ============================================================
# --- Entry point ---
# ============================================================

async def serve(ssl_ctx, port):
    async with websockets.serve(handler, "0.0.0.0", port, ssl=ssl_ctx, max_size=2 ** 20):
        await asyncio.Future()  # run forever


def main():
    parser = argparse.ArgumentParser(description="TrainSig WAN relay - a dumb message router, no STUN/TURN/cloud service.")
    parser.add_argument("--port", type=int, default=8443, help="TCP port to listen on (default: 8443)")
    args = parser.parse_args()

    cert_dir = Path.home() / ".trainsig-relay"
    cert_path, key_path = ensure_cert(cert_dir)
    ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_ctx.load_cert_chain(str(cert_path), str(key_path))

    print("Setting up...")
    mapped = try_upnp_map(args.port)
    public_ip = get_public_ip()
    local_ip = get_local_ip()

    print()
    print("=" * 64)
    print(" TrainSig relay is running")
    print("=" * 64)
    if mapped:
        print(f"Port {args.port} was forwarded automatically on your router.")
    else:
        print(f"Couldn't forward port {args.port} automatically (some routers")
        print(f"don't support this). Forward TCP port {args.port} to this")
        print(f"computer ({local_ip}) in your router's settings, then restart")
        print("this script. The relay is running either way.")
    print()
    if public_ip:
        print("STEP 1 - open this yourself once, and click through the browser's")
        print("certificate warning (\"Advanced\" -> \"Proceed\"). This is expected;")
        print("it's a certificate this script made for itself, not a real problem:")
        print(f"   https://{public_ip}:{args.port}")
        print()
        print("STEP 2 - in the game, choose Host Room -> Over the internet (WAN),")
        print("and paste this as the relay address:")
        print(f"   {public_ip}:{args.port}")
    else:
        print("Couldn't detect your public IP automatically. Look it up (search")
        print(f"\"what is my ip\") and use it with port {args.port}, e.g. 203.0.113.10:{args.port}")
    print()
    print("Friends joining over WAN paste the same relay address on their side,")
    print("plus the room code the game shows you once you create the room.")
    print()
    print("Press Ctrl+C to stop hosting.")
    print("=" * 64)
    print()

    try:
        asyncio.run(serve(ssl_ctx, args.port))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()