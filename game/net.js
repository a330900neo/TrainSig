/**
 * net.js - Multiplayer layer for TrainSig.
 *
 * TWO TRANSPORTS, ONE PROTOCOL:
 * All the room/game logic below (join requests, permissions, state
 * snapshots, inputs, ping, etc.) is transport-agnostic. It only ever talks
 * to a small PeerJS-shaped object: `peer.on('open'/'connection'/'error')`,
 * `peer.connect(id)`, and a connection object with `.peer`, `.open`,
 * `.send(data)`, `.on('open'/'data'/'close'/'error')`. Two implementations
 * exist:
 *
 *   - window.Peer (real PeerJS, WebRTC + Google STUN + PeerJS's public
 *     cloud signaling broker) - used for "LAN" mode. Works great on the
 *     same network out of the box, no server to run.
 *
 *   - WanPeer (this file, plain WebSocket to a self-hosted relay script,
 *     no STUN/TURN/cloud broker at all) - used for "WAN" mode, for playing
 *     with someone over the internet. The host runs relay.py once; it's a
 *     dumb message forwarder, blind to game content.
 *
 * Because both expose the same shape, none of the room/game logic below
 * needs to know or care which one is active - only hostRoom()/joinRoom()
 * pick the constructor. Updating game rules or the message protocol never
 * requires touching the transport, and vice versa.
 *
 * AUTHORITY MODEL:
 * Host-authoritative. The host is the only machine that runs the real
 * simulation (see the MP guards added to spawnTrainAt / despawnTrain /
 * toggleSignal / assignLineToTrain / simTick in game.js). Every other
 * player is a thin client: it sends intents ("spawn a train at depot X",
 * "set time warp to 10x") and renders whatever state snapshot the host
 * last broadcast. Clients never run physics, so there's no float-precision
 * desync to worry about between machines.
 *
 * TOPOLOGY:
 * A real star, not just a logical one. The host runs a single Peer/WanPeer
 * whose ID is derived from the room code; each client runs its own
 * Peer/WanPeer and opens ONE connection directly to the host. Clients
 * never connect to each other.
 *
 * This file is a plain classic (non-module) script loaded after game.js,
 * so it shares game.js's top-level scope directly: `state`, `trains`,
 * `simSpeed`, `simPaused`, `simTimeSeconds`, `gameOver`, `selectedTrainId`,
 * and functions like `loadDiagram`, `spawnTrainAt`, `despawnTrain`,
 * `toggleSignal`, `assignLineToTrain`, `applyTimeWarpLocal`, `showToast`,
 * `updateClockDisplay`, `updateTrainPanel`, `draw`, `getTrack`, `getLine`
 * are all just... there. No imports needed.
 */

const TIME_WARP_MIN = 1;
const TIME_WARP_MAX = 60;
const SNAPSHOT_HZ = 30;           // host -> clients state broadcast rate
const PING_INTERVAL_MS = 2000;
const CURSOR_INTERVAL_MS = 33;    // ~30Hz cursor position updates

// Only used by LAN mode. WAN mode uses no STUN/TURN at all - see WanPeer.
const MP_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' }
];

const MP_APP_ID = 'trainsig-v1';
function mpHostPeerId(roomCode) {
    return MP_APP_ID + '-' + roomCode;
}
function mpRandomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function mpDefaultPermissions() {
    return {
        timeWarp: { allowed: true, capX: TIME_WARP_MAX },
        depotSpawnDespawn: true,
        lineAndSignalControl: true
    };
}

