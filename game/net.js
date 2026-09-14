/**
 * net.js - Multiplayer layer for TrainSig.
 *
 * SERVERLESS*, FREE, LOW-LATENCY:
 * All game traffic flows directly over a WebRTC data channel. The offer and
 * answer are copied between browsers once during setup, so this needs no
 * signaling server and works from a static GitHub Pages site.
 *
 * The host-authoritative game protocol below is unchanged; only the transport
 * setup is deliberately small and limited to one LAN guest.
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
 * A real star, not just a logical one. Unlike a mesh library, PeerJS
 * connects exactly the pairs we ask it to: the host runs a single Peer
 * whose ID is derived from the room code, and each client runs its own
 * Peer (random ID, assigned by the signaling server) and opens ONE
 * DataConnection directly to the host's Peer ID. Clients never connect
 * to each other - there is no other WebRTC link to accidentally rely on.
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
const SNAPSHOT_HZ = 15;           // host -> clients state broadcast rate
const PING_INTERVAL_MS = 2000;
const CURSOR_INTERVAL_MS = 100;   // 10Hz cursor position updates

// No hosted signaling or relay is used: host candidates are enough for
// browsers on the same local network.
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

// Deterministic color per player, derived from their PeerJS peerId, so
// every client independently draws the same player in the same color
// without the host needing to assign and broadcast one.
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
    peer: null,          // this machine's PeerJS Peer instance
    selfId: null,
    username: null,
    roomCode: null,

    conns: {},            // host-only: peerId -> open PeerJS DataConnection
    hostConn: null,       // client-only: the single DataConnection to the host
    players: {},         // host-only: peerId -> player record (source of truth)
    roomSettings: { limit: null, allowMidGameJoin: true },
    started: false,

    myPermissions: mpDefaultPermissions(), // client-only: my own cached permissions
    pingMs: null,                           // client-only: my RTT to the host
    playerListCache: [],                    // last known player list (both sides, for HUD rendering)
    remoteCursors: [],                      // [{peerId, username, x, y}] - other players' cursors, world coords

    _lastSnapshotAt: 0,
    _lastPingAt: 0,
    _lastCursorAt: 0,

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

    hostRoom(username, opts) {
        if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }

        this.username = username;
        this.isHost = true;
        this.roomSettings.limit = 1;
        this.roomSettings.allowMidGameJoin = !!opts.allowMidGameJoin;
        this._hostOpen();
    },

    // Tries to claim a fresh room code as our PeerJS ID. Collisions are rare
    // (5 chars from a 32-char alphabet = ~33M combinations) but PeerJS
    // rejects the whole Peer with an 'unavailable-id' error if the ID is
    // already claimed on the broker, rather than just failing that one
    // connection - so on that specific error we just try again with a new
    // code, up to `attemptsLeft` times.
    _hostOpen(attemptsLeft) {
        this.roomCode = mpRandomRoomCode();
        let hostId = mpHostPeerId(this.roomCode);
        let peer;
        try {
            peer = new window.Peer(hostId, { config: { iceServers: MP_ICE_SERVERS } });
        } catch (err) {
            console.error('PeerJS host init error:', err);
            showToast("Couldn't open a multiplayer room. Check your connection and try again.");
            return;
        }
        this.peer = peer;

        let settled = false;
        peer.on('open', (id) => {
            settled = true;
            this.selfId = id;
            this.active = true;

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
            if (!settled && err && err.type === 'unavailable-id' && attemptsLeft > 1) {
                peer.destroy();
                this._hostOpen(attemptsLeft - 1);
                return;
            }
            console.error('PeerJS host error:', err);
            if (!settled) {
                showToast("Couldn't open a multiplayer room. Check your connection and try again.");
            } else if (this.active) {
                showToast('A networking error occurred: ' + (err && err.type ? err.type : 'unknown'));
            }
        });
    },

    joinRoom(code, username) {
        let roomCode = (code || '').trim().toUpperCase();
        if (!roomCode) { showToast('Enter a room code.'); return; }

        this._whenReady(() => {
            this.username = username;
            this.isHost = false;
            this.roomCode = roomCode;

            let peer;
            try {
                peer = new window.Peer({ config: { iceServers: MP_ICE_SERVERS } });
            } catch (err) {
                console.error('PeerJS client init error:', err);
                showToast("Couldn't open a multiplayer connection. Check your connection and try again.");
                return;
            }
            this.peer = peer;
            document.body.classList.add('mp-client-mode');
            UI.showLobby(false);
            UI.setLobbyWaitingText('Connecting to host\u2026');

            let connected = false;
            peer.on('open', (id) => {
                this.selfId = id;
                let hostId = mpHostPeerId(roomCode);
                let conn = peer.connect(hostId, { reliable: true });
                this.hostConn = conn;

                conn.on('open', () => {
                    connected = true;
                    this.active = true;
                    this._send({ type: 'JOIN_REQUEST', username: this.username });
                });
                conn.on('data', (data) => this._onMessage(data, hostId));
                conn.on('close', () => this._clientHandleDisconnect());
                conn.on('error', (err) => {
                    console.error('PeerJS client connection error:', err);
                });
            });

            peer.on('error', (err) => {
                console.error('PeerJS client error:', err);
                if (err && err.type === 'peer-unavailable') {
                    showToast("Couldn't find that room - check the room code.");
                    this.leaveRoom();
                } else if (!connected) {
                    showToast("Couldn't reach the host - check your connection and try again.");
                } else if (this.active) {
                    showToast('A networking error occurred: ' + (err && err.type ? err.type : 'unknown'));
                }
            });

            setTimeout(() => {
                if (!connected && this.active === false && this.peer === peer) {
                    showToast("Couldn't reach the host - check the room code, and that you're both online (signaling needs internet access even on a LAN).");
                }
            }, 15000);
        });
    },

    // PeerJS loads from a CDN script tag (see index.html) which in the
    // overwhelming majority of cases is ready long before a user clicks
    // Host/Join, but this covers the edge case (very slow network)
    // gracefully instead of throwing.
    _whenReady(fn) {
        if (window.Peer) { fn(); return; }
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

    // Host-side: a client's DataConnection has come in. We don't know which
    // player this becomes until their JOIN_REQUEST arrives (that's where
    // this.players[peerId] gets created) - this just wires up plumbing.
    _hostOnConnection(conn) {
        let peerId = conn.peer;
        this.conns[peerId] = conn;
        conn.on('data', (data) => this._onMessage(data, peerId));
        conn.on('close', () => this._onPeerLeave(peerId));
        conn.on('error', (err) => console.error('PeerJS host connection error:', err));
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
                signals: state.signals, labels: state.labels, lines: state.lines, demand: state.demand
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
                if (track) spawnTrainAt(track);
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
            case 'SET_TIME_WARP': {
                if (!perms.timeWarp || !perms.timeWarp.allowed) return;
                let v = cmd.value;
                if (typeof perms.timeWarp.capX === 'number') v = Math.min(v, perms.timeWarp.capX);
                applyTimeWarpLocal(v); // host is authoritative; this broadcasts TIME_WARP_UPDATE itself
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
            trains: trains,
            signals: state.signals.map(s => ({ id: s.id, state: s.state })),
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
        updateClockDisplay();
        speedSlider.value = simSpeed;
        speedLabel.textContent = simSpeed + 'x';
        UI.hideOverlay();
        document.getElementById('mp-hud').classList.remove('hidden');
    },

    _clientHandlePong(data) {
        this.pingMs = Math.max(0, Math.round(performance.now() - data.t));
        UI.onPlayerListChanged(this.playerListCache); // refresh my own ping badge
    },

    applySnapshot(data) {
        simTimeSeconds = data.simTimeSeconds;
        simSpeed = data.simSpeed;
        simPaused = data.simPaused;
        gameOver = data.gameOver;
        trains = data.trains;
        for (let s of data.signals) {
            let sig = state.signals.find(x => x.id === s.id);
            if (sig) sig.state = s.state;
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

// Static-site multiplayer transport. Signaling is intentionally manual:
// players exchange one offer and one answer, then all game data is direct.
function mpWaitForIce(peer) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
        let done = () => {
            if (peer.iceGatheringState === 'complete') {
                peer.removeEventListener('icegatheringstatechange', done);
                resolve();
            }
        };
        peer.addEventListener('icegatheringstatechange', done);
        setTimeout(() => {
            peer.removeEventListener('icegatheringstatechange', done);
            resolve();
        }, 5000);
    });
}

MP._wireChannel = function (channel, peerId) {
    channel.onmessage = event => {
        let data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        this._onMessage(data, peerId);
    };
    channel.onclose = () => this._onPeerLeave(peerId);
    channel.onerror = event => console.error('WebRTC data channel error:', event);
};

MP._hostOnConnection = function (channel, peerId) {
    let id = peerId || 'guest';
    this.conns[id] = channel;
    this._wireChannel(channel, id);
    channel.onopen = () => {
        if (this.active) showToast('Player connected. You can start the game.');
    };
};

MP._clientOnConnection = function (channel) {
    this.hostConn = channel;
    this._wireChannel(channel, 'host');
    channel.onopen = () => {
        this.active = true;
        this._send({ type: 'JOIN_REQUEST', username: this.username });
    };
};

MP._send = function (data, target) {
    if (this.isHost) {
        if (target) {
            let channel = this.conns[target];
            if (channel && channel.readyState === 'open') channel.send(JSON.stringify(data));
        } else {
            Object.values(this.conns).forEach(channel => {
                if (channel.readyState === 'open') channel.send(JSON.stringify(data));
            });
        }
    } else if (this.hostConn && this.hostConn.readyState === 'open') {
        this.hostConn.send(JSON.stringify(data));
    }
};

MP._hostOnConnection = function (conn) {
    let peerId = conn.peer;
    this.conns[peerId] = conn;
    conn.on('data', data => this._onMessage(data, peerId));
    conn.on('close', () => this._onPeerLeave(peerId));
    conn.on('error', err => console.error('PeerJS host connection error:', err));
};

MP.leaveRoom = function () {
    this.active = false;
    if (this.peer) this.peer.destroy();
    window.location.href = window.location.pathname;
};

MP.hostRoom = async function (username, opts) {
    if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }
    try {
        this.username = username;
        this.isHost = true;
        this.roomSettings.limit = 1;
        this.roomSettings.allowMidGameJoin = !!opts.allowMidGameJoin;
        this.peer = new RTCPeerConnection({ iceServers: MP_ICE_SERVERS });
        this.selfId = 'host';
        this._hostOnConnection(this.peer.createDataChannel('trainsig', { ordered: true }), 'guest');
        await this.peer.setLocalDescription(await this.peer.createOffer());
        await mpWaitForIce(this.peer);
        document.getElementById('mp-host-offer').value = JSON.stringify(this.peer.localDescription);
        document.getElementById('mp-host-signaling').classList.remove('hidden');
        this.active = true;
        this.players[this.selfId] = {
            peerId: this.selfId, username: this.username, permissions: mpDefaultPermissions(),
            pingMs: 0, status: 'ready', isHost: true
        };
        UI.showLobby(true);
        this._broadcastPlayerList();
    } catch (err) {
        console.error('WebRTC host setup error:', err);
        showToast("Couldn't create a LAN room. Use a modern browser and try again.");
    }
};

MP.joinRoom = async function (offerText, username) {
    try {
        this.username = username;
        this.isHost = false;
        this.selfId = 'guest-' + Math.random().toString(36).slice(2, 8);
        this.peer = new RTCPeerConnection({ iceServers: MP_ICE_SERVERS });
        this.peer.ondatachannel = event => this._clientOnConnection(event.channel);
        await this.peer.setRemoteDescription(JSON.parse((offerText || '').trim()));
        await this.peer.setLocalDescription(await this.peer.createAnswer());
        await mpWaitForIce(this.peer);
        document.getElementById('mp-join-answer').value = JSON.stringify(this.peer.localDescription);
        document.getElementById('mp-join-signaling').classList.remove('hidden');
        document.body.classList.add('mp-client-mode');
        UI.showLobby(false);
        UI.setLobbyWaitingText('Send the answer to the host. Waiting for connection\u2026');
    } catch (err) {
        console.error('WebRTC join setup error:', err);
        showToast('That offer is invalid or could not be opened.');
    }
};

MP.connectHost = async function (answerText) {
    if (!this.isHost || !this.peer) return;
    try {
        await this.peer.setRemoteDescription(JSON.parse((answerText || '').trim()));
        showToast('Answer accepted. Waiting for the player to connect\u2026');
    } catch (err) {
        console.error('WebRTC answer error:', err);
        showToast('That answer is invalid. Paste the complete answer and try again.');
    }
};

MP.leaveRoom = function () {
    this.active = false;
    if (this.peer) this.peer.close();
    window.location.href = window.location.pathname;
};

// Simple room-code transport for static hosting. PeerJS is only used for
// discovery/signaling; game traffic remains on the direct WebRTC channel.
MP.hostRoom = function (username, opts) {
    if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }
    this.username = username;
    this.isHost = true;
    this.roomSettings.limit = 1;
    this.roomSettings.allowMidGameJoin = !!opts.allowMidGameJoin;
    this._hostOpen(3);
};

MP.joinRoom = function (code, username) {
    let roomCode = (code || '').trim().toUpperCase();
    if (!roomCode) { showToast('Enter a room code.'); return; }
    this._whenReady(() => {
        this.username = username;
        this.isHost = false;
        this.roomCode = roomCode;
        let peer;
        try {
            peer = new window.Peer({ config: { iceServers: MP_ICE_SERVERS } });
        } catch (err) {
            console.error('PeerJS client init error:', err);
            showToast("Couldn't open a multiplayer connection. Check your connection and try again.");
            return;
        }
        this.peer = peer;
        document.body.classList.add('mp-client-mode');
        UI.showLobby(false);
        UI.setLobbyWaitingText('Connecting to host...');
        let connected = false;
        peer.on('open', id => {
            this.selfId = id;
            let conn = peer.connect(mpHostPeerId(roomCode), { reliable: true });
            this.hostConn = conn;
            conn.on('open', () => {
                connected = true;
                this.active = true;
                this._send({ type: 'JOIN_REQUEST', username: this.username });
            });
            conn.on('data', data => this._onMessage(data, mpHostPeerId(roomCode)));
            conn.on('close', () => this._clientHandleDisconnect());
            conn.on('error', err => console.error('PeerJS client connection error:', err));
        });
        peer.on('error', err => {
            console.error('PeerJS client error:', err);
            if (!connected) {
                showToast(err && err.type === 'peer-unavailable'
                    ? "Couldn't find that room. Check the code."
                    : "Couldn't reach the host. Check both players are online.");
                this.leaveRoom();
            }
        });
    });
};

MP._send = function (data, target) {
    if (this.isHost) {
        if (target) {
            let conn = this.conns[target];
            if (conn && conn.open) conn.send(data);
        } else {
            Object.values(this.conns).forEach(conn => {
                if (conn.open) conn.send(data);
            });
        }
    } else if (this.hostConn && this.hostConn.open) {
        this.hostConn.send(data);
    }
};

// ============================================================
// --- UI: menu / lobby / in-game HUD ---
// ============================================================

const UI = {
    _screens: ['mp-screen-main', 'mp-screen-username', 'mp-screen-mpmenu',
        'mp-screen-hostsetup', 'mp-screen-join', 'mp-screen-lobby'],
    _usernameNext: null, // function to call once a username has been entered

    show(id) {
        for (let s of this._screens) document.getElementById(s).classList.toggle('hidden', s !== id);
    },

    hideOverlay() {
        document.getElementById('mp-overlay').classList.add('hidden');
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
            el.textContent = `Map loaded \u2713 (${pts} points, ${tracks} tracks)`;
            el.classList.add('ok');
        } else {
            el.textContent = 'No diagram loaded yet.';
            el.classList.remove('ok');
        }
        goBtn.disabled = !hasLoadedDiagram;
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
});
document.getElementById('mp-hostsetup-back').addEventListener('click', () => UI.show('mp-screen-mpmenu'));
document.getElementById('mp-hostsetup-import').addEventListener('click', () => importInput.click());
window.addEventListener('diagram-loaded', () => UI.updateHostSetupMapStatus());
document.getElementById('mp-hostsetup-go').addEventListener('click', () => {
    if (!hasLoadedDiagram) { showToast('Import or build a diagram before hosting.'); return; }
    UI.goUsername(() => {
        MP.hostRoom(UI._pendingUsername, { limit: 1, allowMidGameJoin: true });
    });
});

document.getElementById('mp-btn-join').addEventListener('click', () => UI.show('mp-screen-join'));
document.getElementById('mp-join-back').addEventListener('click', () => UI.show('mp-screen-mpmenu'));
document.getElementById('mp-join-go').addEventListener('click', () => {
    let code = document.getElementById('mp-join-code').value;
    UI.goUsername(() => MP.joinRoom(code, UI._pendingUsername));
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
document.getElementById('mp-lobby-copy').addEventListener('click', () => {
    let url = window.location.origin + window.location.pathname + '?room=' + MP.roomCode;
    navigator.clipboard.writeText(url).then(
        () => showToast('Invite link copied.'),
        () => showToast('Room code: ' + MP.roomCode)
    );
});

document.getElementById('mp-hud-toggle').addEventListener('click', () => {
    document.getElementById('mp-hud-list').classList.toggle('open');
});

// ---- Boot: invite links can pre-fill the room code.
(function mpBoot() {
    let roomFromLink = new URLSearchParams(window.location.search).get('room');
    if (roomFromLink) {
        document.getElementById('mp-join-code').value = roomFromLink;
        UI.goUsername(() => MP.joinRoom(roomFromLink, UI._pendingUsername));
    } else {
        UI.show('mp-screen-main');
    }
})();