// Deterministic color per player, derived from their peer id, so every
// client independently draws the same player in the same color without
// the host needing to assign and broadcast one.
function mpColorForPeer(peerId) {
    let hash = 0;
    for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
    let hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 75%, 60%)`;
}

// ============================================================
// --- MP: networking + authoritative-command handling ---
// ============================================================

const MP = {
    active: false,      // true once in ANY multiplayer room (host or client)
    isHost: false,
    peer: null,          // this machine's Peer/WanPeer instance
    selfId: null,
    username: null,
    roomCode: null,

    transport: 'lan',     // 'lan' (PeerJS/WebRTC) or 'wan' (relay.py over WebSocket)
    wanRelayUrl: null,    // e.g. 'wss://203.0.113.10:8443' - only used in 'wan' mode

    conns: {},            // host-only: peerId -> open connection object
    hostConn: null,       // client-only: the single connection to the host
    players: {},         // host-only: peerId -> player record (source of truth)
    roomSettings: { limit: null, allowMidGameJoin: true },
    started: false,

    myPermissions: mpDefaultPermissions(), // client-only: my own cached permissions
    pingMs: null,                           // client-only: my RTT to the host
    playerListCache: [],                    // last known player list (both sides, for HUD rendering)
    remoteCursors: [],                      // [{peerId, username, x, y}] - other players' cursors, world coords
    pendingSpawnRequestId: null,             // guest: train requested locally, awaiting host snapshot

    _lastSnapshotAt: 0,
    _lastSnapshotReceivedAt: 0,
    _snapshotBlendMs: 33,
    _lastPingAt: 0,
    _lastCursorAt: 0,
    lastCrashEventId: 0,

    // ---------------- Permission helpers (used all over game.js) ----------------

    can(key) {
        if (!this.active || this.isHost) return true;
        let p = this.myPermissions;
        if (key === 'timeWarp') return !!(p.timeWarp && p.timeWarp.allowed);
        return !!p[key];
    },

    myTimeWarpCap() {
        if (!this.active || this.isHost) return null;
        let p = this.myPermissions;
        return (p.timeWarp && typeof p.timeWarp.capX === 'number') ? p.timeWarp.capX : null;
    },

    sendInput(cmd) {
        if (!this.active || this.isHost) return;
        this._send({ type: 'INPUT_CMD', cmd });
    },

    broadcastTimeWarp(value) {
        if (!this.isHost) return;
        this._send({ type: 'TIME_WARP_UPDATE', value });
    },

    // ---------------- Room lifecycle ----------------

    // opts: { allowMidGameJoin, transport: 'lan'|'wan', wanRelayUrl }
    hostRoom(username, opts) {
        if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }
        opts = opts || {};

        this.username = username;
        this.isHost = true;
        this.roomSettings.limit = null; // unlimited players
        this.roomSettings.allowMidGameJoin = !!opts.allowMidGameJoin;
        this.transport = opts.transport === 'wan' ? 'wan' : 'lan';
        this.wanRelayUrl = opts.wanRelayUrl || null;

        if (this.transport === 'wan' && !this.wanRelayUrl) {
            showToast('Enter the relay address printed by relay.py first.');
            this.isHost = false;
            return;
        }
        this._hostOpen(3);
    },

    // Tries to claim a fresh room code as our host id. Collisions are rare
    // (5 chars from a 32-char alphabet = ~33M combinations) but both
    // PeerJS ('unavailable-id') and the relay ('room_taken') reject the
    // whole connection rather than just failing silently, so on that
    // specific error we just try again with a new code, up to
    // `attemptsLeft` times.
    _hostOpen(attemptsLeft) {
        this.roomCode = mpRandomRoomCode();
        let hostId = mpHostPeerId(this.roomCode);
        let peer;
        try {
            peer = (this.transport === 'wan')
                ? new WanPeer(hostId, { relayUrl: this.wanRelayUrl })
                : new window.Peer(hostId, { config: { iceServers: MP_ICE_SERVERS } });
        } catch (err) {
            console.error('Multiplayer host init error:', err);
            showToast("Couldn't open a multiplayer room. Check your connection and try again.");
            return;
        }
        this.peer = peer;

        let settled = false;
        peer.on('open', (id) => {
            settled = true;
            this.selfId = id;
            this.active = true;
            document.body.classList.add('mp-active');

            this.players[this.selfId] = {
                peerId: this.selfId,
                username: this.username,
                permissions: mpDefaultPermissions(),
                pingMs: 0,
                status: 'ready',
                isHost: true
            };

            document.body.classList.remove('mp-client-mode');
            UI.showLobby(true);
            this._broadcastPlayerList();
        });

        peer.on('connection', (conn) => this._hostOnConnection(conn));

        peer.on('error', (err) => {
            let retryable = err && (err.type === 'unavailable-id' || err.type === 'room_taken');
            if (!settled && retryable && attemptsLeft > 1) {
                peer.destroy();
                this._hostOpen(attemptsLeft - 1);
                return;
            }
            console.error('Multiplayer host error:', err);
            if (!settled) {
                showToast(this.transport === 'wan'
                    ? "Couldn't reach the relay. Open " + this.wanRelayUrl.replace(/^wss:/i, 'https:') + " in a browser tab and click through the certificate warning first, then make sure relay.py is still running and try again."
                    : "Couldn't open a multiplayer room. Check your connection and try again.");
            } else if (this.active) {
                showToast('A networking error occurred: ' + (err && err.type ? err.type : 'unknown'));
            }
        });
    },

    // opts: { transport: 'lan'|'wan', wanRelayUrl }
    joinRoom(code, username, opts) {
        opts = opts || {};
        let roomCode = (code || '').trim().toUpperCase();
        if (!roomCode) { showToast('Enter a room code.'); return; }
        let transport = opts.transport === 'wan' ? 'wan' : 'lan';
        let wanRelayUrl = opts.wanRelayUrl || null;
        if (transport === 'wan' && !wanRelayUrl) { showToast('Enter the relay address given by the host.'); return; }

        this._whenReady(transport, () => {
            this.username = username;
            this.isHost = false;
            this.roomCode = roomCode;
            this.transport = transport;
            this.wanRelayUrl = wanRelayUrl;

            let peer;
            try {
                peer = (transport === 'wan')
                    ? new WanPeer(null, { relayUrl: wanRelayUrl })
                    : new window.Peer({ config: { iceServers: MP_ICE_SERVERS } });
            } catch (err) {
                console.error('Multiplayer client init error:', err);
                showToast("Couldn't open a multiplayer connection. Check your connection and try again.");
                return;
            }
            this.peer = peer;
            document.body.classList.add('mp-client-mode');
            UI.showLobby(false);
            UI.setLobbyWaitingText('Connecting to host\u2026');

            let connected = false;
            peer.on('open', (id) => {
                // LAN (real PeerJS): the local peer already has its own id
                // at this point, independent of who it connects to.
                // WAN (WanPeer): there's no such thing - the relay only
                // assigns the client an id once it joins a specific room,
                // which arrives via the connection's 'open' event below.
                if (transport !== 'wan') this.selfId = id;
                let hostId = mpHostPeerId(roomCode);
                let conn = peer.connect(hostId, { reliable: true });
                this.hostConn = conn;

                conn.on('open', (connSelfId) => {
                    if (transport === 'wan') this.selfId = connSelfId;
                    connected = true;
                    this.active = true;
                    document.body.classList.add('mp-active');
                    this._send({ type: 'JOIN_REQUEST', username: this.username });
                });
                conn.on('data', (data) => this._onMessage(data, hostId));
                conn.on('close', () => this._clientHandleDisconnect());
                conn.on('error', (err) => {
                    console.error('Multiplayer client connection error:', err);
                });
            });

            peer.on('error', (err) => {
                console.error('Multiplayer client error:', err);
                if (err && err.type === 'peer-unavailable') {
                    showToast("Couldn't find that room - check the room code.");
                    this.leaveRoom();
                } else if (err && err.type === 'no_such_room') {
                    showToast("Couldn't find that room on the relay - check the room code and relay address.");
                    this.leaveRoom();
                } else if (!connected) {
                    showToast(transport === 'wan'
                        ? "Couldn't reach the host - first open " + wanRelayUrl.replace(/^wss:/i, 'https:') + " in a browser tab and click through the certificate warning, then check the relay address and try again."
                        : "Couldn't reach the host - check your connection and try again.");
                } else if (this.active) {
                    showToast('A networking error occurred: ' + (err && err.type ? err.type : 'unknown'));
                }
            });

            // WAN's first handshake to a self-signed relay can be much slower
            // than a normal WebSocket connect (slow TLS negotiation, distant/
            // congested network paths, etc.), so give it a soft heads-up at
            // 12s and only treat it as a real failure at 45s. LAN (PeerJS+STUN)
            // is normally fast, so it keeps the original 15s cutoff.
            let softMs = transport === 'wan' ? 12000 : 15000;
            let hardMs = transport === 'wan' ? 45000 : 15000;

            setTimeout(() => {
                if (!connected && this.active === false && this.peer === peer) {
                    UI.setLobbyWaitingText('Still connecting to host\u2026 this can take up to a minute the first time.');
                }
            }, softMs);

            setTimeout(() => {
                if (!connected && this.active === false && this.peer === peer) {
                    showToast(transport === 'wan'
                        ? "Couldn't reach the host - make sure you've opened " + wanRelayUrl.replace(/^wss:/i, 'https:') + " in a browser tab and clicked through the certificate warning, then check the relay address and room code, and that relay.py is still running."
                        : "Couldn't reach the host - check the room code, and that you're both online (signaling needs internet access even on a LAN).");
                }
            }, hardMs);
        });
    },

    // LAN mode loads PeerJS from a CDN script tag (see index.html), which
    // in the overwhelming majority of cases is ready long before a user
    // clicks Host/Join, but this covers the edge case (very slow network)
    // gracefully instead of throwing. WAN mode's WanPeer is defined in
    // this same file, so it's always immediately ready.
    _whenReady(transport, fn) {
        if (transport === 'wan' || window.Peer) { fn(); return; }
        showToast('Still connecting to the networking library\u2026');
        let tries = 0;
        let timer = setInterval(() => {
            tries++;
            if (window.Peer) {
                clearInterval(timer);
                fn();
            } else if (tries >= 40) { // ~8s at 200ms
                clearInterval(timer);
                showToast("Couldn't reach the networking library - check your connection and try again.");
            }
        }, 200);
    },

    _clientHandleDisconnect() {
        if (!this.active || this.isHost) return;
        showToast('Lost connection to the host.');
        this.leaveRoom();
    },

    leaveRoom() {
        this.active = false; // so a 'close' event fired by destroy() below doesn't also show a disconnect toast
        try { if (this.peer) this.peer.destroy(); } catch (e) { /* ignore */ }
        // Simplest way back to a clean state for either role.
        window.location.href = window.location.pathname;
    },

    startGame() {
        if (!this.isHost) return;
        let everyoneReady = Object.values(this.players).every(p => p.status === 'ready');
        if (!everyoneReady) return;
        this.started = true;
        UI.hideOverlay();
        UI.updateRoomPanel();
        document.getElementById('mp-hud').classList.remove('hidden');
        this._send({ type: 'START_GAME', simTimeSeconds, simSpeed });
    },

    kick(peerId) {
        if (!this.isHost || peerId === this.selfId) return;
        let p = this.players[peerId];
        this._send({ type: 'KICKED' }, peerId);
        delete this.players[peerId];
        let conn = this.conns[peerId];
        if (conn) { try { conn.close(); } catch (e) { /* ignore */ } delete this.conns[peerId]; }
        if (p) showToast(p.username + ' was removed from the room.');
        this._broadcastPlayerList();
    },

    setPermission(peerId, patch) {
        if (!this.isHost) return;
        let p = this.players[peerId];
        if (!p) return;
        if (patch.timeWarpAllowed !== undefined) p.permissions.timeWarp.allowed = !!patch.timeWarpAllowed;
        if (patch.timeWarpCap !== undefined) {
            let n = parseInt(patch.timeWarpCap, 10);
            p.permissions.timeWarp.capX = (isFinite(n) && n >= TIME_WARP_MIN) ? Math.min(n, TIME_WARP_MAX) : TIME_WARP_MAX;
        }
        if (patch.depotSpawnDespawn !== undefined) p.permissions.depotSpawnDespawn = !!patch.depotSpawnDespawn;
        if (patch.lineAndSignalControl !== undefined) p.permissions.lineAndSignalControl = !!patch.lineAndSignalControl;
        this._broadcastPlayerList();
    },

    // Host-side: a client's connection has come in. We don't know which
    // player this becomes until their JOIN_REQUEST arrives (that's where
    // this.players[peerId] gets created) - this just wires up plumbing.
    _hostOnConnection(conn) {
        let peerId = conn.peer;
        this.conns[peerId] = conn;
        conn.on('data', (data) => this._onMessage(data, peerId));
        conn.on('close', () => this._onPeerLeave(peerId));
        conn.on('error', (err) => console.error('Multiplayer host connection error:', err));
    },

    // Sends `data` to `target` (a peerId) if given, otherwise broadcasts to
    // everyone we're connected to. Clients only ever have one connection
    // (to the host), so `target` is irrelevant there - it's always the host.
    _send(data, target) {
        if (this.isHost) {
            if (target) {
                let c = this.conns[target];
                if (c && c.open) c.send(data);
            } else {
                for (let peerId in this.conns) {
                    let c = this.conns[peerId];
                    if (c.open) c.send(data);
                }
            }
        } else if (this.hostConn && this.hostConn.open) {
            this.hostConn.send(data);
        }
    },

    _onPeerLeave(peerId) {
        if (!this.isHost) return;
        delete this.conns[peerId];
        let p = this.players[peerId];
        if (p) {
            delete this.players[peerId];
            showToast(p.username + ' disconnected.');
            this._broadcastPlayerList();
        }
    },

    // ---------------- Message dispatch ----------------

    _onMessage(data, peerId) {
        if (!data || !data.type) return;
        if (this.isHost) this._onHostMessage(data, peerId);
        else this._onClientMessage(data, peerId);
    },

    _onHostMessage(data, peerId) {
        switch (data.type) {
            case 'JOIN_REQUEST': this._hostHandleJoinRequest(data, peerId); break;
            case 'MAP_ACK': this._hostHandleMapAck(peerId); break;
            case 'INPUT_CMD': this._hostHandleInput(data.cmd, peerId); break;
            case 'CURSOR': this._hostHandleCursor(data, peerId); break;
            case 'PING': this._send({ type: 'PONG', t: data.t }, peerId); break;
            case 'PONG': this._hostHandlePong(data, peerId); break;
        }
    },

    _onClientMessage(data, peerId) {
        switch (data.type) {
            case 'ROOM_FULL': showToast('That room is full.'); this.leaveRoom(); break;
            case 'GAME_IN_PROGRESS': showToast("That room isn't accepting new players right now."); this.leaveRoom(); break;
            case 'MAP_DATA': this._clientHandleMapData(data); break;
            case 'PLAYER_LIST': this._clientHandlePlayerList(data.players); break;
            case 'START_GAME': this._clientHandleStart(data); break;
            case 'STATE_SNAPSHOT': this.applySnapshot(data); break;
            case 'TIME_WARP_UPDATE': applyTimeWarpLocal(data.value); break;
            case 'PAUSE_UPDATE':
                setPaused(!!data.value);
                break;
            case 'KICKED': showToast('You were removed from the room.'); this.leaveRoom(); break;
            case 'PING': this._send({ type: 'PONG', t: data.t }); break;
            case 'PONG': this._clientHandlePong(data); break;
        }
    },

    // ---------------- Host-side handlers ----------------

    _hostHandleJoinRequest(data, peerId) {
        let count = Object.keys(this.players).length;
        if (this.roomSettings.limit && count >= this.roomSettings.limit) {
            this._send({ type: 'ROOM_FULL' }, peerId);
            return;
        }
        if (this.started && !this.roomSettings.allowMidGameJoin) {
            this._send({ type: 'GAME_IN_PROGRESS' }, peerId);
            return;
        }
        let username = String(data.username || 'Player').slice(0, 18) || 'Player';
        let existingNames = Object.values(this.players).map(p => p.username);
        if (existingNames.includes(username)) username = username + '-' + peerId.slice(0, 3);

        this.players[peerId] = {
            peerId, username,
            permissions: mpDefaultPermissions(),
            pingMs: null,
            status: 'downloading',
            isHost: false
        };
        this._broadcastPlayerList();
        this._send({
            type: 'MAP_DATA',
            diagram: {
                points: state.points, tracks: state.tracks, platforms: state.platforms,
                signals: state.signals, labels: state.labels, lines: state.lines, demand: state.demand,
                meta: state.meta
            }
        }, peerId);
    },

    _hostHandleMapAck(peerId) {
        let p = this.players[peerId];
        if (!p) return;
        p.status = 'ready';
        this._broadcastPlayerList();
        if (this.started) {
            // Mid-game join: get them caught up immediately instead of
            // waiting for the next periodic snapshot tick.
            this._send(this.buildSnapshot(), peerId);
        }
    },

    _hostHandleInput(cmd, peerId) {
        if (!cmd) return;
        let player = this.players[peerId];
        if (!player) return; // never trust a command from someone not in the room
        let perms = player.permissions;
        switch (cmd.type) {
            case 'SPAWN_TRAIN': {
                if (!perms.depotSpawnDespawn) return;
                let track = getTrack(cmd.trackId);
                if (track) {
                    let spawned = spawnTrainAt(track, { select: false, requestId: cmd.requestId });
                    // A remote command must never leave the host's panel
                    // pointing at the train just created for another player.
                    if (spawned && selectedTrainId === spawned.id) closeTrainPanel();
                }
                break;
            }
            case 'DESPAWN_TRAIN': {
                if (!perms.depotSpawnDespawn) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) despawnTrain(train);
                break;
            }
            case 'TOGGLE_SIGNAL': {
                if (!perms.lineAndSignalControl) return;
                let sig = state.signals.find(s => s.id === cmd.signalId);
                if (sig) toggleSignal(sig);
                break;
            }
            case 'ASSIGN_LINE': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) assignLineToTrain(train, cmd.lineId || null);
                break;
            }
            case 'SET_SPEED_CAP': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) setTrainSpeedCap(train, cmd.speedCapKmh);
                break;
            }
            case 'TOGGLE_BRAKE': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) toggleEmergencyBrake(train);
                break;
            }
            case 'REVERSE_TRAIN': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) reverseTrain(train);
                break;
            }
            case 'SET_PLATFORM': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train && train.pendingStop) setTrainPlatform(train, cmd.platformId);
                break;
            }
            case 'MANUAL_ROUTE': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) setManualTarget(train, cmd.trackId, cmd.distM, cmd.waypoints || []);
                break;
            }
            case 'ADJUST_ROUTE': {
                if (!perms.lineAndSignalControl) return;
                let train = trains.find(t => t.id === cmd.trainId);
                if (train) applyRouteAdjustment(train, cmd.trackId, cmd.distM);
                break;
            }
            case 'SET_TIME_WARP': {
                if (!perms.timeWarp || !perms.timeWarp.allowed) return;
                let v = cmd.value;
                if (typeof perms.timeWarp.capX === 'number') v = Math.min(v, perms.timeWarp.capX);
                applyTimeWarpLocal(v); // host is authoritative; this broadcasts TIME_WARP_UPDATE itself
                break;
            }
            case 'SET_PAUSED': {
                setPaused(!!cmd.value);
                this._send({ type: 'PAUSE_UPDATE', value: simPaused });
                break;
            }
            case 'REQUEST_RESTART': {
                // Not gated by a permission toggle, same as SET_PAUSED -
                // anyone stuck looking at a crash overlay can get the room
                // moving again. Only does anything once there's actually a
                // crash to clear, so it can't be used to reset a live game.
                if (!gameOver) return;
                resetGameState();
                break;
            }
        }
    },

    _hostHandlePong(data, peerId) {
        let p = this.players[peerId];
        if (!p) return;
        p.pingMs = Math.max(0, Math.round(performance.now() - data.t));
        this._broadcastPlayerList();
    },

    _hostHandleCursor(data, peerId) {
        let p = this.players[peerId];
        if (!p) return;
        p.cursor = (typeof data.x === 'number' && typeof data.y === 'number') ? { x: data.x, y: data.y } : null;
    },

    buildSnapshot() {
        let cursors = [];
        for (let peerId in this.players) {
            let p = this.players[peerId];
            let pos = p.isHost ? mpCursorWorld : p.cursor;
            if (pos) cursors.push({ peerId, username: p.username, x: pos.x, y: pos.y });
        }
        return {
            type: 'STATE_SNAPSHOT',
            simTimeSeconds, simSpeed, simPaused, gameOver,
            totalPassengersDelivered, totalPassengerScore,
            trains: trains,
            signals: state.signals.map(s => ({ id: s.id, state: s.state })),
            platforms: state.platforms.map(p => ({ id: p.id, waiting: p._waiting || {} })),
            crash: crashAnim ? {
                id: crashEventId,
                x: crashAnim.point.x,
                y: crashAnim.point.y,
                message: crashAnim.message,
                tiltRad: crashAnim.tiltRad
            } : null,
            cursors
        };
    },

    _broadcastPlayerList() {
        let list = Object.values(this.players).map(p => ({
            peerId: p.peerId, username: p.username, permissions: p.permissions,
            pingMs: p.pingMs, status: p.status, isHost: p.isHost
        }));
        this.playerListCache = list;
        this._send({ type: 'PLAYER_LIST', players: list });
        UI.onPlayerListChanged(list);
    },

    // ---------------- Client-side handlers ----------------

    _clientHandleMapData(data) {
        loadDiagram(data.diagram);
        this._send({ type: 'MAP_ACK' });
        UI.setLobbyWaitingText('Map downloaded \u2014 waiting for host to start\u2026');
    },

    _clientHandlePlayerList(list) {
        this.playerListCache = list || [];
        let me = this.playerListCache.find(p => p.peerId === this.selfId);
        if (me) {
            this.myPermissions = me.permissions;
            if (typeof me.pingMs === 'number') this.pingMs = me.pingMs;
        }
        UI.onPlayerListChanged(this.playerListCache);
    },

    _clientHandleStart(data) {
        this.started = true;
        simTimeSeconds = data.simTimeSeconds;
        simSpeed = data.simSpeed;
        totalPassengersDelivered = 0;
        totalPassengerScore = 0;
        updateClockDisplay();
        updatePaxScoreDisplay();
        speedSlider.value = simSpeed;
        speedLabel.textContent = simSpeed + 'x';
        UI.hideOverlay();
        UI.updateRoomPanel();
        document.getElementById('mp-hud').classList.remove('hidden');
    },

    _clientHandlePong(data) {
        this.pingMs = Math.max(0, Math.round(performance.now() - data.t));
        UI.onPlayerListChanged(this.playerListCache); // refresh my own ping badge
    },

    applySnapshot(data) {
        // Mid-game join: a client that connects after the host has already
        // started never gets a START_GAME message (that was broadcast to
        // whoever was in the room at the time) - the very first snapshot it
        // receives IS its signal that the game is already running, so do
        // the same UI transition _clientHandleStart does for everyone else.
        if (!this.started) {
            this.started = true;
            UI.hideOverlay();
            UI.updateRoomPanel();
            document.getElementById('mp-hud').classList.remove('hidden');
        }
        let receivedAt = performance.now();
        if (this._lastSnapshotReceivedAt) {
            this._snapshotBlendMs = Math.max(20, Math.min(200, receivedAt - this._lastSnapshotReceivedAt));
        }
        this._lastSnapshotReceivedAt = receivedAt;
        simTimeSeconds = data.simTimeSeconds;
        simSpeed = data.simSpeed;
        simPaused = data.simPaused;
        gameOver = data.gameOver;
        if (typeof data.totalPassengersDelivered === 'number') {
            totalPassengersDelivered = data.totalPassengersDelivered;
            totalPassengerScore = typeof data.totalPassengerScore === 'number' ? data.totalPassengerScore : totalPassengerScore;
            updatePaxScoreDisplay();
        }
        if (data.crash && data.crash.id !== this.lastCrashEventId) {
            this.lastCrashEventId = data.crash.id;
            gameOver = true;
            simPaused = true;
            setPaused(true);
            startCrashAnimation(
                { x: data.crash.x, y: data.crash.y },
                data.crash.message,
                data.crash.tiltRad,
                data.crash.id
            );
        } else if (!data.crash && crashAnim) {
            // Host restarted the sim (see REQUEST_RESTART) - drop the crash
            // camera animation locally too, or the tilted/zoomed view from
            // the last collision would stick around forever even though
            // gameOver just went back to false and the overlay is hidden.
            crashAnim = null;
        }
        let previousTrainIds = new Set(trains.map(train => train.id));
        let oldTrains = new Map(trains.map(train => [train.id, train]));
        trains = data.trains;
        for (let train of trains) {
            let old = oldTrains.get(train.id);
            let sameTrackAndDirection = old &&
                old.headTrackId === train.headTrackId &&
                old.headForward === train.headForward;
            train._renderHeadDist = sameTrackAndDirection
                ? old.headDist
                : train.headDist;
            train._targetHeadDist = train.headDist;
            train._interpolatePosition = !!sameTrackAndDirection;
            train._interpolateFrom = train._renderHeadDist;
            train._interpolateStartedAt = receivedAt;
            train._interpolateDuration = this._snapshotBlendMs;
        }
        // Occupancy is derived render/hit-test state and must be rebuilt on
        // guests after a JSON snapshot arrives.
        for (let train of trains) train._occ = getOccupiedEdges(train);
        if (this.pendingSpawnRequestId) {
            let spawned = trains.find(train =>
                !previousTrainIds.has(train.id) &&
                train.spawnRequestId === this.pendingSpawnRequestId
            );
            if (spawned) {
                this.pendingSpawnRequestId = null;
                selectTrain(spawned.id);
            }
        }
        for (let s of data.signals) {
            let sig = state.signals.find(x => x.id === s.id);
            if (sig) sig.state = s.state;
        }
        for (let p of (data.platforms || [])) {
            let platform = state.platforms.find(x => x.id === p.id);
            if (platform) platform._waiting = p.waiting || {};
        }
        this.remoteCursors = data.cursors || [];
        updateClockDisplay();
        document.getElementById('btn-pause').innerHTML = simPaused ? '&#9654;' : '&#10074;&#10074;';
        speedSlider.value = simSpeed;
        speedLabel.textContent = simSpeed + 'x';
        document.getElementById('gameover-overlay').classList.toggle('hidden', !gameOver);
    },

    // ---------------- Per-frame hooks, called from game.js's simTick ----------------

    hostTick(now) {
        if (!this.active) return;
        if (this.started && now - this._lastSnapshotAt >= 1000 / SNAPSHOT_HZ) {
            this._lastSnapshotAt = now;
            let snap = this.buildSnapshot();
            this.remoteCursors = snap.cursors; // so the host's own draw() sees everyone too
            this._send(snap);
        }
        if (now - this._lastPingAt >= PING_INTERVAL_MS) {
            this._lastPingAt = now;
            for (let peerId in this.players) {
                if (peerId === this.selfId) continue;
                this._send({ type: 'PING', t: performance.now() }, peerId);
            }
        }
    },

    clientTick(now) {
        for (let train of trains) {
            if (!train._interpolatePosition ||
                typeof train._targetHeadDist !== 'number' ||
                typeof train._interpolateStartedAt !== 'number') continue;
            let progress = Math.min(1, Math.max(0,
                (now - train._interpolateStartedAt) / train._interpolateDuration));
            train._renderHeadDist = train._interpolateFrom +
                (train._targetHeadDist - train._interpolateFrom) * progress;
            train.headDist = train._renderHeadDist;
            train._occ = getOccupiedEdges(train);
        }
        if (now - this._lastPingAt >= PING_INTERVAL_MS) {
            this._lastPingAt = now;
            this._send({ type: 'PING', t: performance.now() });
        }
        if (now - this._lastCursorAt >= CURSOR_INTERVAL_MS) {
            this._lastCursorAt = now;
            this._send({
                type: 'CURSOR',
                x: mpCursorWorld ? mpCursorWorld.x : null,
                y: mpCursorWorld ? mpCursorWorld.y : null
            });
        }
    }
};
window.MP = MP;

// ============================================================
// --- WAN transport: a minimal PeerJS-shaped shim over a plain
//     WebSocket, backed by the self-hosted relay.py dumb relay.
//     No STUN, no TURN, no cloud broker - relay.py just forwards
//     bytes between whichever sockets it's told to, blind to what's
//     inside. Everything above this point (room logic, permissions,
//     snapshots, game protocol) is unaware this exists; it only sees
//     the same on/connect/send/open/data/close/error shape PeerJS
//     already provides.
//
// Wire protocol with relay.py (JSON text frames):
//   -> {t:'hello', role:'host'|'client', room:'<id>'}      (first frame)
//   <- {t:'hello_ok', id:'<selfId>'}                       (accepted)
//   <- {t:'error', reason:'room_taken'|'no_such_room'}     (rejected)
//   <- {t:'join', id:'<clientId>'}                         (host only)
//   <- {t:'leave', id:'<clientId>'}                        (host only)
//   <- {t:'host_left'}                                     (client only)
//   -> {t:'data', to:'<clientId>'?, payload:<any>}         (host: to= targets one client, omit to broadcast)
//   -> {t:'data', payload:<any>}                           (client: always goes to the host)
//   <- {t:'data', from:'<clientId>'?, payload:<any>}       (host receives `from`; client doesn't need it - only one peer)
// ============================================================

class WanConnection {
    constructor(parentPeer, peerId) {
        this._peer = parentPeer;
        this.peer = peerId;   // remote id, mirrors PeerJS DataConnection.peer
        this.open = false;
        this._handlers = {};
    }
    on(evt, cb) { (this._handlers[evt] = this._handlers[evt] || []).push(cb); }
    _emit(evt, arg) {
        for (let cb of (this._handlers[evt] || [])) {
            try { cb(arg); } catch (e) { console.error(e); }
        }
    }
    send(data) {
        if (!this.open) return;
        this._peer._sendData(this.peer, data);
    }
    close() { this._markClosed(); }
    // `id`, when given, is this connection's own relay-assigned id (only
    // meaningful for the client's connection to the host - see hello_ok
    // handling below). Host-side connections don't pass one.
    _markOpen(id) { this.open = true; this._emit('open', id); }
    _markClosed() {
        if (!this.open) return;
        this.open = false;
        this._emit('close');
    }
}

class WanPeer {
    // hostId provided -> host role, registering exactly that room id
    //   (mirrors `new Peer(hostId)`).
    // no hostId -> client role; caller must call connect(hostId) next
    //   (mirrors `new Peer()`).
    constructor(hostId, opts) {
        opts = opts || {};
        this.relayUrl = opts.relayUrl;
        this._isHost = typeof hostId === 'string' && hostId.length > 0;
        this._room = this._isHost ? hostId : null;
        this._handlers = {};
        this._conns = {};        // host-only: clientId -> WanConnection
        this._clientConn = null; // client-only: the single connection to the host
        this._destroyed = false;
        this._connectSocket();
    }

    on(evt, cb) { (this._handlers[evt] = this._handlers[evt] || []).push(cb); }
    _emit(evt, arg) {
        for (let cb of (this._handlers[evt] || [])) {
            try { cb(arg); } catch (e) { console.error(e); }
        }
    }

    _connectSocket() {
        let ws;
        try {
            ws = new WebSocket(this.relayUrl);
        } catch (err) {
            this._emit('error', { type: 'network', message: String(err) });
            return;
        }
        this._ws = ws;
        ws.onopen = () => {
            if (this._isHost) {
                ws.send(JSON.stringify({ t: 'hello', role: 'host', room: this._room }));
                // Host's own id (the room code) is only confirmed once the
                // relay accepts it - see the 'hello_ok' case below.
            } else {
                // Client sends its hello from connect(), once it knows the
                // room id. Unlike PeerJS, this protocol has no independent
                // client id until it joins a room, so there's no id to pass
                // here - callers (net.js's joinRoom) don't need one yet,
                // they just need to know the socket is ready to connect().
                this._emit('open', null);
            }
        };
        ws.onmessage = (ev) => {
            let frame;
            try { frame = JSON.parse(ev.data); } catch (e) { return; }
            this._onFrame(frame);
        };
        ws.onerror = () => {
            this._emit('error', { type: 'network', message: 'Could not reach the relay server.' });
        };
        ws.onclose = () => {
            if (this._destroyed) return;
            if (this._isHost) {
                for (let id in this._conns) this._conns[id]._markClosed();
            } else if (this._clientConn) {
                this._clientConn._markClosed();
            }
        };
    }

    // Client role only, mirrors PeerJS `peer.connect(hostId)`.
    connect(hostId) {
        this._room = hostId;
        let conn = new WanConnection(this, 'host');
        this._clientConn = conn;
        let sendHello = () => this._ws.send(JSON.stringify({ t: 'hello', role: 'client', room: this._room }));
        if (this._ws.readyState === WebSocket.OPEN) sendHello();
        else this._ws.addEventListener('open', sendHello, { once: true });
        return conn;
    }

    _onFrame(f) {
        if (!f || !f.t) return;
        switch (f.t) {
            case 'hello_ok':
                if (this._isHost) this._emit('open', this._room);
                // Client's relay-assigned id arrives here, tied to this
                // specific connection to the host - pass it through so
                // callers can pick up their real self id.
                else if (this._clientConn) this._clientConn._markOpen(f.id);
                break;
            case 'error':
                this._emit('error', { type: f.reason || 'unknown' });
                break;
            case 'join': {
                if (!this._isHost) break;
                let conn = new WanConnection(this, f.id);
                this._conns[f.id] = conn;
                conn._markOpen();
                this._emit('connection', conn);
                break;
            }
            case 'leave': {
                if (!this._isHost) break;
                let conn = this._conns[f.id];
                if (conn) { conn._markClosed(); delete this._conns[f.id]; }
                break;
            }
            case 'host_left':
                if (this._clientConn) this._clientConn._markClosed();
                break;
            case 'data':
                if (this._isHost) {
                    let conn = this._conns[f.from];
                    if (conn) conn._emit('data', f.payload);
                } else if (this._clientConn) {
                    this._clientConn._emit('data', f.payload);
                }
                break;
        }
    }

    _sendData(targetId, payload) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (this._isHost) {
            this._ws.send(JSON.stringify({ t: 'data', to: targetId, payload }));
        } else {
            this._ws.send(JSON.stringify({ t: 'data', payload }));
        }
    }

    destroy() {
        this._destroyed = true;
        try { this._ws && this._ws.close(); } catch (e) { /* ignore */ }
    }
}

// ============================================================
// --- UI: menu / lobby / in-game HUD ---
// ============================================================

const UI = {
    _screens: ['mp-screen-main', 'mp-screen-username', 'mp-screen-mpmenu',
        'mp-screen-hostsetup', 'mp-screen-join', 'mp-screen-lobby'],
    _usernameNext: null, // function to call once a username has been entered
    _hostTransport: 'lan',
    _joinTransport: 'lan',

    show(id) {
        for (let s of this._screens) document.getElementById(s).classList.toggle('hidden', s !== id);
    },

    hideOverlay() {
        document.getElementById('mp-overlay').classList.add('hidden');
    },

    // Populates the in-game "Room" panel with the current room code and
    // (WAN only) relay address, so anyone - not just the host - can invite
    // more players once the game is already running (mid-game join).
    updateRoomPanel() {
        document.getElementById('mp-room-code').textContent = MP.roomCode || '';
        let isWan = MP.transport === 'wan' && !!MP.wanRelayUrl;
        document.getElementById('mp-room-relay-row').classList.toggle('hidden', !isWan);
        if (isWan) {
            document.getElementById('mp-room-relay').textContent = MP.wanRelayUrl.replace(/^wss?:\/\//i, '');
        }
    },

    goUsername(nextFn) {
        this._usernameNext = nextFn;
        let saved = localStorage.getItem('trainsig_username') || '';
        document.getElementById('mp-username-input').value = saved;
        this.show('mp-screen-username');
    },

    updateHostSetupMapStatus() {
        let el = document.getElementById('mp-hostsetup-mapstatus');
        let goBtn = document.getElementById('mp-hostsetup-go');
        if (!el || !goBtn) return;
        if (hasLoadedDiagram) {
            let pts = (state.points || []).length;
            let tracks = (state.tracks || []).length;
            let name = (state.meta && state.meta.name) ? state.meta.name : 'Map loaded';
            el.textContent = `${name} \u2713 (${pts} points, ${tracks} tracks)`;
            el.classList.add('ok');
        } else {
            el.textContent = 'No diagram loaded yet.';
            el.classList.remove('ok');
        }
        goBtn.disabled = !hasLoadedDiagram;
    },

    // Toggles the LAN/WAN choice on the "Host a room" screen.
    setHostTransport(mode) {
        this._hostTransport = mode;
        document.getElementById('mp-host-transport-lan').classList.toggle('btn-primary', mode === 'lan');
        document.getElementById('mp-host-transport-wan').classList.toggle('btn-primary', mode === 'wan');
        document.getElementById('mp-host-wan-fields').classList.toggle('hidden', mode !== 'wan');
        document.getElementById('mp-host-lan-hint').classList.toggle('hidden', mode !== 'lan');
    },

    // Toggles the LAN/WAN choice on the "Join a room" screen.
    setJoinTransport(mode) {
        this._joinTransport = mode;
        document.getElementById('mp-join-transport-lan').classList.toggle('btn-primary', mode === 'lan');
        document.getElementById('mp-join-transport-wan').classList.toggle('btn-primary', mode === 'wan');
        document.getElementById('mp-join-wan-fields').classList.toggle('hidden', mode !== 'wan');
    },

    showLobby(isHost) {
        this.show('mp-screen-lobby');
        document.getElementById('mp-lobby-title').textContent = isHost ? 'Your room' : 'Joining room';
        document.getElementById('mp-lobby-roomcode-row').classList.toggle('hidden', !isHost);
        if (isHost) document.getElementById('mp-lobby-roomcode').textContent = MP.roomCode;
        document.getElementById('mp-lobby-hostcontrols').classList.toggle('hidden', !isHost);
        document.getElementById('mp-lobby-waiting').classList.toggle('hidden', isHost);
    },

    setLobbyWaitingText(text) {
        let el = document.getElementById('mp-lobby-waiting');
        el.textContent = text;
        el.classList.remove('hidden');
    },

    onPlayerListChanged(list) {
        this.renderPlayerList(document.getElementById('mp-lobby-players'), list, 'lobby');
        this.renderPlayerList(document.getElementById('mp-hud-list'), list, 'hud');
        if (MP.isHost) {
            let everyoneReady = list.length > 0 && list.every(p => p.status === 'ready');
            let btn = document.getElementById('mp-lobby-start');
            btn.disabled = !everyoneReady;
            btn.textContent = everyoneReady ? 'Start Game' : 'Start (waiting for players\u2026)';
        }
    },

    pingClass(ms) {
        if (ms == null) return '';
        if (ms < 60) return 'good';
        if (ms < 150) return 'ok';
        return 'bad';
    },

    renderPlayerRow(p, mode) {
        let mine = p.peerId === MP.selfId;
        let pingVal = mine ? MP.pingMs : p.pingMs;
        let pingText = p.isHost ? 'host' : (pingVal == null ? '\u2026' : pingVal + 'ms');
        let pingClass = p.isHost ? '' : this.pingClass(pingVal);

        let row = document.createElement('div');
        row.className = 'mp-player-row';

        let top = document.createElement('div');
        top.className = 'mp-player-row-top';
        let nameWrap = document.createElement('div');
        nameWrap.className = 'mp-player-name';
        nameWrap.textContent = p.username + (mine ? ' (you)' : '');
        if (p.isHost) {
            let tag = document.createElement('span');
            tag.className = 'mp-host-tag';
            tag.textContent = 'HOST';
            nameWrap.appendChild(tag);
        }
        top.appendChild(nameWrap);

        let right = document.createElement('div');
        right.style.display = 'flex';
        right.style.alignItems = 'center';
        right.style.gap = '6px';
        let ping = document.createElement('span');
        ping.className = 'mp-ping ' + pingClass;
        ping.textContent = pingText;
        right.appendChild(ping);
        if (MP.isHost && !p.isHost && mode === 'lobby') {
            let kick = document.createElement('button');
            kick.className = 'mp-kick-btn';
            kick.textContent = 'Kick';
            kick.addEventListener('click', () => MP.kick(p.peerId));
            right.appendChild(kick);
        }
        top.appendChild(right);
        row.appendChild(top);

        if (mode === 'lobby' && !p.isHost) {
            let status = document.createElement('div');
            status.className = 'mp-status' + (p.status === 'ready' ? ' ready' : '');
            status.textContent = p.status === 'ready' ? 'Map ready' :
                p.status === 'downloading' ? 'Downloading map\u2026' : p.status;
            row.appendChild(status);
        }

        // Host gets live permission toggles for every non-host player, in
        // both the lobby and the in-game HUD (permissions can change mid-game).
        if (MP.isHost && !p.isHost) {
            let perms = document.createElement('div');
            perms.className = 'mp-perms';

            let mkToggle = (label, on, onClick) => {
                let b = document.createElement('button');
                b.className = 'mp-perm-toggle' + (on ? ' on' : '');
                b.textContent = label;
                b.addEventListener('click', onClick);
                return b;
            };
            perms.appendChild(mkToggle('Time warp', p.permissions.timeWarp.allowed,
                () => MP.setPermission(p.peerId, { timeWarpAllowed: !p.permissions.timeWarp.allowed })));
            perms.appendChild(mkToggle('Spawn/despawn', p.permissions.depotSpawnDespawn,
                () => MP.setPermission(p.peerId, { depotSpawnDespawn: !p.permissions.depotSpawnDespawn })));
            perms.appendChild(mkToggle('Lines/signals', p.permissions.lineAndSignalControl,
                () => MP.setPermission(p.peerId, { lineAndSignalControl: !p.permissions.lineAndSignalControl })));
            row.appendChild(perms);

            let capRow = document.createElement('div');
            capRow.className = 'mp-perm-cap';
            let capLabel = document.createElement('span');
            capLabel.textContent = 'Time warp cap:';
            let capInput = document.createElement('input');
            capInput.type = 'number';
            capInput.min = String(TIME_WARP_MIN);
            capInput.max = String(TIME_WARP_MAX);
            capInput.value = p.permissions.timeWarp.capX;
            capInput.addEventListener('change', () => MP.setPermission(p.peerId, { timeWarpCap: capInput.value }));
            let capSuffix = document.createElement('span');
            capSuffix.textContent = 'x';
            capRow.appendChild(capLabel);
            capRow.appendChild(capInput);
            capRow.appendChild(capSuffix);
            row.appendChild(capRow);
        } else if (!MP.isHost && mode === 'hud' && !p.isHost && mine) {
            // A client's own read-only permission summary in the HUD.
            let perms = document.createElement('div');
            perms.className = 'mp-perms';
            let tag = (label, on) => {
                let s = document.createElement('span');
                s.className = 'mp-perm-toggle' + (on ? ' on' : '');
                s.textContent = label + (label === 'Time warp' && on ? (' \u2264' + p.permissions.timeWarp.capX + 'x') : '');
                return s;
            };
            perms.appendChild(tag('Time warp', p.permissions.timeWarp.allowed));
            perms.appendChild(tag('Spawn/despawn', p.permissions.depotSpawnDespawn));
            perms.appendChild(tag('Lines/signals', p.permissions.lineAndSignalControl));
            row.appendChild(perms);
        }

        return row;
    },

    renderPlayerList(container, list, mode) {
        if (!container) return;
        container.innerHTML = '';
        for (let p of list) container.appendChild(this.renderPlayerRow(p, mode));
    }
};

// ============================================================
// --- Wire up the menu/lobby buttons ---
// ============================================================

document.getElementById('mp-btn-singleplayer').addEventListener('click', () => {
    UI.hideOverlay();
});

document.getElementById('mp-btn-multiplayer').addEventListener('click', () => UI.show('mp-screen-mpmenu'));
document.getElementById('mp-mpmenu-back').addEventListener('click', () => UI.show('mp-screen-main'));

document.getElementById('mp-btn-host').addEventListener('click', () => {
    UI.show('mp-screen-hostsetup');
    UI.updateHostSetupMapStatus();
    UI.setHostTransport('lan');
});
document.getElementById('mp-hostsetup-back').addEventListener('click', () => UI.show('mp-screen-mpmenu'));
document.getElementById('mp-hostsetup-import').addEventListener('click', () => {
    if (MP.active) { showToast('Map import is disabled during multiplayer.'); return; }
    importInput.click();
});
window.addEventListener('diagram-loaded', () => UI.updateHostSetupMapStatus());

document.getElementById('mp-host-transport-lan').addEventListener('click', () => UI.setHostTransport('lan'));
document.getElementById('mp-host-transport-wan').addEventListener('click', () => UI.setHostTransport('wan'));

document.getElementById('mp-hostsetup-go').addEventListener('click', () => {
    if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }
    let transport = UI._hostTransport;
    let relayInput = document.getElementById('mp-host-relay-input').value.trim();
    if (transport === 'wan' && !relayInput) { showToast('Enter the relay address printed by relay.py.'); return; }
    UI.goUsername(() => {
        MP.hostRoom(UI._pendingUsername, {
            allowMidGameJoin: document.getElementById('mp-host-midjoin').checked,
            transport,
            wanRelayUrl: transport === 'wan' ? ('wss://' + relayInput.replace(/^wss?:\/\//i, '')) : null
        });
    });
});

document.getElementById('mp-btn-join').addEventListener('click', () => {
    UI.show('mp-screen-join');
    UI.setJoinTransport('lan');
});
document.getElementById('mp-join-back').addEventListener('click', () => UI.show('mp-screen-mpmenu'));

document.getElementById('mp-join-transport-lan').addEventListener('click', () => UI.setJoinTransport('lan'));
document.getElementById('mp-join-transport-wan').addEventListener('click', () => UI.setJoinTransport('wan'));

document.getElementById('mp-join-go').addEventListener('click', () => {
    let code = document.getElementById('mp-join-code').value;
    let transport = UI._joinTransport;
    let relayInput = document.getElementById('mp-join-relay-input').value.trim();
    if (transport === 'wan' && !relayInput) { showToast('Enter the relay address given by the host.'); return; }
    UI.goUsername(() => MP.joinRoom(code, UI._pendingUsername, {
        transport,
        wanRelayUrl: transport === 'wan' ? ('wss://' + relayInput.replace(/^wss?:\/\//i, '')) : null
    }));
});

document.getElementById('mp-username-back').addEventListener('click', () => UI.show('mp-screen-mpmenu'));
document.getElementById('mp-username-next').addEventListener('click', () => {
    let name = document.getElementById('mp-username-input').value.trim().slice(0, 18) || 'Player';
    localStorage.setItem('trainsig_username', name);
    UI._pendingUsername = name;
    if (UI._usernameNext) UI._usernameNext();
});

document.getElementById('mp-lobby-start').addEventListener('click', () => MP.startGame());
document.getElementById('mp-lobby-leave').addEventListener('click', () => MP.leaveRoom());

function mpCopyInviteLink() {
    let url = window.location.origin + window.location.pathname + '?room=' + MP.roomCode;
    if (MP.transport === 'wan' && MP.wanRelayUrl) {
        url += '&relay=' + encodeURIComponent(MP.wanRelayUrl.replace(/^wss?:\/\//i, ''));
    }
    navigator.clipboard.writeText(url).then(
        () => showToast('Invite link copied.'),
        () => showToast('Room code: ' + MP.roomCode)
    );
}
document.getElementById('mp-lobby-copy').addEventListener('click', mpCopyInviteLink);
document.getElementById('mp-room-copy').addEventListener('click', mpCopyInviteLink);

document.getElementById('mp-hud-toggle').addEventListener('click', () => {
    document.getElementById('mp-hud-list').classList.toggle('open');
});
document.getElementById('mp-room-toggle').addEventListener('click', () => {
    document.getElementById('mp-room-panel').classList.toggle('open');
});

// ---- Boot: invite links can pre-fill the room code (and, for WAN, the
// relay address) so joining is a single click.
(function mpBoot() {
    let params = new URLSearchParams(window.location.search);
    let roomFromLink = params.get('room');
    let relayFromLink = params.get('relay');
    if (roomFromLink) {
        document.getElementById('mp-join-code').value = roomFromLink;
        if (relayFromLink) {
            document.getElementById('mp-join-relay-input').value = relayFromLink;
            UI.setJoinTransport('wan');
        }
        UI.goUsername(() => MP.joinRoom(roomFromLink, UI._pendingUsername, {
            transport: relayFromLink ? 'wan' : 'lan',
            wanRelayUrl: relayFromLink ? ('wss://' + relayFromLink) : null
        }));
    } else {
        UI.show('mp-screen-main');
    }
})();