/**
 * TrainSig - gameplay mode
 *
 * Loads a diagram exported from the Builder (points, tracks, platforms,
 * signals, labels, lines, demand) and simulates live train service on it:
 * spawning/despawning trains at depots, running them automatically along an
 * assigned line (with passenger boarding/alighting driven by the demand
 * model), obeying speed limits and signals, manual routing/reversing, an
 * emergency brake, and train-on-train collision detection.
 *
 * A note on units: a track's `distance` field (meters) is the schematic
 * label the Builder uses for line pathfinding weight, and is NOT tied to
 * the track's drawn pixel length (this is a schematic diagram, not drawn to
 * scale). Gameplay physics (speed, acceleration, train length, stopping
 * distance) all happen in that meters domain using `distance` as the real
 * physical length of the segment; positions are then converted to pixels
 * proportionally only at render time. That means a train crosses a
 * compressed/short-drawn segment "faster" on screen than a long one, which
 * is the correct schematic behaviour to match the Builder's own distance
 * label semantics.
 *
 * Simplifications made deliberately to keep this tractable:
 *  - A train only ever looks ahead along its own committed route (current
 *    track + queued line/manual path) for signals, speed limits and its own
 *    route target - it doesn't re-plan around a red signal by taking another
 *    path. It deliberately does NOT look ahead for other trains: braking for
 *    a train ahead is the player's job (via signals), not something the
 *    physics does automatically - if two trains occupy the same track
 *    section, checkCollisions() ends the game.
 *  - Passenger boarding decides "does this line serve my destination" by
 *    checking the line's full stop list (a shuttle line eventually visits
 *    every stop in both directions), not the precise remaining direction.
 *  - Waiting passengers are tracked as aggregate destination-code counts
 *    per platform, not as individual sprites.
 */

// --- Persisted diagram state (as imported/exported by the Builder) ---
let state = {
    meta: { name: '', description: '', startTime: '05:50' },
    points: [],
    tracks: [],
    platforms: [],
    signals: [],
    labels: [],
    lines: [],
    demand: null
};

let hasLoadedDiagram = false;

// --- Simulation clock ---
// In-game time of day, in seconds since midnight. Defaults to 05:50 until a
// diagram is loaded; loadDiagram() then re-derives this from the diagram's
// own meta.startTime (set in the Builder's Map Settings), falling back to
// this same 05:50 default for diagrams exported before that field existed.
let simTimeSeconds = 5 * 3600 + 50 * 60;
const DEFAULT_START_TIME = '05:50';

// Parses a "HH:MM" 24h string into seconds-since-midnight, falling back to
// the default start time for anything missing/malformed.
function parseStartTimeToSeconds(hhmm) {
    let m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return 5 * 3600 + 50 * 60;
    let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (!isFinite(h) || !isFinite(min)) return 5 * 3600 + 50 * 60;
    h = ((h % 24) + 24) % 24;
    min = ((min % 60) + 60) % 60;
    return h * 3600 + min * 60;
}
let simSpeed = 1; // 1x - 60x, how many game-seconds pass per real second
let simPaused = true; // starts paused - the player must press play to begin service
let lastFrameTime = null;

// --- Theme (matches Builder) ---
const DEFAULT_TRACK_COLOR = '#e4e4e7';
const DEFAULT_PLATFORM_COLOR = '#d1d5db';
const GRID_LINE_COLOR = '#28282c';
const GRID_SIZE = 40;
const NO_LINE_TRAIN_COLOR = '#a1a1aa';

// Platform fixed dimensions (must match Builder so imported diagrams look right)
const PLAT_WIDTH = 30;
const PLAT_LENGTH = 120;
const PLAT_GAP = 10;
const PLAT_OFFSET = PLAT_GAP + (PLAT_WIDTH / 2); // 25

// Track/train line widths. Trains are drawn 100% wider (double) the track
// itself so they read clearly on top of it at any zoom level.
const TRACK_LINE_WIDTH = 4;
const TRAIN_LINE_WIDTH = TRACK_LINE_WIDTH * 2; // 8
const TRAIN_LINE_WIDTH_SELECTED = TRAIN_LINE_WIDTH + 1; // 9
const TRAIN_OUTLINE_WIDTH = TRAIN_LINE_WIDTH + 2; // 10
const TRAIN_OUTLINE_WIDTH_SELECTED = TRAIN_LINE_WIDTH_SELECTED + 3; // 12

// Signal fixed dimensions (must match Builder)
const SIGNAL_OFFSET = 22;
const SIGNAL_RADIUS = 7;
const SIGNAL_MIN_STUB_DIST = 12;
// Extra forgiving radius (world px, pre-zoom-adjust) for tapping a signal head.
const SIGNAL_HIT_PADDING = 10;
// If a pointer moves further than this (screen px) between down and up, it's
// treated as a pan/drag rather than a click on whatever was under the pointer.
const CLICK_DRAG_THRESHOLD = 6;
// Press-and-hold duration (ms) on a train to trigger its emergency brake.
const TRAIN_EB_HOLD_MS = 800;

// --- Train / physics defaults (used when a depot doesn't specify a value) ---
const DEFAULT_TRAIN_LENGTH_M = 100;
const DEFAULT_TRAIN_MAX_SPEED_KMH = 80;
const DEFAULT_TRAIN_ACCEL = 0.8; // m/s^2, also used as normal/service braking rate
const DEFAULT_EMERGENCY_DECEL = 2.8; // m/s^2
const DEFAULT_TRAIN_CAPACITY = 600;
const SIGNAL_STOP_MARGIN_M = 4; // trains stop this far short of a red signal
const LOOKAHEAD_M = 2500; // minimum how far ahead (meters) a train scans for hazards
const REVERSE_PENALTY_SPEED_KMH = 5; // speed cap applied after reversing outside a turnback/depot area
const PHYSICS_SUBSTEP_S = 0.1; // max simulated seconds integrated per physics substep
const TRAIN_STOPPED_MS = 0.05; // speed (m/s) below which a train counts as "stopped" for dwell/teleport purposes
const TRAIN_HIT_PADDING = 9; // world px (pre-zoom) for tapping a train
const DEPOT_HIT_PADDING = 14; // world px (pre-zoom) for tapping a depot track

// --- Runtime (non-persisted) game state ---
let trains = [];
let nextTrainSeq = 1;
let selectedTrainId = null;
let manualRouteArmedTrainId = null; // train awaiting a map click for a manual destination
let manualRoutePreview = null; // { points, target, valid, waypoints } - live route preview under the cursor while armed, recomputed every pointermove
let manualRouteWaypoints = []; // [{trackId, dist}, ...] mid-points dropped with right-click while armed, in order, before the final left-click target

// --- "Adjust Route" (drag-a-midpoint) state - lets the player bend a
// train's ALREADY-committed route (line or manual) through one new point
// without changing its final target, by pressing/dragging anywhere on the
// map. See armAdjustRoute/updateAdjustRoutePreview/finishAdjustRouteDrag.
let adjustRouteArmedTrainId = null; // train awaiting a drag to bend its existing route
let adjustRouteDragging = false; // true from pointerdown to pointerup while armed
let adjustDragPointerId = null; // the pointerId that owns the current adjust-drag
let adjustRoutePreview = null; // { points, target, valid, waypointTrackId, waypointDist } - live preview of the bent route
let gameOver = false;
let crashAnim = null; // active crash camera/tilt animation - see triggerGameOver() and draw()
let crashEventId = 0;

// Theme (matches Builder) - camera
let camera = { x: 0, y: 0, zoom: 1 };
// Multiplayer: this client's own cursor in world coordinates, updated on
// every pointermove and periodically broadcast by net.js. null when the
// pointer is outside the canvas (so we don't broadcast a stale position).
let mpCursorWorld = null;
let isPanning = false;
let panPointerId = null;
let panStart = { x: 0, y: 0 };
let pointerDownScreen = { x: 0, y: 0 };
let pointerDownSignal = null; // signal candidate hit-tested at pointerdown time
let pointerDownTrain = null;
let pointerDownDepotTrack = null;
// Press-and-hold-to-emergency-brake state (see TRAIN_EB_HOLD_MS).
let trainHoldTrainId = null;
let trainHoldStartMs = null;
let trainHoldTriggered = false;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Injected once so the emergency-brake speed readout (see updateTrainPanel)
// can flash red without needing a change to the game's own stylesheet.
(function injectEbFlashStyle() {
    let style = document.createElement('style');
    style.textContent = '.speed-eb-flash { color: #ef4444; animation: eb-speed-blink 0.5s steps(1, start) infinite; }' +
        '@keyframes eb-speed-blink { 50% { opacity: 0.2; } }';
    document.head.appendChild(style);
})();

// ============================================================
// --- Core math helpers (mirrors Builder) ---
// ============================================================

function getPoint(id) { return state.points.find(p => p.id === id); }
function getTrack(id) { return state.tracks.find(t => t.id === id); }
function getPlatform(id) { return state.platforms.find(p => p.id === id); }
function getLine(id) { return state.lines.find(l => l.id === id); }
function connectedTracks(pointId) {
    return state.tracks.filter(t => t.p1_id === pointId || t.p2_id === pointId);
}

function screenToWorld(sx, sy) {
    return { x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom };
}

function trackPixelLength(t) {
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return 0;
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// Real physical length of a track in meters, for all gameplay physics.
function trackMeters(t) {
    if (typeof t.distance === 'number' && t.distance > 0) return t.distance;
    let n = parseFloat(t.distance);
    if (!isNaN(n) && n > 0) return n;
    return Math.max(1, trackPixelLength(t));
}

// Convert a pixel t_dist (as stored on platforms/signals) to meters-from-p1,
// and back. Both parametrize the same 0..1 fraction along the track.
function pxToMeters(t, px) {
    let L = trackPixelLength(t);
    if (L <= 0) return 0;
    return (px / L) * trackMeters(t);
}
function metersToPx(t, m) {
    let M = trackMeters(t);
    if (M <= 0) return 0;
    return (m / M) * trackPixelLength(t);
}

function trackDirVector(t, fromP1) {
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    if (!fromP1) { dx = -dx; dy = -dy; }
    let len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

function canEnterTrack(t, fromP1) {
    if (t.oneway === 'forward') return fromP1;
    if (t.oneway === 'backward') return !fromP1;
    return true;
}

// Maximum angle a train may ever turn through in a single automatically
// routed move: 90 degrees, full stop. Anything sharper than a right angle
// isn't a "turn" at all - it's a reversal - and automatic routing is never
// allowed to perform a reversal on its own, even at a track that's flagged
// as a turnback or is the train's own home depot. Turnback/depot flags only
// ever grant the physical ABILITY to reverse in place (see isTurnbackTrack
// and canReverseInPlace, used by the player's manual Reverse button) - they
// never grant the pathfinder permission to route a train backward through
// one unattended. If a train's route requires turning around, the player
// has to press Reverse themselves; computeTrainRoute simply won't find a
// path through anything sharper than this, and callers fall back to a
// toast telling the player a turnback/manual reverse is needed (see
// routeTrainToLineStop and advanceToNextLineStop).
const MAX_TURN_ANGLE_DEG = 90;
const MAX_TURN_DOT = Math.cos(MAX_TURN_ANGLE_DEG * Math.PI / 180); // 0

// Whether a track counts as a place a train is allowed to physically
// reverse on. Either it's explicitly flagged as a turnback facility, or -
// new - it's the train's own home depot track: a depot is where a train
// lives between duties, so it always doubles as an informal reversing
// point for that train specifically, even if the player never bothered to
// flag it as a turnback. This only ever applies to the train that calls the
// depot home - it doesn't make the track a turnback for any other train.
// Note this only governs the manual Reverse button (see canReverseInPlace);
// it plays no part in automatic routing at all - see MAX_TURN_DOT above.
function isTurnbackTrack(track, train) {
    if (!track) return false;
    if (track.turnback) return true;
    return !!(train && track.id === train.homeDepotTrackId);
}

// Automatic-routing turn gate: allows a move onto another track only if it
// keeps the train turning by 90 degrees or less. There is deliberately no
// turnback/depot exception here - see MAX_TURN_DOT's comment. A player who
// wants their train to actually turn around has to do it themselves with
// the Reverse button.
function isTurnAllowed(train, inTrack, inDir, outTrack, outDir) {
    if (!inTrack) return true;
    let dot = inDir.x * outDir.x + inDir.y * outDir.y;
    return dot > MAX_TURN_DOT;
}

// Whether reversing right where a train is currently standing counts as a
// "proper" reversal - at a flagged turnback facility or the train's own
// depot - versus an unauthorized one anywhere else. The player can reverse
// anywhere (see reverseTrain), but doing it outside one of these decides
// whether the post-reversal speed penalty kicks in.
// Flipping in place never moves the train onto a different track - it only
// ever reinterprets forward/backward on the exact segments it already
// occupies - so the only thing that matters is whether the track it's
// currently on counts as reversible for this train.
function canReverseInPlace(train) {
    let track = getTrack(train.headTrackId);
    return isTurnbackTrack(track, train);
}

function kmhToMs(k) { return k / 3.6; }
function msToKmh(m) { return m * 3.6; }

// Small rounded-rect path helper (used for the platform passenger badge).
function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function getPlatformGeom(plat) {
    let t = getTrack(plat.track_id);
    if (!t) return null;
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return null;
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    let len = Math.hypot(dx, dy);
    if (len === 0) return null;
    let udx = dx / len, udy = dy / len;
    let cx = p1.x + udx * plat.t_dist;
    let cy = p1.y + udy * plat.t_dist;
    let nx = -udy, ny = udx;
    let px = cx + nx * plat.side * PLAT_OFFSET;
    let py = cy + ny * plat.side * PLAT_OFFSET;
    return { px, py, angle: Math.atan2(dy, dx) };
}

// Point in world space at a given meters-from-p1 distance along a track.
function pointAtMeters(t, m) {
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return null;
    let px = metersToPx(t, m);
    let L = trackPixelLength(t);
    if (L <= 0) return { x: p1.x, y: p1.y };
    let frac = px / L;
    return { x: p1.x + (p2.x - p1.x) * frac, y: p1.y + (p2.y - p1.y) * frac };
}

// Same bent-post construction as the Builder, so an imported signal's head
// (and any manual dragOffset nudge) renders identically here.
function getSignalPath(cx, cy, trackAngle, side, headX, headY) {
    let baseAngle = trackAngle + side * (Math.PI / 2);
    let ux = Math.cos(baseAngle), uy = Math.sin(baseAngle);
    let vx = Math.cos(baseAngle + Math.PI / 2), vy = Math.sin(baseAngle + Math.PI / 2);

    let hx = headX - cx, hy = headY - cy;
    let du = hx * ux + hy * uy;
    let dv = hx * vx + hy * vy;

    let stubLen = Math.max(SIGNAL_MIN_STUB_DIST, du);
    let bx = cx + ux * stubLen;
    let by = cy + uy * stubLen;

    let remU = du - stubLen;
    let remV = dv;
    let diagLen = Math.min(Math.abs(remU), Math.abs(remV));
    let signU = remU > 0 ? 1 : (remU < 0 ? -1 : 0);
    let signV = remV > 0 ? 1 : (remV < 0 ? -1 : 0);

    let midU = diagLen * signU;
    let midV = diagLen * signV;
    let mx = bx + ux * midU + vx * midV;
    let my = by + uy * midU + vy * midV;

    return { bx, by, mx, my, px: headX, py: headY };
}

function getSignalGeom(sig) {
    let t = getTrack(sig.track_id);
    if (!t) return null;
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return null;
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    let len = Math.hypot(dx, dy);
    if (len === 0) return null;

    let udx = dx / len, udy = dy / len;
    let cx = p1.x + udx * sig.t_dist;
    let cy = p1.y + udy * sig.t_dist;

    let trackAngle = Math.atan2(dy, dx);
    let baseAngle = trackAngle + sig.side * (Math.PI / 2);

    let dragOffset = sig.dragOffset || { x: 0, y: 0 };
    let headX = cx + Math.cos(baseAngle) * SIGNAL_OFFSET + dragOffset.x;
    let headY = cy + Math.sin(baseAngle) * SIGNAL_OFFSET + dragOffset.y;

    let path = getSignalPath(cx, cy, trackAngle, sig.side, headX, headY);
    let facing = sig.direction === -1 ? trackAngle + Math.PI : trackAngle;

    return { cx, cy, bx: path.bx, by: path.by, mx: path.mx, my: path.my, px: path.px, py: path.py, facing };
}

function hitTestSignal(wx, wy) {
    let best = null, bestDist = Infinity;
    for (let s of state.signals) {
        let geom = getSignalGeom(s);
        if (!geom) continue;
        let d = Math.hypot(geom.px - wx, geom.py - wy);
        if (d < (SIGNAL_RADIUS + SIGNAL_HIT_PADDING) && d < bestDist) {
            bestDist = d;
            best = s;
        }
    }
    return best;
}

function toggleSignal(sig) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control signals."); return; }
        MP.sendInput({ type: 'TOGGLE_SIGNAL', signalId: sig.id });
        return;
    }
    sig.state = (sig.state === 'blue') ? 'red' : 'blue';
    draw();
}

// Nearest point projected onto ANY track (used for manual-route picking).
// No grid snapping - gameplay routing targets are free points along a
// track segment, not restricted to nodes.
function getNearestTrackPoint(wx, wy, filterFn) {
    let best = null, bestDist = Infinity;
    for (let t of state.tracks) {
        if (filterFn && !filterFn(t)) continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        let dx = p2.x - p1.x, dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) continue;
        let udx = dx / len, udy = dy / len;
        let mx = wx - p1.x, my = wy - p1.y;
        let dot = mx * udx + my * udy;
        let t_px = Math.max(0, Math.min(len, dot));
        let cx = p1.x + udx * t_px, cy = p1.y + udy * t_px;
        let d = Math.hypot(cx - wx, cy - wy);
        if (d < bestDist) {
            bestDist = d;
            best = { track: t, t_px, x: cx, y: cy, dist: d };
        }
    }
    return best;
}

// ============================================================
// --- Point-to-point pathfinding for a live train (meters domain) ---
// Dijkstra over (point, arrival track) states, generalized from the
// Builder's platform-to-platform line pathfinder, but starting from a
// train's actual current position/heading instead of a platform, and
// returning full-edge traversals (not pixel schematic segments).
// ============================================================

function computeTrainRoute(train, targetTrackId, targetDist) {
    let curTrack = getTrack(train.headTrackId);
    if (!curTrack) return null;
    let forward = train.headForward;

    // Direct case: target is further along the very track the train is on,
    // in the direction it's already heading.
    if (curTrack.id === targetTrackId) {
        let aheadOk = forward ? (targetDist >= train.headDist - 1e-6) : (targetDist <= train.headDist + 1e-6);
        if (aheadOk) {
            return { edges: [], directOnCurrent: true, totalMeters: Math.abs(targetDist - train.headDist) };
        }
    }

    let targetTrack = getTrack(targetTrackId);
    if (!targetTrack) return null;

    let startPointId = forward ? curTrack.p2_id : curTrack.p1_id;
    let startDir = trackDirVector(curTrack, forward);
    let startCost = forward ? (trackMeters(curTrack) - train.headDist) : train.headDist;
    startCost = Math.max(0, startCost);

    const key = (pointId, arrTrackId) => pointId + '|' + arrTrackId;
    let dist = new Map();
    let prev = new Map();
    let startKey = key(startPointId, curTrack.id);
    dist.set(startKey, startCost);
    prev.set(startKey, { fromKey: null, isStart: true });
    let queue = [{ key: startKey, pointId: startPointId, arrTrack: curTrack, inDir: startDir, d: startCost }];

    let goalKey = null;
    while (queue.length) {
        queue.sort((a, b) => a.d - b.d);
        let cur = queue.shift();
        if (cur.d > (dist.get(cur.key) ?? Infinity)) continue;

        let conn = connectedTracks(cur.pointId);
        // A literal dead end (only the track we arrived on touches this
        // point, nothing else touches it) is *not* automatically reversible.
        // Real trains can't just spin around at a plain buffer stop - only a
        // track explicitly flagged as a turnback (a proper reversing
        // facility) can send them back the way they came. So a dead end, a
        // plain 2-way point, and a busy multi-track junction are all
        // treated identically when it comes to turning: isTurnAllowed()'s
        // turnback check applies below unconditionally, regardless of how
        // many tracks meet at this point.

        if (cur.pointId === targetTrack.p1_id || cur.pointId === targetTrack.p2_id) {
            let atP1 = cur.pointId === targetTrack.p1_id;
            let finalFromP1 = atP1;
            let finalLeg = atP1 ? targetDist : (trackMeters(targetTrack) - targetDist);
            let outDir = trackDirVector(targetTrack, finalFromP1);
            // The turn-angle check runs unconditionally here, regardless of
            // whether this point is a busy junction or a plain 2-way point,
            // and regardless of whether the final track happens to share its
            // id with the arrival track. A previous version only ran this
            // check for isRealJunction or a literal same-track id
            // (isFinalUTurn), which let a genuine 180-degree reversal slip
            // through unblocked whenever it happened via two DIFFERENT
            // tracks meeting at a plain 2-connection point - the train's
            // arrival track and the target track are different track
            // objects, so isFinalUTurn was false, and the point only has 2
            // connections, so isRealJunction was false too, leaving nothing
            // to stop the reversal. Geometry (the dot product inside
            // isTurnAllowed), not track-id equality or junction size, is
            // what actually determines whether this is a u-turn.
            let turnOk = isTurnAllowed(train, cur.arrTrack, cur.inDir, targetTrack, outDir);
            if (canEnterTrack(targetTrack, finalFromP1) && turnOk && finalLeg >= -1e-6) {
                let total = cur.d + Math.max(0, finalLeg);
                let gk = 'GOAL@' + cur.key;
                if (goalKey === null || total < dist.get(goalKey)) {
                    dist.set(gk, total);
                    prev.set(gk, { fromKey: cur.key, endTrack: targetTrack, endAtP1: atP1 });
                    goalKey = gk;
                }
                break; // processed in cost order - first *valid* arrival is optimal
            }
            // Otherwise this particular (point, arrival-track) pairing can't
            // legally complete the route right here (e.g. it would require
            // reversing straight onto the target track without a turnback).
            // Previously this unconditionally `break`-ed the whole search the
            // instant ANY state touching the target track's endpoints was
            // dequeued, even an invalid one - discarding every other,
            // possibly perfectly legal, approach still sitting in the queue.
            // Falling through into the normal neighbor expansion below
            // instead lets the search keep looking for a legal way in.
        }

        for (let t of conn) {
            let fromP1 = t.p1_id === cur.pointId;
            if (!canEnterTrack(t, fromP1)) continue;
            let outDir = trackDirVector(t, fromP1);
            // The turn-angle check runs unconditionally for every candidate
            // neighbor - continuing back the way the train came is only
            // ever legal onto a track flagged (for this train) as a
            // turnback facility, and that's decided purely by geometry (see
            // isTurnAllowed's dot product), never by track id or by how
            // many tracks meet at this point. A previous version only ran
            // this check when the point was a real junction (3+ tracks) or
            // the candidate was literally the same track id as the one just
            // arrived on (isUTurn) - which meant a genuine 180-degree
            // reversal onto a plain 2-connection point, via a track that
            // merely happens to have a DIFFERENT id but still points
            // straight back the way the train came, sailed through
            // unchecked every single time. Every step now gets the same
            // strict check, so a "current track -> next track" reversal can
            // never slip through just because it isn't a busy junction or
            // isn't literally the same track object.
            if (!isTurnAllowed(train, cur.arrTrack, cur.inDir, t, outDir)) continue;

            let otherPoint = fromP1 ? t.p2_id : t.p1_id;
            let cost = trackMeters(t);
            let nd = cur.d + cost;
            let nk = key(otherPoint, t.id);
            if (nd < (dist.get(nk) ?? Infinity)) {
                dist.set(nk, nd);
                prev.set(nk, { fromKey: cur.key, track: t, fromP1 });
                queue.push({ key: nk, pointId: otherPoint, arrTrack: t, inDir: outDir, d: nd });
            }
        }
    }

    if (goalKey === null) return null;

    let edges = [];
    let node = prev.get(goalKey);
    edges.unshift({ trackId: node.endTrack.id, forward: node.endAtP1 });
    let ck = node.fromKey;
    while (ck) {
        let p = prev.get(ck);
        if (!p || p.isStart) break;
        edges.unshift({ trackId: p.track.id, forward: p.fromP1 });
        ck = p.fromKey;
    }

    // Final structural safety net: a real route can never use the same
    // track twice back-to-back - that's a literal in-place reversal (a
    // u-turn), not a step to a "next" track at all - unless that track is
    // an actual turnback facility the train is entitled to reverse on. The
    // search above is already built to exclude this while expanding, but
    // double-checking the fully reconstructed path means a u-turn can never
    // slip through undetected: if one somehow shows up here anyway, treat
    // the whole route as unreachable rather than ever handing the train a
    // path that would require it to drive back onto the track it's already
    // just left.
    let prevTrackId = curTrack.id;
    for (let e of edges) {
        if (e.trackId === prevTrackId && !isTurnbackTrack(getTrack(e.trackId), train)) return null;
        prevTrackId = e.trackId;
    }

    // A subtler version of the same problem: hopping out via a short
    // connecting track at a busy junction and straight back onto the
    // train's OWN starting track is still a net reversal through its own
    // start, even though no two edges in the list are back-to-back
    // identical (the consecutive check above can't see it). The one
    // legitimate way the starting track can reappear is as the genuine
    // final destination itself - reaching it via a real loop back around,
    // which the goal-check above already vetted with the same
    // isFinalUTurn/isTurnAllowed turnback logic. Any OTHER, non-final
    // reappearance of it mid-route is always an illegitimate detour back
    // through the start.
    for (let i = 0; i < edges.length - 1; i++) {
        if (edges[i].trackId === curTrack.id && !isTurnbackTrack(curTrack, train)) return null;
    }

    return { edges, directOnCurrent: false, totalMeters: dist.get(goalKey) };
}

// Chains computeTrainRoute across a sequence of waypoints, so a route can be
// made to pass through one or more player-chosen mid-points on its way to a
// final destination (the last entry in `waypoints`). Each leg is solved
// independently: after reaching waypoint N, a lightweight "virtual train"
// standing exactly there (same trick as updateManualRoutePreview's
// virtualTrain) becomes the starting point for the leg to waypoint N+1. The
// resulting edge lists are just concatenated - each leg's edges already
// start right after the previous leg's arrival track, so there's never any
// overlap or duplication between legs. Returns null (whole chain rejected)
// if ANY leg turns out to be unreachable, rather than silently truncating
// the route partway to a point the player never asked to stop at.
//
// `baseState` only needs the same fields computeTrainRoute itself reads off
// a train: headTrackId, headForward, headDist, and homeDepotTrackId (used
// only by isTurnbackTrack). Passing the real train object works fine too.
function computeChainedRoute(baseState, waypoints) {
    if (!waypoints || !waypoints.length) return null;
    let combinedEdges = [];
    let virt = {
        headTrackId: baseState.headTrackId,
        headForward: baseState.headForward,
        headDist: baseState.headDist,
        homeDepotTrackId: baseState.homeDepotTrackId
    };
    for (let wp of waypoints) {
        let route = computeTrainRoute(virt, wp.trackId, wp.dist);
        if (!route) return null;
        combinedEdges = combinedEdges.concat(route.edges);
        let arrivalForward = route.directOnCurrent ? virt.headForward : route.edges[route.edges.length - 1].forward;
        virt = { headTrackId: wp.trackId, headForward: arrivalForward, headDist: wp.dist, homeDepotTrackId: baseState.homeDepotTrackId };
    }
    return { edges: combinedEdges, finalForward: virt.headForward };
}

// World-space (x, y) of a {trackId, dist} waypoint, for drawing its marker
// dot. Mirrors pointAtMeters but takes a plain waypoint object rather than a
// live train, since preview waypoints aren't attached to any track object.
function waypointToXY(wp) {
    let t = getTrack(wp.trackId);
    if (!t) return null;
    return pointAtMeters(t, wp.dist);
}

// A platform is just a marker point (t_dist) - it has no length of its own,
// and is drawn centred on that point. So a train must stop with its own
// MIDDLE over that point, not its head, or half the train would sit short
// of the platform. Offsets the raw marker distance by half the train's
// length in whichever direction the train is travelling when it arrives,
// clamped to the track's own bounds.
function platformStopDist(train, track, plat, arrivalForward) {
    let centerM = pxToMeters(track, plat.t_dist);
    let half = (train.length || 0) / 2;
    let raw = arrivalForward ? (centerM + half) : (centerM - half);
    return Math.max(0, Math.min(trackMeters(track), raw));
}

// Is the train already standing at this platform right now? A train stops
// with its *middle* over the platform marker, not its head, so its headDist
// sits half a train-length away from the platform's own t_dist - meaning
// the platform's raw marker position can appear "behind" the train from
// computeTrainRoute's point of view and read as unreachable, even though
// the train is, physically, already sitting right there. Checking the
// train's actual occupied footprint (not just its head) avoids that trap so
// re-assigning a line that starts at the platform a train just reversed at
// always finds it immediately, with zero cost, instead of depending on
// pathfinding being able to "reach" a point it's already covering.
function isTrainAtPlatform(train, plat) {
    if (!train._occ || !plat) return false;
    let t = getTrack(plat.track_id);
    if (!t) return false;
    let m = pxToMeters(t, plat.t_dist);
    for (let seg of train._occ) {
        if (seg.trackId !== plat.track_id) continue;
        if (m >= seg.startM - 0.5 && m <= seg.endM + 0.5) return true;
    }
    return false;
}

function getStopPlatforms(stop) {
    if (!stop || !stop.platformIds) return [];
    return stop.platformIds.map(id => getPlatform(id)).filter(Boolean);
}

// Physically snaps `train` straight onto `plat`'s exact centred stop
// position, on the same track it's already occupying, instead of relying on
// normal driving physics to creep the last stretch there. This matters
// because isTrainAtPlatform() checks the train's whole occupied footprint -
// both ends, not just its head - so it can report "already at this
// platform" even when the head has overshot past the ideal stop point, or
// when only the tail is actually over the marker (e.g. a long train, or one
// that was reversed in place). Neither of those cases can be resolved by
// nudging the head forward/backward under gatherLookahead's normal "is the
// target ahead of me" logic, so instead of trying to reason about that,
// just teleport the train's single-segment footprint directly onto the
// correct position, keeping its current facing. Returns the snapped
// distance (also usable as the train's new targetDist).
function snapTrainToPlatform(train, track, plat) {
    let forward = train.headForward;
    let idealDist = platformStopDist(train, track, plat, forward);
    train.headTrackId = track.id;
    train.headForward = forward;
    train.headDist = idealDist;
    train.history = [{ trackId: track.id, forward: forward }];
    train.speedMs = 0;
    train._occ = getOccupiedEdges(train);
    return idealDist;
}

// ============================================================
// --- Trains: spawning, occupied geometry, movement, signaling ---
// ============================================================

function parseNum(v, fallback) {
    let n = parseFloat(v);
    return isNaN(n) ? fallback : n;
}

// Which end of a depot track has more onward connections - trains spawn
// heading away from a dead end when there's a choice.
function pickSpawnDirection(track) {
    let p1Deg = connectedTracks(track.p1_id).length;
    let p2Deg = connectedTracks(track.p2_id).length;
    return p2Deg >= p1Deg; // true = forward (p1->p2)
}

function spawnTrainAt(track, options) {
    // Multiplayer: only the host actually mutates simulation state. A
    // non-host client just asks the host to do this and waits for the
    // resulting train to show up in the next state snapshot.
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('depotSpawnDespawn')) { showToast("You don't have permission to spawn trains."); return; }
        let requestId = 'spawn_' + Math.random().toString(36).slice(2);
        MP.pendingSpawnRequestId = requestId;
        MP.sendInput({ type: 'SPAWN_TRAIN', trackId: track.id, requestId: requestId });
        return;
    }
    let forward = pickSpawnDirection(track);
    let lenM = trackMeters(track);
    let trainLen = parseNum(track.trainLength, DEFAULT_TRAIN_LENGTH_M);
    if (!(trainLen > 0)) trainLen = DEFAULT_TRAIN_LENGTH_M;
    let headDist = forward ? Math.min(trainLen, lenM) : Math.max(lenM - trainLen, 0);

    let train = {
        id: 'train_' + (nextTrainSeq++),
        label: 'T' + nextTrainSeq,
        lineId: null,
        color: NO_LINE_TRAIN_COLOR,
        length: trainLen,
        maxSpeedKmh: parseNum(track.trainMaxSpeed, DEFAULT_TRAIN_MAX_SPEED_KMH),
        accelMs2: parseNum(track.acceleration, DEFAULT_TRAIN_ACCEL),
        emergDecelMs2: parseNum(track.emergencyDeceleration, DEFAULT_EMERGENCY_DECEL),
        capacity: (typeof track.trainCapacity === 'number' && track.trainCapacity > 0) ? track.trainCapacity : DEFAULT_TRAIN_CAPACITY,
        speedCapKmh: null,
        reversePenaltyActive: false, // true after reversing outside a turnback/depot - caps speed at REVERSE_PENALTY_SPEED_KMH until reversed again
        speedMs: 0,
        headTrackId: track.id,
        headDist: headDist,
        headForward: forward,
        history: [{ trackId: track.id, forward: forward }],
        route: [],
        targetTrackId: null,
        targetDist: null,
        targetForward: null, // heading the train will be facing once it reaches targetTrackId/targetDist
        mode: 'idle', // 'idle' | 'line' | 'manual'
        stopIndex: 0,
        direction: 1,
        pendingStop: null,
        pendingPlatformId: null,
        dwellUntil: null,
        emergencyBrake: false,
        autoEmergencyBrake: false,
        homeDepotTrackId: track.id,
        passengers: [], // [{destCode, count}]
        passengerCount: 0,
        lastAlighted: 0,
        lastBoarded: 0,
        platformOverrides: {},
        _occ: null,
        stuckNoticeShown: false
    };
    train._occ = getOccupiedEdges(train);
    trains.push(train);
    if (options && options.requestId) train.spawnRequestId = options.requestId;
    showToast('Train ' + train.label + ' spawned.');
    // A remote player's spawn is authoritative, but it must not change the
    // host's local selection or open the host's detail panel.
    if (!options || options.select !== false) selectTrain(train.id);
    draw();
    return train;
}

function isTrainFullyInHomeDepot(train) {
    if (!train._occ) return false;
    return train._occ.every(seg => seg.trackId === train.homeDepotTrackId);
}

function despawnTrain(train) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('depotSpawnDespawn')) { showToast("You don't have permission to despawn trains."); return; }
        MP.sendInput({ type: 'DESPAWN_TRAIN', trainId: train.id });
        return;
    }
    trains = trains.filter(t => t.id !== train.id);
    if (selectedTrainId === train.id) closeTrainPanel();
    showToast('Train ' + train.label + ' despawned.');
    draw();
}

// Occupied geometry: walks backward from the head through history,
// consuming train.length meters, and returns an array of
// { trackId, forward, startM, endM } (p1-relative meters), head-most
// segment first. Also flags how much of `history` is now stale so it can
// be trimmed.
function getOccupiedEdges(train) {
    let segs = [];
    let remaining = train.length;
    let i = train.history.length - 1;
    if (i < 0) return segs;

    // Current (head) partial edge.
    {
        let h = train.history[i];
        let t = getTrack(h.trackId);
        if (!t) return segs;
        let L = trackMeters(t);
        let distIntoEdge = h.forward ? train.headDist : (L - train.headDist);
        let take = Math.min(remaining, Math.max(0, distIntoEdge));
        let s, e;
        if (h.forward) { s = train.headDist - take; e = train.headDist; }
        else { s = train.headDist; e = train.headDist + take; }
        segs.push({ trackId: h.trackId, forward: h.forward, startM: s, endM: e });
        remaining -= take;
        i--;
    }

    while (remaining > 0.01 && i >= 0) {
        let h = train.history[i];
        let t = getTrack(h.trackId);
        if (!t) break;
        let L = trackMeters(t);
        let take = Math.min(remaining, L);
        let s, e;
        if (take >= L - 1e-6) { s = 0; e = L; }
        else if (h.forward) { s = L - take; e = L; }
        else { s = 0; e = take; }
        segs.push({ trackId: h.trackId, forward: h.forward, startM: s, endM: e });
        remaining -= take;
        i--;
    }

    train._historyUsedFrom = Math.max(0, i + 1);
    return segs;
}

function trimTrainHistory(train) {
    if (typeof train._historyUsedFrom === 'number' && train._historyUsedFrom > 0) {
        train.history = train.history.slice(train._historyUsedFrom);
        train._historyUsedFrom = 0;
    }
}

// The single rearmost point of a train (trackId + p1-relative meters).
function getTrainTailPoint(train) {
    if (!train._occ || train._occ.length === 0) return null;
    let seg = train._occ[train._occ.length - 1];
    return { trackId: seg.trackId, dist: seg.forward ? seg.startM : seg.endM };
}

// The exact bound (p1-relative meters) a train may travel to on `trackId`
// while heading `forward`, honoring its final target if that track is it.
function edgeBound(train, trackId, forward) {
    let t = getTrack(trackId);
    let L = trackMeters(t);
    if (trackId === train.targetTrackId && train.targetDist != null) return train.targetDist;
    return forward ? L : 0;
}

// Scans ahead of the train (current track remainder + queued route) for
// signals, speed-limit changes, other trains' tails, its own final target,
// and any turnback reversal points, returning cumulative meters-ahead for
// each.
function gatherLookahead(train) {
    let result = { cumToTarget: null, signals: [], speedZones: [], reversals: [] };
    let cum = 0;
    // How far ahead this train actually needs to scan to see a stop point in
    // time: its own normal-braking stopping distance (with margin), floored
    // at LOOKAHEAD_M. A fixed cap alone could be shorter than the real
    // stopping distance for a fast or weak-braking train, which would hide a
    // red signal until it's already too close to stop for.
    let brakingDist = (train.speedMs * train.speedMs) / (2 * Math.max(0.01, train.accelMs2));
    let lookaheadLimit = Math.max(LOOKAHEAD_M, brakingDist * 1.5);

    // Meters of slack applied when deciding whether a signal's position
    // falls inside the window currently being scanned. A signal that sits
    // essentially right on top of a junction node (t_dist snapped to 0 or
    // the track's full length, which is exactly where a signal "protecting"
    // a multi-track node is normally placed) can land a hair outside the
    // window from ordinary floating point drift in the geometry - the old
    // 1e-6 tolerance was tight enough that this happened, and a signal
    // excluded here is a signal the lookahead - and therefore the train -
    // never sees at all, not just late. A generous, still-tiny, real-world
    // tolerance closes that gap without meaningfully changing where signals
    // are considered to apply.
    const SIGNAL_WINDOW_EPS_M = 0.05;

    function scanWindow(t, forward, fromM, toM, cumStart) {
        result.speedZones.push({ cum: cumStart, limit: (typeof t.speedLimit === 'number' ? t.speedLimit : null) });
        let low = Math.min(fromM, toM), high = Math.max(fromM, toM);

        for (let s of state.signals) {
            if (s.track_id !== t.id) continue;
            // A signal's `direction` is the way its arrow (its physical
            // pointer) points, as rendered in getSignalGeom's `facing`
            // (direction=1 draws the arrow facing forward, p1->p2;
            // direction=-1 draws it facing backward, p2->p1) - and it
            // blocks/protects a train travelling in the OPPOSITE direction
            // to that arrow: the signal faces back toward the train it's
            // protecting, the way a real signal's lens faces the oncoming
            // train rather than pointing the way that train is heading.
            // This is the sole, authoritative reference for whether a
            // signal applies to a given train's movement - a track can
            // carry signals for both directions at once (e.g. one
            // protecting each way into a junction), and only the one whose
            // arrow faces the train is ever relevant to it.
            let matches = (s.direction === 1 && !forward) || (s.direction === -1 && forward);
            if (!matches) continue;
            let pos = pxToMeters(t, s.t_dist);
            if (pos < low - SIGNAL_WINDOW_EPS_M || pos > high + SIGNAL_WINDOW_EPS_M) continue;
            let distAlong = forward ? (pos - fromM) : (fromM - pos);
            result.signals.push({ cum: cumStart + Math.max(0, distAlong), state: s.state });
        }
    }

    let curTrack = getTrack(train.headTrackId);
    if (!curTrack) return result;
    let forward = train.headForward;
    let bound = edgeBound(train, train.headTrackId, forward);
    scanWindow(curTrack, forward, train.headDist, bound, cum);
    let remainLen = Math.max(0, forward ? (bound - train.headDist) : (train.headDist - bound));
    cum += remainLen;
    if (train.headTrackId === train.targetTrackId && train.targetDist != null) {
        result.cumToTarget = cum;
        return result;
    }

    // A turnback reversal is a real, physical direction change - the
    // train's route bends back through more than 90 degrees at a depot or
    // flagged turnback point - not a pass-through junction. Critically, this
    // is NOT limited to the train doubling back onto the exact same track
    // it arrived on: a depot is very often its own short stub track, so
    // leaving it means moving onto a genuinely different track object that
    // just happens to point back the way the train came. Detecting only
    // same-trackId reversals (an earlier version of this check) missed
    // that entirely - a depot-stub-to-mainline reversal has two different
    // track ids on either side of the turn, so it sailed straight through
    // ungated. The correct test is the same geometric one the pathfinder
    // itself uses to decide what counts as a reversal in the first place
    // (see isTurnAllowed): the dot product of the direction the train was
    // travelling and the direction it's about to travel. Any turn sharp
    // enough to be a genuine reversal (dot <= MAX_TURN_DOT) - regardless
    // of whether the two tracks share an id - must bring the train to a
    // full stop first, exactly like a red signal or its own final target.
    // Without this, the train sails through the reversal at line speed and
    // comes out the other side already moving - which reads on screen as an
    // instantaneous, still-moving spin-around (a "u-turn") rather than a
    // proper decelerate-stop-reverse turnback.
    let prevDir = trackDirVector(curTrack, forward);

    for (let e of train.route) {
        if (cum > lookaheadLimit) break;
        let t = getTrack(e.trackId);
        if (!t) break;
        let eDir = trackDirVector(t, e.forward);
        let dot = prevDir.x * eDir.x + prevDir.y * eDir.y;
        if (dot <= MAX_TURN_DOT) {
            result.reversals.push({ cum });
        }
        let L = trackMeters(t);
        let from = e.forward ? 0 : L;
        let to = edgeBound(train, e.trackId, e.forward);
        scanWindow(t, e.forward, from, to, cum);
        cum += Math.abs(to - from);
        prevDir = eDir;
        if (e.trackId === train.targetTrackId && train.targetDist != null) {
            result.cumToTarget = cum;
            break;
        }
    }
    return result;
}

function currentTrackSpeedLimitKmh(train) {
    let t = getTrack(train.headTrackId);
    if (t && typeof t.speedLimit === 'number') return t.speedLimit;
    return null;
}

function stepTrainPhysics(train, dt) {
    if (train.mode === 'idle') {
        // Hold position - decelerate to a stop if somehow still moving. Also
        // clear the automatic signal-brake flag here: it's otherwise only
        // ever recomputed further down this function, so a train that goes
        // idle while it happened to be true (e.g. it just braked hard for
        // the end of its route, and running out of route is itself what put
        // it into idle mode) would keep showing "Emergency brake (signal)"
        // forever after, with nothing left to ever recompute and release it.
        train.autoEmergencyBrake = false;
        train.speedMs = Math.max(0, train.speedMs - train.accelMs2 * dt);
        // Actually coast forward while that speed bleeds off, instead of
        // freezing the train's position in place - otherwise the train
        // visually stops dead the instant it goes idle (e.g. right after
        // being unassigned from a line mid-route) while speedMs quietly
        // ticks down to 0 in the background with nothing on screen to show
        // for it.
        advanceTrainHead(train, train.speedMs * dt);
        return;
    }

    let lookahead = gatherLookahead(train);

    // Every point ahead where the train must be fully stopped (a red/non-blue
    // signal, the end of its route, another train's tail). If normal service
    // braking (accelMs2) can no longer stop in time for the nearest one -
    // e.g. a signal turns red just ahead of a train that's already close and
    // moving - the train automatically applies emergency braking instead of
    // running through it, exactly like it would if the player had hit the
    // brake manually.
    let stopDistances = [];
    if (lookahead.cumToTarget != null) stopDistances.push(Math.max(0, lookahead.cumToTarget));
    for (let sig of lookahead.signals) {
        if (sig.state !== 'blue') stopDistances.push(Math.max(0, sig.cum - SIGNAL_STOP_MARGIN_M));
    }
    // A turnback point must bring the train fully to rest before it heads
    // back the other way - see the comment on `reversals` in
    // gatherLookahead. Treated as a hard stop, exactly like a red signal or
    // the train's own final target.
    for (let rev of lookahead.reversals) {
        stopDistances.push(Math.max(0, rev.cum));
    }
    let nearestStopDist = stopDistances.length ? Math.min(...stopDistances) : Infinity;
    let normalStopDist = (train.speedMs * train.speedMs) / (2 * train.accelMs2);
    train.autoEmergencyBrake = !train.emergencyBrake && nearestStopDist < normalStopDist - 1e-6;

    let decel = (train.emergencyBrake || train.autoEmergencyBrake) ? train.emergDecelMs2 : train.accelMs2;

    let constraints = [{ d: Infinity, v: kmhToMs(train.maxSpeedKmh) }];
    let curLimit = currentTrackSpeedLimitKmh(train);
    if (curLimit != null) constraints.push({ d: 0, v: kmhToMs(curLimit) });
    if (train.speedCapKmh != null && train.speedCapKmh >= 0) constraints.push({ d: 0, v: kmhToMs(train.speedCapKmh) });
    // A reversal performed outside a proper turnback/depot area leaves the
    // train crawling until it reverses again - see reverseTrain.
    if (train.reversePenaltyActive) constraints.push({ d: 0, v: kmhToMs(REVERSE_PENALTY_SPEED_KMH) });
    if (train.emergencyBrake) constraints.push({ d: 0, v: 0 });
    if (lookahead.cumToTarget != null) constraints.push({ d: Math.max(0, lookahead.cumToTarget), v: 0 });
    for (let sig of lookahead.signals) {
        if (sig.state !== 'blue') constraints.push({ d: Math.max(0, sig.cum - SIGNAL_STOP_MARGIN_M), v: 0 });
    }
    for (let rev of lookahead.reversals) {
        constraints.push({ d: Math.max(0, rev.cum), v: 0 });
    }
    for (let zone of lookahead.speedZones) {
        if (zone.limit != null) constraints.push({ d: Math.max(0, zone.cum), v: kmhToMs(zone.limit) });
    }

    let desired = Infinity;
    for (let c of constraints) {
        let allowed = Math.sqrt(Math.max(0, c.v * c.v + 2 * decel * c.d));
        desired = Math.min(desired, allowed);
    }

    let v = train.speedMs;
    if (desired > v) v = Math.min(desired, v + train.accelMs2 * dt);
    else v = Math.max(desired, v - decel * dt);
    train.speedMs = Math.max(0, v);

    advanceTrainHead(train, train.speedMs * dt);
}

// World-space polyline points tracing a train's committed path ahead - from
// its current head position, along the remainder of its current track, then
// through every queued route edge up to its final target. Used to draw the
// hover/selection pathfinding overlay; recomputed fresh every draw, so it
// always reflects the train's *current* route (e.g. right after a platform
// switch re-targets it).
function getTrainPathPoints(train) {
    let pts = [];
    let t = getTrack(train.headTrackId);
    if (!t) return pts;
    let forward = train.headForward;
    let bound = edgeBound(train, train.headTrackId, forward);
    let headPt = pointAtMeters(t, train.headDist);
    let boundPt = pointAtMeters(t, bound);
    if (headPt) pts.push(headPt);
    if (boundPt) pts.push(boundPt);
    if (train.headTrackId === train.targetTrackId && train.targetDist != null) return pts;

    for (let e of train.route) {
        let t2 = getTrack(e.trackId);
        if (!t2) break;
        let to = edgeBound(train, e.trackId, e.forward);
        let p = pointAtMeters(t2, to);
        if (p) pts.push(p);
        if (e.trackId === train.targetTrackId && train.targetDist != null) break;
    }
    return pts;
}

// World-space polyline points for the leg AFTER the train's current target -
// i.e. the further pathfind, from wherever it's currently headed on to the
// stop after that. Purely a preview: computed fresh on demand from a
// lightweight virtual train state sitting at the current target, and never
// written back into the train's own route/target, so it has zero effect on
// actual navigation. Only meaningful for a train working a line; manual
// routes and idle trains have no "next" stop to preview.
function getTrainNextPathPoints(train) {
    if (!train.lineId || !train.pendingStop || train.targetTrackId == null) return [];
    let line = getLine(train.lineId);
    if (!line || !Array.isArray(line.stops) || line.stops.length < 2) return [];
    let n = line.stops.length;
    // The line now ends (unassigns) at its last stop rather than looping
    // back - see simTick - so there's nothing further to preview from there.
    if (train.stopIndex === n - 1) return [];
    let nextIndex = train.stopIndex + train.direction;
    if (nextIndex < 0 || nextIndex >= n) return [];

    let stop = line.stops[nextIndex];
    let plats = getStopPlatforms(stop);
    if (!plats.length) return [];

    let virtualTrain = {
        headTrackId: train.targetTrackId,
        headDist: train.targetDist,
        headForward: (train.targetForward != null) ? train.targetForward : train.headForward,
        homeDepotTrackId: train.homeDepotTrackId,
        targetTrackId: null,
        targetDist: null
    };

    let overrideId = train.platformOverrides && train.platformOverrides[stop.id];
    let candidates = (overrideId && plats.some(p => p.id === overrideId)) ? plats.filter(p => p.id === overrideId) : plats;

    let bestRoute = null, bestLen = Infinity, chosenTrackId = null, chosenDist = null;
    for (let p of candidates) {
        let t = getTrack(p.track_id);
        if (!t) continue;
        let targetM = pxToMeters(t, p.t_dist);
        let route = computeTrainRoute(virtualTrain, p.track_id, targetM);
        if (route && route.totalMeters < bestLen) {
            bestLen = route.totalMeters; bestRoute = route; chosenTrackId = p.track_id; chosenDist = targetM;
        }
    }
    if (!bestRoute) return [];

    let pts = [];
    let startTrack = getTrack(virtualTrain.headTrackId);
    if (!startTrack) return [];
    let startPt = pointAtMeters(startTrack, virtualTrain.headDist);
    if (startPt) pts.push(startPt);

    if (bestRoute.directOnCurrent) {
        let p = pointAtMeters(startTrack, chosenDist);
        if (p) pts.push(p);
        return pts;
    }
    for (let e of bestRoute.edges) {
        let t2 = getTrack(e.trackId);
        if (!t2) break;
        let to = (e.trackId === chosenTrackId) ? chosenDist : (e.forward ? trackMeters(t2) : 0);
        let p = pointAtMeters(t2, to);
        if (p) pts.push(p);
    }
    return pts;
}

// World-space polyline points previewing the full stop-by-stop path `train`
// would take if assigned to `line` right now, starting from its current
// position and running through every stop on the line in order (mirrors
// the platform-choice logic in routeTrainToLineStop/getTrainNextPathPoints,
// generalized to chain across a whole line rather than a single leg).
// Purely a hover preview for the line-assignment dropdown: computed fresh
// from a virtual train state and never written back to the real train, so
// hovering around the dropdown has zero effect on navigation.
function getLineHoverPreviewPoints(train, line) {
    if (!train || !line || !Array.isArray(line.stops) || line.stops.length < 2) return [];

    let virt = {
        headTrackId: train.headTrackId,
        headDist: train.headDist,
        headForward: train.headForward,
        homeDepotTrackId: train.homeDepotTrackId,
        length: train.length
    };
    let startTrack = getTrack(virt.headTrackId);
    if (!startTrack) return [];
    let pts = [];
    let startPt = pointAtMeters(startTrack, virt.headDist);
    if (startPt) pts.push(startPt);

    for (let stop of line.stops) {
        let plats = getStopPlatforms(stop);
        if (!plats.length) break;

        let bestRoute = null, bestLen = Infinity, chosen = null;
        for (let p of plats) {
            let t = getTrack(p.track_id);
            if (!t) continue;
            let targetM = pxToMeters(t, p.t_dist);
            let route = computeTrainRoute(virt, p.track_id, targetM);
            if (route && route.totalMeters < bestLen) {
                bestLen = route.totalMeters; bestRoute = route; chosen = p;
            }
        }
        if (!bestRoute) break; // rest of the line is unreachable from here - stop the preview at the last reachable stop

        let chosenTrack = getTrack(chosen.track_id);
        let arrivalForward = bestRoute.directOnCurrent ? virt.headForward : bestRoute.edges[bestRoute.edges.length - 1].forward;
        let stopDist = platformStopDist(virt, chosenTrack, chosen, arrivalForward);

        if (bestRoute.directOnCurrent) {
            let p = pointAtMeters(chosenTrack, stopDist);
            if (p) pts.push(p);
        } else {
            for (let e of bestRoute.edges) {
                let t2 = getTrack(e.trackId);
                if (!t2) break;
                let to = (e.trackId === chosen.track_id) ? stopDist : (e.forward ? trackMeters(t2) : 0);
                let p = pointAtMeters(t2, to);
                if (p) pts.push(p);
            }
        }

        virt = { headTrackId: chosenTrack.id, headDist: stopDist, headForward: arrivalForward, homeDepotTrackId: train.homeDepotTrackId, length: train.length };
    }
    return pts;
}

function advanceTrainHead(train, deltaM) {
    if (!(deltaM > 0)) return;
    let remaining = deltaM;
    let guard = 0;
    while (remaining > 1e-7 && guard < 64) {
        guard++;
        let t = getTrack(train.headTrackId);
        if (!t) { train.mode = 'idle'; train.speedMs = 0; return; }
        let forward = train.headForward;
        let bound = edgeBound(train, train.headTrackId, forward);
        let room = Math.max(0, forward ? (bound - train.headDist) : (train.headDist - bound));

        if (remaining <= room + 1e-7) {
            train.headDist += forward ? remaining : -remaining;
            remaining = 0;
        } else {
            train.headDist = bound;
            remaining -= room;
            let reachedTarget = (train.headTrackId === train.targetTrackId && train.targetDist != null &&
                Math.abs(train.headDist - train.targetDist) < 1e-4);
            if (reachedTarget) {
                train.speedMs = 0;
                onTrainArrive(train);
                return;
            }
            if (train.route.length === 0) {
                train.speedMs = 0;
                train.mode = 'idle';
                return;
            }
            let next = train.route.shift();
            let t2 = getTrack(next.trackId);
            if (!t2) { train.mode = 'idle'; train.speedMs = 0; return; }
            train.headTrackId = next.trackId;
            train.headForward = next.forward;
            train.headDist = next.forward ? 0 : trackMeters(t2);
            train.history.push({ trackId: next.trackId, forward: next.forward });
        }
    }
}

function onTrainArrive(train) {
    if (train.mode === 'line' && train.pendingStop) {
        handleStopArrival(train, train.pendingStop);
        let dwell = (typeof train.pendingStop.dwellSeconds === 'number') ? train.pendingStop.dwellSeconds : 30;
        train.dwellUntil = simTimeSeconds + dwell;
    } else {
        train.mode = 'idle';
        train.route = [];
        train.targetTrackId = null;
        train.targetDist = null;
    }
    if (selectedTrainId === train.id) updateTrainPanel();
}

// Advances a line-assigned train to its next stop, one stop at a time in
// whichever direction it's currently working. Normal one-way service never
// reaches this function already sitting at the last stop - simTick
// intercepts that and unassigns the train's line entirely instead (see the
// dwell-elapsed handling there); startReturnToFirstStop() is only used for
// the initial non-stop run to a line's first stop when a train is freshly
// assigned to it.
function advanceToNextLineStop(train) {
    let line = getLine(train.lineId);
    if (!line || !line.stops || line.stops.length < 2) { train.mode = 'idle'; return; }
    let n = line.stops.length;
    let nextIndex = train.stopIndex + train.direction;
    // Defensive clamp in case stopIndex/direction ever end up out of range.
    if (nextIndex < 0) nextIndex = 0;
    else if (nextIndex >= n) nextIndex = n - 1;

    routeTrainToLineStop(train, line, nextIndex, line.stops[nextIndex]);
}

// The actual pathfind-to-a-stop body, factored out of advanceToNextLineStop
// so it can also be used to re-path a train to the stop it's ALREADY
// working (same stopIndex, no service progress change) after an in-place
// manual reverse - see reverseTrain.
function routeTrainToLineStop(train, line, stopIndex, stop) {
    let plats = getStopPlatforms(stop);
    if (!plats.length) { train.mode = 'idle'; showToast('Line "' + line.name + '" has a stop with no platform.'); return; }

    // computeTrainRoute's own search already explores turning the train
    // around right where it's currently standing (subject to the same
    // turnback rules as any other junction - see isTurnAllowed), so a single
    // pass is enough; a previous version of this function used to retry with
    // an unconditional flipTrainHeadingInPlace() when the first attempt
    // failed, but that bypassed the turnback requirement entirely (it
    // physically performed the very reversal that had just been correctly
    // refused, then simply re-asked whether continuing forward from the new,
    // already-illegally-rotated heading worked - which of course it did).
    // That effectively let trains u-turn at any plain dead end, so it's gone.
    {
        let overrideId = train.platformOverrides && train.platformOverrides[stop.id];
        let candidates = plats;
        if (overrideId && plats.some(p => p.id === overrideId)) candidates = plats.filter(p => p.id === overrideId);

        // Prefer a platform the train is already standing at (see
        // isTrainAtPlatform for why computeTrainRoute alone can miss this).
        // Only take this zero-cost shortcut while the train is actually
        // stopped (or effectively so) - isTrainAtPlatform only checks
        // physical overlap with the platform marker, so a train still
        // rolling through at speed could otherwise be treated as "arrived"
        // and skipped straight past proper braking, arriving (and starting
        // its dwell) without ever having come to a stop. A moving train
        // instead falls through to the normal route search below, which
        // gives it a real target to brake down to.
        let chosen = null, bestRoute = null, bestLen = Infinity;
        if (train.speedMs < TRAIN_STOPPED_MS) {
            for (let p of candidates) {
                if (isTrainAtPlatform(train, p)) {
                    chosen = p; bestLen = 0;
                    bestRoute = { edges: [], directOnCurrent: true, totalMeters: 0 };
                    break;
                }
            }
        }
        if (!chosen) {
            for (let p of candidates) {
                let t = getTrack(p.track_id);
                if (!t) continue;
                let targetM = pxToMeters(t, p.t_dist);
                let route = computeTrainRoute(train, p.track_id, targetM);
                if (route && route.totalMeters < bestLen) {
                    bestLen = route.totalMeters; bestRoute = route; chosen = p;
                }
            }
        }
        // Fall back to every platform at the stop if the override was unreachable.
        if (!chosen && candidates !== plats) {
            for (let p of plats) {
                let t = getTrack(p.track_id);
                if (!t) continue;
                let targetM = pxToMeters(t, p.t_dist);
                let route = computeTrainRoute(train, p.track_id, targetM);
                if (route && route.totalMeters < bestLen) {
                    bestLen = route.totalMeters; bestRoute = route; chosen = p;
                }
            }
        }

        if (chosen) {
            let chosenTrack = getTrack(chosen.track_id);
            let arrivalForward = bestRoute.directOnCurrent ? train.headForward : bestRoute.edges[bestRoute.edges.length - 1].forward;

            // The train is already standing on this platform's segment right
            // now (this is the isTrainAtPlatform zero-cost match above) -
            // its occupied footprint (both ends, not just its head) overlaps
            // the marker. Driving the last stretch there can get stuck: if
            // its current heading puts the ideal arrival point behind its
            // head rather than ahead (e.g. it was just manually reversed, or
            // a long train's head has already passed the ideal point while
            // its tail is what's actually over the marker), gatherLookahead
            // reports the target as zero distance away and speed control
            // just holds the train at 0 speed forever, never reaching
            // onTrainArrive. Teleport it straight onto the correct centred
            // position instead of trying to reason about which way to nudge
            // it from here.
            if (bestRoute.edges.length === 0 && isTrainAtPlatform(train, chosen) && train.speedMs < TRAIN_STOPPED_MS) {
                snapTrainToPlatform(train, chosenTrack, chosen);
                arrivalForward = train.headForward;
            }

            train.route = bestRoute.edges;
            train.targetTrackId = chosen.track_id;
            train.targetDist = platformStopDist(train, chosenTrack, chosen, arrivalForward);
            train.targetForward = arrivalForward;
            train.stopIndex = stopIndex;
            train.pendingStop = stop;
            train.pendingPlatformId = chosen.id;
            train.mode = 'line';
            train.dwellUntil = null;

            // Already sitting right at the stop point (zero distance left to
            // travel) *and* actually stopped - enter dwell now rather than
            // waiting on the physics loop, which only fires arrival on
            // nonzero movement crossing a segment boundary. Requiring the
            // train to be at (near) 0 km/h here too means a train that's
            // merely passing through this exact point at speed (e.g. the
            // zero-cost "already standing" match above was skipped because
            // it was moving) never gets teleported into a dwell - it has to
            // actually brake to a stop first, same as arriving normally.
            if (train.speedMs < TRAIN_STOPPED_MS && train.headTrackId === train.targetTrackId && Math.abs(train.headDist - train.targetDist) < 1e-3) {
                onTrainArrive(train);
            }
            return;
        }
    }

    train.mode = 'idle';
    showToast('No route to next stop for ' + train.label + ' - it may need a turnback to reverse.');
}

// Called when a line-assigned train's dwell elapses at the last stop of its
// (one-way) line. Rather than shuttling back out stop-by-stop, the train
// runs straight back to the first stop as a single non-revenue
// repositioning move - it does not stop, dwell, or serve any of the stops
// it happens to physically pass on the way back: a real one-way service
// runs light back to its start, it doesn't pick up in the "wrong"
// direction. Arriving back at the first stop is treated as a perfectly
// ordinary stop arrival and normal forward service resumes from there.
function startReturnToFirstStop(train, line) {
    let stop0 = line.stops[0];
    let plats = getStopPlatforms(stop0);
    if (!plats.length) { train.mode = 'idle'; showToast('Line "' + line.name + '" has a stop with no platform.'); return; }

    let overrideId = train.platformOverrides && train.platformOverrides[stop0.id];
    let candidates = (overrideId && plats.some(p => p.id === overrideId)) ? plats.filter(p => p.id === overrideId) : plats;

    let chosen = null, bestRoute = null, bestLen = Infinity;
    if (train.speedMs < TRAIN_STOPPED_MS) {
        for (let p of candidates) {
            if (isTrainAtPlatform(train, p)) {
                chosen = p; bestRoute = { edges: [], directOnCurrent: true, totalMeters: 0 };
                break;
            }
        }
    }
    if (!chosen) {
        for (let p of candidates) {
            let t = getTrack(p.track_id);
            if (!t) continue;
            let route = computeTrainRoute(train, p.track_id, pxToMeters(t, p.t_dist));
            if (route && route.totalMeters < bestLen) { bestLen = route.totalMeters; bestRoute = route; chosen = p; }
        }
    }
    if (!chosen && candidates !== plats) {
        for (let p of plats) {
            let t = getTrack(p.track_id);
            if (!t) continue;
            let route = computeTrainRoute(train, p.track_id, pxToMeters(t, p.t_dist));
            if (route && route.totalMeters < bestLen) { bestLen = route.totalMeters; bestRoute = route; chosen = p; }
        }
    }
    if (!chosen) {
        train.mode = 'idle';
        showToast(train.label + ' has no route back to the start of ' + line.name + ' - it may need a turnback to reverse.');
        return;
    }

    let chosenTrack = getTrack(chosen.track_id);
    let arrivalForward = bestRoute.directOnCurrent ? train.headForward : bestRoute.edges[bestRoute.edges.length - 1].forward;
    if (bestRoute.edges.length === 0 && isTrainAtPlatform(train, chosen) && train.speedMs < TRAIN_STOPPED_MS) {
        snapTrainToPlatform(train, chosenTrack, chosen);
        arrivalForward = train.headForward;
    }

    train.route = bestRoute.edges;
    train.targetTrackId = chosen.track_id;
    train.targetDist = platformStopDist(train, chosenTrack, chosen, arrivalForward);
    train.targetForward = arrivalForward;
    train.stopIndex = 0;
    train.direction = 1;
    train.pendingStop = stop0;
    train.pendingPlatformId = chosen.id;
    train.mode = 'line';
    train.dwellUntil = null;

    if (train.speedMs < TRAIN_STOPPED_MS && train.headTrackId === train.targetTrackId && Math.abs(train.headDist - train.targetDist) < 1e-3) {
        onTrainArrive(train);
    }
}

function assignLineToTrain(train, lineId) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to assign lines."); return; }
        MP.sendInput({ type: 'ASSIGN_LINE', trainId: train.id, lineId: lineId || null });
        return;
    }
    train.lineId = lineId || null;
    train.platformOverrides = {};
    if (!lineId) {
        train.mode = 'idle';
        train.route = [];
        train.targetTrackId = null;
        train.targetDist = null;
        train.color = NO_LINE_TRAIN_COLOR;
        return;
    }
    let line = getLine(lineId);
    train.color = (line && line.color) || NO_LINE_TRAIN_COLOR;
    if (!line || !line.stops || line.stops.length < 2) {
        showToast('That line needs at least 2 stops.');
        train.mode = 'idle';
        return;
    }
    // A one-way line always starts service from its first stop, no matter
    // where the train happens to be sitting right now - so getting there is
    // exactly the same non-stop repositioning move as the automatic run
    // back to the start at the end of a lap (see startReturnToFirstStop):
    // it does not stop, dwell, or board at any other stop it happens to
    // pass on the way.
    startReturnToFirstStop(train, line);
    if (train.mode === 'line') showToast(train.label + ' assigned to ' + line.name + '.');
}

// Recomputes the live manual-route preview for whatever's under the cursor
// while a train is armed for manual routing. Mirrors exactly what a click
// at (wx, wy) would do in handleCanvasClick's manual-route branch (same
// nearest-track-point search, same 40px snap radius, same pathfinder), but
// only ever writes to manualRoutePreview - it never touches the train's
// actual route/target, so hovering around has zero effect on navigation
// until the player actually clicks.
function updateManualRoutePreview(wx, wy) {
    let train = trains.find(t => t.id === manualRouteArmedTrainId);
    if (!train) { manualRoutePreview = null; return; }

    let wpMarkers = manualRouteWaypoints.map(waypointToXY).filter(Boolean);

    let hit = getNearestTrackPoint(wx, wy, null);
    if (!hit || hit.dist >= 40) {
        manualRoutePreview = { points: [], target: null, valid: false, waypoints: wpMarkers };
        return;
    }

    let distM = pxToMeters(hit.track, hit.t_px);
    // Chain through any mid-points already dropped with right-click, then on
    // to wherever the cursor is right now, so the preview always shows the
    // FULL path the train would take if the player committed at this exact
    // cursor position.
    let full = manualRouteWaypoints.concat([{ trackId: hit.track.id, dist: distM }]);
    let chained = computeChainedRoute(train, full);
    if (!chained) {
        manualRoutePreview = { points: [], target: { x: hit.x, y: hit.y }, valid: false, waypoints: wpMarkers };
        return;
    }

    // A lightweight virtual train sharing the real train's current
    // position/heading - getTrainPathPoints only reads head*/route/target
    // fields, so this reuses the exact same polyline logic as the
    // committed-route overlay without ever mutating the real train.
    let virtualTrain = {
        headTrackId: train.headTrackId,
        headForward: train.headForward,
        headDist: train.headDist,
        route: chained.edges,
        targetTrackId: hit.track.id,
        targetDist: distM
    };
    manualRoutePreview = { points: getTrainPathPoints(virtualTrain), target: { x: hit.x, y: hit.y }, valid: true, waypoints: wpMarkers };
}

// `waypoints` (optional) is an ordered list of {trackId, dist} mid-points
// the route must pass through before finally reaching (trackId, distM) -
// see armManualRoute/computeChainedRoute. Omitted/empty behaves exactly as
// before: a single direct pathfind straight to the target.
function setManualTarget(train, trackId, distM, waypoints) {
    waypoints = waypoints || [];
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'MANUAL_ROUTE', trainId: train.id, trackId, distM, waypoints });
        return;
    }
    let chained = computeChainedRoute(train, waypoints.concat([{ trackId, dist: distM }]));
    if (!chained) { showToast('No route to that point.'); return; }
    train.route = chained.edges;
    train.targetTrackId = trackId;
    train.targetDist = distM;
    train.targetForward = chained.finalForward;
    train.mode = 'manual';
    train.pendingStop = null;
    train.dwellUntil = null;
    showToast(train.label + ' routed manually' + (waypoints.length ? (' via ' + waypoints.length + ' mid-point' + (waypoints.length > 1 ? 's' : '')) : '') + '.');
}

// Re-solves an ALREADY-committed route (line or manual) so it passes through
// one new mid-point on its way to the exact same final target - the target,
// mode, line assignment and pending-stop bookkeeping are all left untouched,
// only `route`/`targetForward` are replaced. This is deliberately separate
// from setManualTarget: bending a line train's path shouldn't knock it out
// of service or stop it dwelling/continuing normally once it arrives - see
// armAdjustRoute/finishAdjustRouteDrag.
function applyRouteAdjustment(train, waypointTrackId, waypointDist) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'ADJUST_ROUTE', trainId: train.id, trackId: waypointTrackId, distM: waypointDist });
        return;
    }
    if (train.targetTrackId == null) { showToast(train.label + ' has no active route to adjust.'); return; }
    let chained = computeChainedRoute(train, [
        { trackId: waypointTrackId, dist: waypointDist },
        { trackId: train.targetTrackId, dist: train.targetDist }
    ]);
    if (!chained) { showToast('No legal path through that point.'); return; }
    train.route = chained.edges;
    train.targetForward = chained.finalForward;
    showToast(train.label + '\u2019s route adjusted.');
}

// Physically flips a train's heading in place - its body reverses along the
// same section of track it currently occupies. This is just the physical
// half of a turnback (headTrackId/headForward/history/route); it doesn't
// touch the train's line-shuttle direction or mode, so callers handle that
// themselves. Used by the player's manual Reverse action, and automatically
// when a line train reaches a terminus and has to turn around to continue.
function flipTrainHeadingInPlace(train) {
    if (!train._occ || train._occ.length === 0) return false;
    // train._occ is head-most-first (occ[0] = current head segment, occ[last]
    // = current tail segment). After an in-place flip the physical body stays
    // on exactly the same segments, but the old tail becomes the new head and
    // vice versa, so every segment's direction of travel reverses. Critically,
    // history must stay oldest-to-newest ending at the (new) head, and since
    // occ[0] (old head) is now the new *tail* end and occ[last] (old tail) is
    // now the new *head* end, that oldest-to-newest order is already exactly
    // occ's existing head-first order - it must NOT be reversed again, or the
    // reconstructed head track/position ends up mismatched with headDist
    // (visible as the train jumping position on flip, especially once its
    // body spans more than one track).
    let tailSeg = train._occ[train._occ.length - 1];
    let newHistory = train._occ.map(seg => ({ trackId: seg.trackId, forward: !seg.forward }));
    train.history = newHistory;
    let newCur = newHistory[newHistory.length - 1];
    train.headTrackId = newCur.trackId;
    train.headForward = newCur.forward;
    train.headDist = tailSeg.forward ? tailSeg.startM : tailSeg.endM;
    train.route = [];
    train.speedMs = 0;
    train._occ = getOccupiedEdges(train);
    return true;
}

function reverseTrain(train) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'REVERSE_TRAIN', trainId: train.id });
        return;
    }
    if (train.speedMs > TRAIN_STOPPED_MS) { showToast('Train must be stopped to reverse.'); return; }

    // The player can now reverse anywhere, not just at a flagged turnback
    // or the train's own depot - but doing so outside one of those proper
    // reversing facilities leaves the train crawling at
    // REVERSE_PENALTY_SPEED_KMH afterward (a rough, unauthorized reversal),
    // until it reverses again (anywhere), which clears the restriction back
    // to normal. Evaluated on the track the train is standing on *before*
    // the flip - that's the physical location the reversal is happening at.
    let properArea = canReverseInPlace(train);

    // Being able to physically reverse in place doesn't mean it has to
    // unassign the train from its line - a stopped train can turn around
    // and keep working its service. What matters is not disturbing its
    // service *progress* (stopIndex/pendingStop/dwell) while doing it:
    let wasMidRoute = train.mode === 'line' && train.dwellUntil == null;
    let wasDwelling = train.mode === 'line' && train.dwellUntil != null;
    let line = wasMidRoute ? getLine(train.lineId) : null;
    let stopIndex = train.stopIndex, pendingStop = train.pendingStop;

    if (!flipTrainHeadingInPlace(train)) return;

    if (!properArea) train.reversePenaltyActive = !train.reversePenaltyActive;

    if (wasMidRoute && line) {
        // Mid-route (e.g. held at a red signal) - re-path to the exact same
        // stop it was already heading to, from its new heading. This does
        // NOT advance stopIndex or touch pendingStop, so the line and its
        // progress are untouched - only the physical route to get there is
        // recomputed.
        train.mode = 'line';
        routeTrainToLineStop(train, line, stopIndex, pendingStop);
    } else if (wasDwelling) {
        // Already arrived and sitting in its dwell - flipping here is
        // purely cosmetic (re-aims it for its next departure) and must not
        // restart or otherwise touch the running dwell timer.
        train.mode = 'line';
    } else {
        train.direction *= -1;
        train.mode = 'idle';
        train.targetTrackId = null;
        train.targetDist = null;
    }
    showToast(train.label + ' reversed.' + (!properArea ? (train.reversePenaltyActive ? (' Unauthorized reversal - capped at ' + REVERSE_PENALTY_SPEED_KMH + ' km/h until it reverses again.') : ' Speed restriction cleared.') : ''));
}

function toggleEmergencyBrake(train) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'TOGGLE_BRAKE', trainId: train.id });
        return;
    }
    train.emergencyBrake = !train.emergencyBrake;
    showToast(train.label + (train.emergencyBrake ? ': emergency brake applied.' : ': emergency brake released.'));
    if (!train.emergencyBrake && train.mode === 'idle' && train.lineId) {
        // Resume service on release if it still has a line assigned but idled.
        advanceToNextLineStop(train);
    }
}

function setTrainSpeedCap(train, kmh) {
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'SET_SPEED_CAP', trainId: train.id, speedCapKmh: kmh });
        return;
    }
    train.speedCapKmh = (kmh == null || isNaN(kmh) || kmh < 0) ? null : kmh;
}

// ============================================================
// --- Passengers / demand ---
// ============================================================

function timeStrToSeconds(s) {
    if (!s || s.length < 3) return 0;
    let h = parseInt(s.slice(0, 2), 10), m = parseInt(s.slice(2), 10);
    return h * 3600 + m * 60;
}

function interpCurve(points, timeSeconds) {
    if (!points || points.length === 0) return 0;
    let pts = points.map(p => ({ t: timeStrToSeconds(p.time), v: p.value })).sort((a, b) => a.t - b.t);
    let tod = ((timeSeconds % 86400) + 86400) % 86400;
    if (tod <= pts[0].t) return pts[0].v;
    if (tod >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
    for (let i = 0; i < pts.length - 1; i++) {
        let a = pts[i], b = pts[i + 1];
        if (tod >= a.t && tod <= b.t) {
            let frac = (b.t === a.t) ? 0 : (tod - a.t) / (b.t - a.t);
            return a.v + (b.v - a.v) * frac;
        }
    }
    return pts[pts.length - 1].v;
}

function pickWeightedDestination(group, excludeCode) {
    let codes = Object.keys(group.stationDemand || {}).filter(c => c !== excludeCode);
    let weights = codes.map(c => Math.max(0, interpCurve(group.stationDemand[c].attract, simTimeSeconds)));
    let total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = Math.random() * total;
    for (let i = 0; i < codes.length; i++) {
        r -= weights[i];
        if (r <= 0) return codes[i];
    }
    return codes[codes.length - 1];
}

function platformWaiting(plat) {
    if (!plat._waiting) plat._waiting = {};
    return plat._waiting;
}

function simulatePassengers(dtSimSeconds) {
    if (!state.demand || !state.demand.groups || dtSimSeconds <= 0) return;

    // Periodically check for (and fix) passengers stranded on the wrong
    // platform - see rebalancePlatformWaiting(). Throttled since it's a
    // full station/destination sweep, not something that needs to run
    // every single frame.
    _platformRebalanceAcc += dtSimSeconds;
    if (_platformRebalanceAcc >= PLATFORM_REBALANCE_INTERVAL_S) {
        _platformRebalanceAcc = 0;
        rebalancePlatformWaiting();
    }

    // Cache which platforms serve a given destination per station, reused
    // across every group/station this tick - the underlying lines/platforms
    // don't change mid-tick, so there's no need to recompute it per spawn.
    let servingCache = {};
    for (let group of state.demand.groups) {
        if (!group.stationDemand) continue;
        group._spawnAcc = group._spawnAcc || {};
        for (let stationCode of Object.keys(group.stationDemand)) {
            let dem = group.stationDemand[stationCode];
            let rate = interpCurve(dem.inflow, simTimeSeconds); // passengers/min
            if (!(rate > 0)) continue;
            let plats = state.platforms.filter(p => p.stationCode === stationCode);
            if (!plats.length) continue;
            group._spawnAcc[stationCode] = (group._spawnAcc[stationCode] || 0) + (rate * dtSimSeconds / 60);
            while (group._spawnAcc[stationCode] >= 1) {
                group._spawnAcc[stationCode] -= 1;
                let dest = pickWeightedDestination(group, stationCode);
                if (!dest) continue;
                // Wait at whichever platform(s) actually go toward this
                // destination, not a uniformly random one at the station.
                let cacheKey = stationCode + '|' + dest;
                let candidatePlats = servingCache[cacheKey];
                if (!candidatePlats) {
                    candidatePlats = platformsServingDestination(plats, dest);
                    servingCache[cacheKey] = candidatePlats;
                }
                let plat = candidatePlats[Math.floor(Math.random() * candidatePlats.length)];
                let waiting = platformWaiting(plat);
                if (typeof plat.capacity === 'number' && plat.capacity > 0) {
                    let total = Object.values(waiting).reduce((a, b) => a + b, 0);
                    if (total >= plat.capacity) continue;
                }
                waiting[dest] = (waiting[dest] || 0) + 1;
            }
        }
    }
}

function lineServesDestination(line, destCode) {
    if (!line) return false;
    return line.stops.some(stop => getStopPlatforms(stop).some(p => p.stationCode === destCode));
}

// If a train currently assigned to `line` has manually overridden which
// platform it actually calls at for `stop` (see the "Platform at next stop"
// picker), that override is which platform is genuinely being served right
// now - the diagram's default platformIds for the stop are no longer the
// whole story. Returns the overridden platform id, or null if nothing on
// this line has one recorded for this stop.
function activeOverridePlatformForStop(line, stop) {
    for (let t of trains) {
        if (t.lineId !== line.id) continue;
        let overrideId = t.platformOverrides && t.platformOverrides[stop.id];
        if (overrideId) return overrideId;
    }
    return null;
}

// Narrows a station's platforms down to the ones actually useful for a
// given destination - i.e. platforms that some line calls at which also
// serves that destination somewhere along its route. Stations with
// separate platforms per direction (or per line) would otherwise have
// passengers spawn on a uniformly random platform regardless of which way
// they actually need to go, so a passenger bound north could easily end up
// waiting on the southbound platform forever. Also respects any live
// platform override (see activeOverridePlatformForStop) - if a train on the
// relevant line is actually calling at a different platform than the stop's
// default for this station, new passengers should wait where that train
// will really show up, not where the diagram nominally points. Falls back
// to every platform at the station if none can be matched (e.g. no line
// assigned yet), so passengers still spawn somewhere rather than vanishing.
function platformsServingDestination(plats, destCode) {
    let fromStationCode = plats.length ? plats[0].stationCode : null;
    let serving = plats.filter(p =>
        state.lines.some(line => {
            if (!lineHelpsTowardDestination(line, fromStationCode, destCode)) return false;
            return line.stops.some(stop => {
                if (!getStopPlatforms(stop).some(sp => sp.id === p.id)) return false;
                let overrideId = activeOverridePlatformForStop(line, stop);
                return !overrideId || overrideId === p.id;
            });
        })
    );
    return serving.length ? serving : plats;
}

// How often (in simulated seconds) to sweep every multi-platform station and
// check whether anyone already waiting is stuck on a platform that no longer
// actually serves their destination. platformsServingDestination() only
// picks the *right* platform for a passenger at the moment they spawn - if
// the situation changes afterward (a platform override is set/cleared, a
// line is edited or reassigned, a new line opens up a shortcut, etc.) a
// passenger who already spawned keeps waiting exactly where they first
// appeared, since normal boarding only ever pulls from the one platform a
// train actually docks at (see handleStopArrival). Without this sweep those
// passengers would simply wait forever. This is what let players see
// passengers "go missing" / never board despite a train stopping right at
// their station - they were on the wrong platform for it.
const PLATFORM_REBALANCE_INTERVAL_S = 5;
let _platformRebalanceAcc = 0;

// Moves any waiting passengers off a platform that no longer serves their
// destination onto one at the same station that does - i.e. lets waiting
// passengers switch platforms when needed, the same way a real passenger
// would walk to a different platform if they realized they were on the
// wrong one.
function rebalancePlatformWaiting() {
    let byStation = {};
    for (let p of state.platforms) {
        if (!p.stationCode) continue;
        (byStation[p.stationCode] = byStation[p.stationCode] || []).push(p);
    }
    let servingCache = {};
    for (let stationCode in byStation) {
        let plats = byStation[stationCode];
        if (plats.length < 2) continue; // only one platform here - nowhere else to move to
        for (let p of plats) {
            let waiting = p._waiting;
            if (!waiting) continue;
            for (let destCode of Object.keys(waiting)) {
                let count = waiting[destCode];
                if (!(count > 0)) continue;
                let cacheKey = stationCode + '|' + destCode;
                let candidatePlats = servingCache[cacheKey];
                if (!candidatePlats) {
                    candidatePlats = platformsServingDestination(plats, destCode);
                    servingCache[cacheKey] = candidatePlats;
                }
                if (candidatePlats.includes(p)) continue; // already waiting somewhere that works
                // This platform doesn't actually go toward destCode (anymore) -
                // move the whole bucket over to one that does.
                delete waiting[destCode];
                let target = candidatePlats[Math.floor(Math.random() * candidatePlats.length)];
                let targetWaiting = platformWaiting(target);
                targetWaiting[destCode] = (targetWaiting[destCode] || 0) + count;
            }
        }
    }
}

// Builds an unweighted "can ride directly" graph between station codes: an
// edge between two stations exists if some line calls at both of them (so
// riding that one line, with no transfer, gets you from one to the other).
// Used to figure out whether boarding a train that doesn't go all the way to
// a passenger's destination is still useful because it reaches a station
// where a transfer can continue the journey.
function buildInterchangeGraph() {
    let graph = new Map();
    let addEdge = (a, b) => {
        if (a === b) return;
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a).add(b);
        graph.get(b).add(a);
    };
    for (let line of state.lines) {
        let codes = new Set();
        for (let stop of line.stops) {
            for (let p of getStopPlatforms(stop)) {
                if (p.stationCode) codes.add(p.stationCode);
            }
        }
        let list = [...codes];
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) addEdge(list[i], list[j]);
        }
    }
    return graph;
}

// Minimum number of line-rides (0 = already there, 1 = one direct line, 2 =
// one transfer, etc) needed to reach `destCode` from every station code
// reachable at all. Recomputed fresh per call rather than cached, since the
// network is small and this only runs at stop-arrival/spawn events, not
// every frame.
function minRidesToDestination(destCode) {
    let graph = buildInterchangeGraph();
    let dist = new Map([[destCode, 0]]);
    let queue = [destCode];
    while (queue.length) {
        let cur = queue.shift();
        let d = dist.get(cur);
        for (let next of (graph.get(cur) || [])) {
            if (!dist.has(next)) { dist.set(next, d + 1); queue.push(next); }
        }
    }
    return dist;
}

// Whether boarding `line` from `fromStationCode` is actually useful for
// reaching `destCode` - either the line goes straight there, or it at least
// reaches some other station (an interchange) from which the remaining trip
// needs fewer further line-rides than staying at `fromStationCode` does.
// This is what stops passengers piling onto any train that merely passes
// through their station: they only board something that's a genuine step
// closer to where they're going.
function lineHelpsTowardDestination(line, fromStationCode, destCode) {
    if (lineServesDestination(line, destCode)) return true;
    let dist = minRidesToDestination(destCode);
    let fromRides = dist.has(fromStationCode) ? dist.get(fromStationCode) : Infinity;
    for (let stop of line.stops) {
        for (let p of getStopPlatforms(stop)) {
            if (!p.stationCode || p.stationCode === fromStationCode) continue;
            let rides = dist.has(p.stationCode) ? dist.get(p.stationCode) : Infinity;
            if (rides < fromRides) return true;
        }
    }
    return false;
}

function handleStopArrival(train, stop) {
    let stopPlatforms = getStopPlatforms(stop);
    let stationCodes = new Set(stopPlatforms.map(p => p.stationCode).filter(Boolean));

    // A one-way line only truly ends at its last stop - everyone on board
    // has to get off there regardless of where they're actually headed,
    // exactly like a real train emptying out at the end of the line, rather
    // than only the handful whose destination happens to be this exact
    // station. The first stop isn't a terminus in this sense: the train
    // arrives there empty anyway (see startReturnToFirstStop), it's just
    // the ordinary start of the next forward run.
    let line = getLine(train.lineId);
    let isTerminus = !!(line && line.stops && train.stopIndex === line.stops.length - 1);

    // Alight.
    let alighted = 0;
    train.passengers = train.passengers.filter(entry => {
        if (isTerminus || stationCodes.has(entry.destCode)) { alighted += entry.count; return false; }
        return true;
    });
    train.passengerCount = Math.max(0, train.passengerCount - alighted);

    // Board, from every platform belonging to this stop - not just the one
    // this train physically happens to be docked at. A stop can list more
    // than one platform precisely because a train might use either one from
    // visit to visit (a terminus with two platforms and no fixed
    // arrival/departure split, an override, etc) - a passenger who was
    // waiting on the platform the train *isn't* using this time is still,
    // for all practical purposes, standing at the same stop the train just
    // pulled into, and walks over to board rather than missing it. This is
    // separate from rebalancePlatformWaiting(), which periodically fixes up
    // passengers waiting on a platform that doesn't serve their destination
    // at all - this instead handles "right platform for the stop, just not
    // the specific one the train is using right now".
    //
    // Passengers only get on if this line is actually useful to them -
    // either it goes straight to their destination, or it reaches an
    // interchange station that's a genuine step closer (fewer further
    // line-rides needed) than waiting here does. Otherwise they'd be
    // boarding a train that can never get them anywhere nearer to where
    // they're going.
    let boarded = 0;
    let plat = getPlatform(train.pendingPlatformId);
    if (plat && line) {
        let fromStationCode = plat.stationCode;
        for (let srcPlat of stopPlatforms) {
            let waiting = platformWaiting(srcPlat);
            for (let destCode of Object.keys(waiting)) {
                if (train.passengerCount >= train.capacity) break;
                if (stationCodes.has(destCode)) continue; // already home, wouldn't have been waiting for this train anyway
                if (!lineHelpsTowardDestination(line, fromStationCode, destCode)) continue;
                let avail = waiting[destCode];
                if (!(avail > 0)) continue;
                let room = train.capacity - train.passengerCount;
                let board = Math.min(avail, room);
                waiting[destCode] -= board;
                if (waiting[destCode] <= 0) delete waiting[destCode];
                train.passengerCount += board;
                boarded += board;
                let existing = train.passengers.find(e => e.destCode === destCode);
                if (existing) existing.count += board; else train.passengers.push({ destCode, count: board });
            }
        }
    }

    // Recorded purely for the on-screen alight/board counter shown while the
    // train dwells here (see drawTrain) - not used by any gameplay logic.
    train.lastAlighted = alighted;
    train.lastBoarded = boarded;
}

// ============================================================
// --- Collision detection ---
// ============================================================

function occupiedTrackIntersection(sa, sb) {
    if (sa.trackId === sb.trackId) return null;
    let ta = getTrack(sa.trackId);
    let tb = getTrack(sb.trackId);
    if (!ta || !tb) return null;
    // Builder overpasses are drawn on a separate level. A crossing is only
    // a collision when both tracks are on the ground level.
    if (ta.overpass || tb.overpass) return null;
    let a1 = getPoint(ta.p1_id), a2 = getPoint(ta.p2_id);
    let b1 = getPoint(tb.p1_id), b2 = getPoint(tb.p2_id);
    if (!a1 || !a2 || !b1 || !b2) return null;

    let ax = a2.x - a1.x, ay = a2.y - a1.y;
    let bx = b2.x - b1.x, by = b2.y - b1.y;
    let denominator = ax * by - ay * bx;
    if (Math.abs(denominator) < 1e-8) return null;

    let dx = b1.x - a1.x, dy = b1.y - a1.y;
    let u = (dx * by - dy * bx) / denominator;
    let v = (dx * ay - dy * ax) / denominator;
    // Endpoints are handled by the normal route/track occupancy check. This
    // test is specifically for crossings through the middle of two tracks.
    if (u <= 1e-6 || u >= 1 - 1e-6 || v <= 1e-6 || v >= 1 - 1e-6) return null;

    let aMeters = u * trackMeters(ta);
    let bMeters = v * trackMeters(tb);
    if (aMeters < sa.startM - 1e-3 || aMeters > sa.endM + 1e-3 ||
        bMeters < sb.startM - 1e-3 || bMeters > sb.endM + 1e-3) return null;
    return {
        x: a1.x + ax * u,
        y: a1.y + ay * u
    };
}

function checkCollisions() {
    for (let i = 0; i < trains.length; i++) {
        for (let j = i + 1; j < trains.length; j++) {
            let a = trains[i], b = trains[j];
            if (!a._occ || !b._occ) continue;
            for (let sa of a._occ) {
                for (let sb of b._occ) {
                    if (sa.trackId === sb.trackId) {
                        if (sa.startM < sb.endM - 1e-3 && sb.startM < sa.endM - 1e-3) {
                            triggerGameOver(a, b);
                            return true;
                        }
                        continue;
                    }
                    let crossing = occupiedTrackIntersection(sa, sb);
                    if (crossing) {
                        triggerGameOver(a, b, crossing);
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

function triggerGameOver(a, b, collisionPoint) {
    gameOver = true;
    simPaused = true;
    setPaused(true);

    // Find the actual overlapping point between the two trains for the
    // crash close-up - fall back to train a's head if for some reason no
    // exact overlap point is found (shouldn't normally happen, since
    // checkCollisions only calls this once it has found one).
    let crashPt = collisionPoint || null;
    if (!crashPt) {
        outer:
        for (let sa of a._occ || []) {
            for (let sb of b._occ || []) {
                if (sa.trackId !== sb.trackId) continue;
                if (sa.startM < sb.endM - 1e-3 && sb.startM < sa.endM - 1e-3) {
                    let t = getTrack(sa.trackId);
                    let midM = (Math.max(sa.startM, sb.startM) + Math.min(sa.endM, sb.endM)) / 2;
                    crashPt = pointAtMeters(t, midM);
                    break outer;
                }
            }
        }
    }
    if (!crashPt) {
        let ht = getTrack(a.headTrackId);
        crashPt = ht ? pointAtMeters(ht, a.headDist) : { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom };
    }

    startCrashAnimation(crashPt, 'Trains ' + a.label + ' and ' + b.label + ' collided. Service has been halted.');
}

function startCrashAnimation(crashPt, message, tiltRad, eventId) {
    crashEventId = eventId == null ? crashEventId + 1 : eventId;
    let targetZoom = Math.min(3, Math.max(camera.zoom * 1.4, 1.8));
    crashAnim = {
        point: crashPt,
        startMs: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
        duration: 1100,
        fromCam: { x: camera.x, y: camera.y, zoom: camera.zoom },
        toCam: {
            x: window.innerWidth / 2 - crashPt.x * targetZoom,
            y: window.innerHeight / 2 - crashPt.y * targetZoom,
            zoom: targetZoom
        },
        tiltRad: tiltRad == null
            ? (20 * Math.PI / 180) * (Math.random() < 0.5 ? -1 : 1)
            : tiltRad,
        message,
        overlayShown: false
    };
}

// ============================================================
// --- Rendering ---
// ============================================================

function resizeCanvas() {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    draw();
}

function formatSpeedLabel(train) {
    return Math.round(msToKmh(train.speedMs)) + ' km/h';
}

function nextStationLabel(train) {
    if (train.mode === 'manual') return 'Manual route';
    if (train.mode === 'idle') return train.lineId ? 'Idle' : '\u2014';
    if (train.pendingStop) {
        let plats = getStopPlatforms(train.pendingStop);
        let code = plats.length && plats[0].stationCode ? plats[0].stationCode : (plats.length ? (plats[0].number || 'Stop') : 'Stop');
        return code;
    }
    return '\u2014';
}

function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#17171a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Press-and-hold-to-emergency-brake: fires once the hold has been held
    // continuously for TRAIN_EB_HOLD_MS. Checked here (run every rendered
    // frame regardless of pause state) rather than via setTimeout, so it
    // stays in lockstep with the fill animation drawn on the train head and
    // cancels cleanly if the hold is interrupted.
    if (trainHoldTrainId != null && !trainHoldTriggered) {
        let holdCheckMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (holdCheckMs - trainHoldStartMs >= TRAIN_EB_HOLD_MS) {
            trainHoldTriggered = true;
            let heldTrain = trains.find(t => t.id === trainHoldTrainId);
            if (heldTrain && !heldTrain.emergencyBrake) {
                toggleEmergencyBrake(heldTrain);
                if (selectedTrainId === heldTrain.id) updateTrainPanel();
            }
        }
    }

    // Crash camera animation: pan/zoom in on the collision point and tilt
    // the whole view, revealing the game-over overlay only once it settles.
    // The animated camera is swapped in just for this render and restored
    // at the end, so panning/zoom/hit-testing elsewhere never see it.
    let realCamera = camera;
    let tiltRad = 0;
    if (crashAnim) {
        let animNowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let p = Math.min(1, (animNowMs - crashAnim.startMs) / crashAnim.duration);
        let eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
        camera = {
            x: crashAnim.fromCam.x + (crashAnim.toCam.x - crashAnim.fromCam.x) * eased,
            y: crashAnim.fromCam.y + (crashAnim.toCam.y - crashAnim.fromCam.y) * eased,
            zoom: crashAnim.fromCam.zoom + (crashAnim.toCam.zoom - crashAnim.fromCam.zoom) * eased
        };
        tiltRad = crashAnim.tiltRad * eased;
        if (p >= 1 && !crashAnim.overlayShown) {
            crashAnim.overlayShown = true;
            document.getElementById('gameover-msg').textContent = crashAnim.message;
            document.getElementById('gameover-overlay').classList.remove('hidden');
        }
    }

    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    if (tiltRad !== 0) {
        ctx.translate(window.innerWidth / 2, window.innerHeight / 2);
        ctx.rotate(tiltRad);
        ctx.translate(-window.innerWidth / 2, -window.innerHeight / 2);
    }
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 1. Grid
    ctx.beginPath();
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = 1 / camera.zoom;
    let left = -camera.x / camera.zoom;
    let top = -camera.y / camera.zoom;
    let right = left + window.innerWidth / camera.zoom;
    let bottom = top + window.innerHeight / camera.zoom;
    let startX = Math.floor(left / GRID_SIZE) * GRID_SIZE;
    let startY = Math.floor(top / GRID_SIZE) * GRID_SIZE;
    for (let x = startX; x < right; x += GRID_SIZE) {
        ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let y = startY; y < bottom; y += GRID_SIZE) {
        ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.stroke();

    // 2. Platforms (+ waiting passenger count badge)
    for (let p of state.platforms) {
        let geom = getPlatformGeom(p);
        if (!geom) continue;
        ctx.save();
        ctx.translate(geom.px, geom.py);
        ctx.rotate(geom.angle);
        ctx.fillStyle = p.color || DEFAULT_PLATFORM_COLOR;
        ctx.strokeStyle = '#9ca3af';
        ctx.lineWidth = 2;
        ctx.fillRect(-PLAT_LENGTH / 2, -PLAT_WIDTH / 2, PLAT_LENGTH, PLAT_WIDTH);
        ctx.strokeRect(-PLAT_LENGTH / 2, -PLAT_WIDTH / 2, PLAT_LENGTH, PLAT_WIDTH);
        ctx.fillStyle = '#374151';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (p.code) {
            ctx.fillText(p.number || '', 0, -6);
            ctx.font = '10px sans-serif';
            ctx.fillText(p.code, 0, 8);
        } else {
            ctx.fillText(p.number || '', 0, 0);
        }

        // Waiting passenger count badge - drawn inside the platform footprint
        // (same rotated/translated frame as the number above it), pinned to
        // one end of the platform so it never overlaps the number/code text
        // which is centered.
        let waiting = p._waiting;
        if (waiting) {
            let total = Object.values(waiting).reduce((a, b) => a + b, 0);
            if (total > 0) {
                let label = String(total);
                ctx.font = 'bold 10px sans-serif';
                let bw = Math.max(20, ctx.measureText(label).width + 10);
                let bh = 15;
                let bx = PLAT_LENGTH / 2 - (bw / 2) - 4;
                let by = 0;
                drawRoundedRect(ctx, bx - bw / 2, by - bh / 2, bw, bh, 4);
                ctx.fillStyle = 'rgba(15,15,17,0.85)';
                ctx.fill();
                ctx.strokeStyle = '#fbbf24';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = '#fbbf24';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx, by + 0.5);
            }
        }
        ctx.restore();
    }

    // 3. Tracks (underpass first, overpass on top - same convention as Builder)
    // Each segment is stroked with a flat 'butt' cap - sharp ends, no
    // rounded blobs at dead ends, and no bleed past its own endpoint. That
    // leaves a wedge-shaped gap at any bend, since two independently-capped
    // segments don't know about each other. To close it, for every pair of
    // tracks meeting at a point we also stroke a short two-segment "elbow"
    // (out along each track a little way, through the shared point) with a
    // native round line join - canvas guarantees a round join fully covers
    // the gap at any angle, so this can't leave a seam the way separately
    // filling a fixed-radius circle could. It's only drawn between tracks
    // that share the same overpass/underpass layer, so an overpass
    // segment's dark underlay never bleeds onto a connecting ground-level
    // track at a ramp-style joint.
    ctx.lineCap = 'butt';
    const JOINT_STUB_LEN = 10;
    for (let pass of [false, true]) {
        for (let t of state.tracks) {
            if (!!t.overpass !== pass) continue;
            let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
            if (!p1 || !p2) continue;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            if (pass) {
                ctx.lineWidth = 8;
                ctx.strokeStyle = '#17171a';
                ctx.stroke();
            }
            ctx.lineWidth = TRACK_LINE_WIDTH;
            ctx.strokeStyle = t.color || DEFAULT_TRACK_COLOR;
            ctx.stroke();
        }

        ctx.lineJoin = 'round';
        for (let pt of state.points) {
            let here = connectedTracks(pt.id).filter(t => !!t.overpass === pass);
            if (here.length < 2) continue;
            for (let i = 0; i < here.length; i++) {
                for (let j = i + 1; j < here.length; j++) {
                    let o1 = getPoint(here[i].p1_id === pt.id ? here[i].p2_id : here[i].p1_id);
                    let o2 = getPoint(here[j].p1_id === pt.id ? here[j].p2_id : here[j].p1_id);
                    if (!o1 || !o2) continue;
                    let d1 = Math.hypot(o1.x - pt.x, o1.y - pt.y);
                    let d2 = Math.hypot(o2.x - pt.x, o2.y - pt.y);
                    if (!d1 || !d2) continue;
                    let l1 = Math.min(JOINT_STUB_LEN, d1), l2 = Math.min(JOINT_STUB_LEN, d2);
                    let n1x = pt.x + (o1.x - pt.x) / d1 * l1, n1y = pt.y + (o1.y - pt.y) / d1 * l1;
                    let n2x = pt.x + (o2.x - pt.x) / d2 * l2, n2y = pt.y + (o2.y - pt.y) / d2 * l2;
                    ctx.beginPath();
                    ctx.moveTo(n1x, n1y);
                    ctx.lineTo(pt.x, pt.y);
                    ctx.lineTo(n2x, n2y);
                    if (pass) {
                        ctx.lineWidth = 8;
                        ctx.strokeStyle = '#17171a';
                        ctx.stroke();
                    }
                    ctx.lineWidth = TRACK_LINE_WIDTH;
                    ctx.strokeStyle = here[i].color || DEFAULT_TRACK_COLOR;
                    ctx.stroke();
                }
            }
        }
        ctx.lineJoin = 'miter';
    }
    ctx.lineCap = 'butt';

    // 3b. Depot underlay - dashed amber highlight, same as Builder, so
    // depot track segments are obviously clickable for spawning.
    ctx.save();
    ctx.setLineDash([10, 6]);
    for (let t of state.tracks) {
        if (!t.isDepot) continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineWidth = 8;
        ctx.strokeStyle = 'rgba(245,158,11,0.55)';
        ctx.stroke();
    }
    ctx.restore();

    // 4. Track endpoints (small perpendicular end-cap on dead-end track ends)
    ctx.lineWidth = TRACK_LINE_WIDTH;
    for (let pt of state.points) {
        let degree = state.tracks.filter(t => t.p1_id === pt.id || t.p2_id === pt.id).length;
        if (degree !== 1) continue;
        let track = state.tracks.find(t => t.p1_id === pt.id || t.p2_id === pt.id);
        if (!track) continue;
        let otherPt = getPoint(track.p1_id === pt.id ? track.p2_id : track.p1_id);
        if (!otherPt) continue;
        let angle = Math.atan2(otherPt.y - pt.y, otherPt.x - pt.x);
        let perp = angle + Math.PI / 2;
        ctx.strokeStyle = track.color || DEFAULT_TRACK_COLOR;
        let len = 10;
        ctx.beginPath();
        ctx.moveTo(pt.x + Math.cos(perp) * len, pt.y + Math.sin(perp) * len);
        ctx.lineTo(pt.x - Math.cos(perp) * len, pt.y - Math.sin(perp) * len);
        ctx.stroke();
    }

    // 5. Signals - clicking toggles red/blue
    for (let s of state.signals) {
        let geom = getSignalGeom(s);
        if (!geom) continue;
        let isHover = pointerDownSignal === s || hoverSignal === s;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(geom.cx, geom.cy);
        ctx.lineTo(geom.bx, geom.by);
        ctx.lineTo(geom.mx, geom.my);
        ctx.lineTo(geom.px, geom.py);
        ctx.strokeStyle = '#a1a1aa';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.translate(geom.px, geom.py);

        if (isHover) {
            ctx.beginPath();
            ctx.arc(0, 0, SIGNAL_RADIUS + 4, 0, Math.PI * 2);
            ctx.strokeStyle = '#60a5fa';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.save();
        ctx.rotate(geom.facing);
        ctx.beginPath();
        ctx.moveTo(SIGNAL_RADIUS + 2, 0);
        ctx.lineTo(SIGNAL_RADIUS + 11, -6);
        ctx.lineTo(SIGNAL_RADIUS + 11, 6);
        ctx.closePath();
        ctx.fillStyle = '#a1a1aa';
        ctx.fill();
        ctx.restore();

        ctx.beginPath();
        ctx.arc(0, 0, SIGNAL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = s.state === 'blue' ? '#3b82f6' : '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#e4e4e7';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    }

    // 5b. Pathfinding overlay - the hovered or selected train's planned
    // route (remaining current track + queued route to its target), drawn
    // as a glowing line with light animated flowing along it toward the
    // target so it reads as "energized" rather than a static dashed guide.
    let nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    // Glow size and flow speed scale directly with zoom - zoomed in, the
    // overlay reads as a bigger, faster-flowing beam; zoomed out it shrinks
    // back down instead of staying a fixed screen size. shadowBlur/dash
    // speed aren't affected by the canvas transform the way line widths
    // are, so this has to be applied explicitly. Clamped so it never
    // vanishes to nothing at extreme zoom-out or balloons into mush at
    // extreme zoom-in.
    let glowZoom = Math.max(0.5, Math.min(4, camera.zoom));
    for (let train of trains) {
        if (train.id !== selectedTrainId && train.id !== hoverTrainId) continue;
        let pts = getTrainPathPoints(train);
        if (pts.length < 2) continue;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);

        // Dark contrast outline underneath everything else, so the path
        // reads clearly against light track/platform colors as well as the
        // dark background - a pure glow alone can wash out on top of pale
        // tracks.
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 9;
        ctx.stroke();

        // Soft outer glow (wide, blurred halo) in a high-contrast amber -
        // distinct from track/signal/train hues so it never blends in.
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 18 * glowZoom;
        ctx.strokeStyle = 'rgba(245,158,11,0.55)';
        ctx.lineWidth = 7;
        ctx.stroke();

        // Bright core line on top of the glow.
        ctx.shadowBlur = 10 * glowZoom;
        ctx.strokeStyle = '#fef3c7';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();

        // Flowing light: bright dashes animated along the same path,
        // travelling from the train toward its target.
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
        let dashLen = 16, gapLen = 26, period = dashLen + gapLen;
        let flowSpeedPxPerSec = 90 * glowZoom;
        let offset = -((nowMs / 1000) * flowSpeedPxPerSec) % period;
        ctx.setLineDash([dashLen, gapLen]);
        ctx.lineDashOffset = offset;
        ctx.shadowColor = '#fff7ed';
        ctx.shadowBlur = 10 * glowZoom;
        ctx.strokeStyle = '#fff7ed';
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.95;
        ctx.stroke();
        ctx.restore();

        // Further pathfind preview: the leg AFTER the current target, on to
        // the following stop - dimmer and cooler-toned so it reads clearly
        // as "what's next" rather than competing with the active leg above.
        let nextPts = getTrainNextPathPoints(train);
        if (nextPts.length >= 1) {
            let full = [pts[pts.length - 1], ...nextPts];
            if (full.length >= 2) {
                ctx.save();
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(full[0].x, full[0].y);
                for (let k = 1; k < full.length; k++) ctx.lineTo(full[k].x, full[k].y);
                ctx.shadowColor = '#38bdf8';
                ctx.shadowBlur = 9 * glowZoom;
                ctx.strokeStyle = 'rgba(56,189,248,0.55)';
                ctx.lineWidth = 4;
                ctx.setLineDash([9, 10]);
                ctx.lineDashOffset = -((nowMs / 1000) * 40 * glowZoom) % 19;
                ctx.globalAlpha = 0.8;
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    // 5c. Line-assignment hover preview - while the player is hovering an
    // option in the selected train's line dropdown, show the full
    // stop-by-stop path that train would take if assigned to it right now.
    // Distinct teal styling from both the amber "committed route" overlay
    // above and the cyan manual-route preview below, so none of the three
    // get confused with each other - this one hasn't been assigned to
    // anything, it's just what-if.
    if (lineHoverPreviewId) {
        let previewTrain = trains.find(t => t.id === selectedTrainId);
        let previewLine = getLine(lineHoverPreviewId);
        if (previewTrain && previewLine) {
            let pts = getLineHoverPreviewPoints(previewTrain, previewLine);
            if (pts.length >= 2) {
                ctx.save();
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);

                ctx.shadowBlur = 0;
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = 9;
                ctx.stroke();

                ctx.shadowColor = '#2dd4bf';
                ctx.shadowBlur = 18 * glowZoom;
                ctx.strokeStyle = 'rgba(45,212,191,0.55)';
                ctx.lineWidth = 7;
                ctx.stroke();

                ctx.shadowBlur = 10 * glowZoom;
                ctx.strokeStyle = '#ccfbf1';
                ctx.lineWidth = 2.5;
                ctx.stroke();
                ctx.restore();

                ctx.save();
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
                let dashLen = 12, gapLen = 20, period = dashLen + gapLen;
                let flowSpeedPxPerSec = 70 * glowZoom;
                let offset = -((nowMs / 1000) * flowSpeedPxPerSec) % period;
                ctx.setLineDash([dashLen, gapLen]);
                ctx.lineDashOffset = offset;
                ctx.shadowColor = '#f0fdfa';
                ctx.shadowBlur = 8 * glowZoom;
                ctx.strokeStyle = '#f0fdfa';
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.9;
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    // 5d. Manual-route picking preview - the path the armed train would take
    // to wherever the cursor currently is, drawn live as the pointer moves
    // and before any click commits it. Distinct cool cyan styling (vs. the
    // amber "committed route" overlay above) makes clear this is only a
    // preview, plus a target ring at the exact snap point and a red "no
    // route" marker when nothing legal is reachable from here.
    if (manualRouteArmedTrainId && manualRoutePreview) {
        let pts = manualRoutePreview.points;
        if (manualRoutePreview.valid && pts.length >= 2) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);

            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 8;
            ctx.stroke();

            ctx.shadowColor = '#22d3ee';
            ctx.shadowBlur = 14 * glowZoom;
            ctx.strokeStyle = 'rgba(34,211,238,0.55)';
            ctx.lineWidth = 6;
            ctx.setLineDash([12, 10]);
            ctx.lineDashOffset = -((nowMs / 1000) * 70 * glowZoom) % 22;
            ctx.stroke();

            ctx.shadowBlur = 8 * glowZoom;
            ctx.strokeStyle = '#cffafe';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        }

        if (manualRoutePreview.target) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(manualRoutePreview.target.x, manualRoutePreview.target.y, 8, 0, Math.PI * 2);
            ctx.strokeStyle = manualRoutePreview.valid ? '#22d3ee' : '#ef4444';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(manualRoutePreview.target.x, manualRoutePreview.target.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = manualRoutePreview.valid ? '#22d3ee' : '#ef4444';
            ctx.fill();
            ctx.restore();
        }

        // Mid-points already dropped with right-click - small solid amber
        // flags, distinct from both the live cyan cursor target above and
        // the final amber committed-route overlay, so they read as "already
        // locked in" way-points rather than the thing currently under the
        // pointer.
        if (manualRoutePreview.waypoints && manualRoutePreview.waypoints.length) {
            for (let wpt of manualRoutePreview.waypoints) {
                ctx.save();
                ctx.beginPath();
                ctx.arc(wpt.x, wpt.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = '#fbbf24';
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    // 5d. Adjust-route drag preview - while armed, shows the alternate path
    // the train would take by bending through wherever the pointer is right
    // now, on its way to the SAME final target it already had. Violet
    // styling keeps it visually distinct from both the cyan pick-preview
    // (5c) and the amber committed-route overlay (5b).
    if (adjustRouteArmedTrainId && adjustRoutePreview) {
        let pts = adjustRoutePreview.points;
        if (adjustRoutePreview.valid && pts.length >= 2) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);

            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 8;
            ctx.stroke();

            ctx.shadowColor = '#a78bfa';
            ctx.shadowBlur = 14 * glowZoom;
            ctx.strokeStyle = 'rgba(167,139,250,0.6)';
            ctx.lineWidth = 6;
            ctx.setLineDash([12, 10]);
            ctx.lineDashOffset = -((nowMs / 1000) * 70 * glowZoom) % 22;
            ctx.stroke();

            ctx.shadowBlur = 8 * glowZoom;
            ctx.strokeStyle = '#ede9fe';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        }

        if (adjustRoutePreview.target) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(adjustRoutePreview.target.x, adjustRoutePreview.target.y, 8, 0, Math.PI * 2);
            ctx.strokeStyle = adjustRoutePreview.valid ? '#a78bfa' : '#ef4444';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(adjustRoutePreview.target.x, adjustRoutePreview.target.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = adjustRoutePreview.valid ? '#a78bfa' : '#ef4444';
            ctx.fill();
            ctx.restore();
        }
    }

    // 6. Trains
    for (let train of trains) {
        drawTrain(train);
    }

    // 7. Freeform labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let l of state.labels) {
        let bgVisible = l.bgVisible !== false;
        let fontSize = l.fontSize || 14;
        ctx.font = fontSize + 'px sans-serif';
        let w = ctx.measureText(l.text).width + 10;
        let h = fontSize + 6;
        if (bgVisible) {
            ctx.fillStyle = 'rgba(244,244,245,0.9)';
            ctx.fillRect(l.x - w / 2, l.y - h / 2, w, h);
            ctx.fillStyle = '#18181b';
        } else {
            ctx.fillStyle = '#e4e4e7';
        }
        ctx.fillText(l.text, l.x, l.y);
    }

    // 8. Multiplayer: other players' cursors (drawn last so they float
    // above everything else). Positions arrive in world coords via the
    // network layer, so they draw correctly here even though each client
    // may be panned/zoomed completely differently from one another.
    if (typeof MP !== 'undefined' && MP.active) drawRemoteCursors();

    ctx.restore();
    camera = realCamera;
}

// Multiplayer: draws every other connected player's cursor as a small
// colored pointer + username tag, positioned in world coordinates so it
// lines up correctly under camera panning/zoom identically to everything
// else on the map - even though each viewer's own camera may differ.
// Called from inside draw() while the camera transform is still active.
function drawRemoteCursors() {
    let list = MP.remoteCursors;
    if (!list || list.length === 0) return;
    let scale = Math.max(0.6, Math.min(2.4, 1 / camera.zoom));
    for (let c of list) {
        if (c.peerId === MP.selfId) continue; // never draw your own cursor
        if (typeof c.x !== 'number' || typeof c.y !== 'number') continue;

        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(scale, scale);

        let color = mpColorForPeer(c.peerId);

        // Pointer arrow (a simple angular cursor shape, tip at the origin).
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 16);
        ctx.lineTo(4, 12.5);
        ctx.lineTo(6.8, 18.5);
        ctx.lineTo(9.2, 17.3);
        ctx.lineTo(6.6, 11.2);
        ctx.lineTo(12, 11);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.stroke();

        // Username tag.
        ctx.font = '600 11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let label = c.username || 'Player';
        let padX = 5;
        let textW = ctx.measureText(label).width;
        let boxX = 13, boxY = 14, boxH = 16;
        ctx.fillStyle = color;
        ctx.fillRect(boxX, boxY, textW + padX * 2, boxH);
        ctx.fillStyle = '#0b0b0d';
        ctx.fillText(label, boxX + padX, boxY + 3);

        ctx.restore();
    }
}

function drawTrain(train) {
    if (!train._occ || train._occ.length === 0) return;
    let isSelected = train.id === selectedTrainId;

    // Build ONE continuous polyline for the whole train body, tail to head,
    // even though it may be made up of several occupied track segments
    // (spanning a junction, a curve, etc). Stroking it as a single path -
    // rather than one stroke per segment - means there's no seam where
    // segments meet: the outline reads as one consistent train instead of
    // looking thicker/uneven at each joint, and butt (flat) caps only apply
    // at the true head and tail ends, not at every internal segment
    // boundary.
    let pts = [];
    for (let idx = train._occ.length - 1; idx >= 0; idx--) {
        let seg = train._occ[idx];
        let t = getTrack(seg.trackId);
        if (!t) continue;
        let a = pointAtMeters(t, seg.startM);
        let b = pointAtMeters(t, seg.endM);
        if (!a || !b) continue;
        let tailPt = seg.forward ? a : b;
        let headPt = seg.forward ? b : a;
        if (pts.length === 0) pts.push(tailPt);
        pts.push(headPt);
    }
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.lineWidth = isSelected ? TRAIN_OUTLINE_WIDTH_SELECTED : TRAIN_OUTLINE_WIDTH;
    ctx.strokeStyle = isSelected ? '#60a5fa' : '#000000';
    ctx.globalAlpha = isSelected ? 1 : 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // A gentle glow in the train's own line color, so each train reads as a
    // small light on the track rather than a flat stroke. Kept subtle
    // (small blur radius) so it doesn't overpower the pathfinding overlay
    // or make dense junctions look noisy.
    let bodyColor = (train.emergencyBrake || train.autoEmergencyBrake) ? '#ef4444' : (train.color || NO_LINE_TRAIN_COLOR);
    // Glow size scales directly with zoom - shadowBlur is defined in device
    // pixels regardless of the canvas' current scale transform, so without
    // this a train's glow would stay a fixed size on screen no matter how
    // far zoomed in. Clamped to keep it sane at extreme zoom levels.
    let trainGlowZoom = Math.max(0.5, Math.min(4, camera.zoom));
    ctx.shadowColor = bodyColor;
    ctx.shadowBlur = (isSelected ? 10 : 7) * trainGlowZoom;
    ctx.lineWidth = isSelected ? TRAIN_LINE_WIDTH_SELECTED : TRAIN_LINE_WIDTH;
    ctx.strokeStyle = bodyColor;
    ctx.stroke();
    // A second pass deepens the glow without over-brightening the core line
    // itself (shadowBlur stacks visually more than the core stroke alpha).
    ctx.shadowBlur = (isSelected ? 16 : 12) * trainGlowZoom;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Head marker + label (no background, per spec). The head is capped
    // with a white nose triangle (drawn below) rather than a floating
    // arrow icon, so the facing/heading reads as part of the train's own
    // shape at a glance.
    let headTrack = getTrack(train.headTrackId);
    if (!headTrack) return;
    let headPt = pointAtMeters(headTrack, train.headDist);
    if (!headPt) return;

    let dirFromPt = pts.length >= 2 ? pts[pts.length - 2] : null;
    let hdx = headPt.x - (dirFromPt ? dirFromPt.x : headPt.x - 1);
    let hdy = headPt.y - (dirFromPt ? dirFromPt.y : headPt.y);
    let hlen = Math.hypot(hdx, hdy) || 1;
    hdx /= hlen; hdy /= hlen;
    let headAngle = Math.atan2(hdy, hdx);

    // Head "nose" - a solid white triangle flush with the body's own width,
    // reading as the train's actual pointed front end rather than a
    // separate floating directional arrow icon.
    ctx.save();
    ctx.translate(headPt.x, headPt.y);
    ctx.rotate(headAngle);
    let noseHalfW = (isSelected ? TRAIN_LINE_WIDTH_SELECTED : TRAIN_LINE_WIDTH) / 2;
    let noseLen = noseHalfW * 2.4;
    ctx.beginPath();
    ctx.moveTo(noseLen, 0);
    ctx.lineTo(-1, noseHalfW);
    ctx.lineTo(-1, -noseHalfW);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Passenger/capacity occupancy bar - a small fill gauge hovering just
    // above the train, always drawn (not only when selected/hovered) so
    // crowding is visible across the whole map at a glance. Scales inversely
    // with zoom like the text labels, so it stays a legible, constant size
    // on screen rather than shrinking away when zoomed out.
    {
        let barScale = Math.max(0.6, Math.min(2.2, 1 / camera.zoom));
        let barW = 34 * barScale, barH = 5 * barScale;
        let bx = headPt.x - barW / 2;
        let by = headPt.y - 32 * barScale;
        let cap = train.capacity > 0 ? train.capacity : DEFAULT_TRAIN_CAPACITY;
        let frac = Math.max(0, Math.min(1, train.passengerCount / cap));
        let fillColor = frac >= 0.9 ? '#ef4444' : (frac >= 0.65 ? '#f59e0b' : '#4ade80');
        ctx.save();
        drawRoundedRect(ctx, bx, by, barW, barH, barH / 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        if (frac > 0) {
            let fillW = Math.max(barH, barW * frac);
            drawRoundedRect(ctx, bx, by, fillW, barH, barH / 2);
            ctx.fillStyle = fillColor;
            ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, bx, by, barW, barH, barH / 2);
        ctx.stroke();
        ctx.restore();
    }

    // Active speed-limit ("temporary speed restriction") sign - drawn like a
    // real lineside speed sign (white disc, red ring, black number) right
    // next to the head, so a capped train is obviously flagged at a glance
    // instead of the limit being buried in the side panel text. Combines the
    // player-set speed cap with the post-reversal penalty cap, whichever is
    // lower, since either (or both) can be active at once.
    let displayCapKmh = train.speedCapKmh;
    if (train.reversePenaltyActive) {
        displayCapKmh = (displayCapKmh != null) ? Math.min(displayCapKmh, REVERSE_PENALTY_SPEED_KMH) : REVERSE_PENALTY_SPEED_KMH;
    }
    if (displayCapKmh != null) {
        let signScale = Math.max(0.7, Math.min(1.8, 1 / camera.zoom));
        let signR = 11 * signScale;
        let sx = headPt.x + hdy * (18 * signScale);
        let sy = headPt.y - hdx * (18 * signScale);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.beginPath();
        ctx.arc(0, 0, signR, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = signR * 0.28;
        ctx.strokeStyle = '#dc2626';
        ctx.stroke();
        ctx.fillStyle = '#111111';
        ctx.font = 'bold ' + Math.round(signR * 0.95) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.round(displayCapKmh)), 0, signR * 0.05);
        ctx.restore();
    }

    ctx.save();
    let labelScale = Math.max(0.6, Math.min(2.4, 1 / camera.zoom));
    ctx.font = (12 * labelScale) + 'px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    let prefix = train.label + ' \u00B7 ' + nextStationLabel(train) + ' \u00B7 ';
    let speedText = formatSpeedLabel(train);
    let totalWidth = ctx.measureText(prefix + speedText).width;
    let startX = headPt.x - totalWidth / 2;
    let ly = headPt.y - 10 * labelScale;
    ctx.fillStyle = '#f4f4f5';
    ctx.fillText(prefix, startX, ly);
    // While the emergency brake is on (manual or signal-triggered), the
    // speed portion of the label blinks red so it's obvious at a glance
    // from anywhere on the map, not just from the selected train's panel.
    let eb = train.emergencyBrake || train.autoEmergencyBrake;
    let blinkOn = !eb || Math.floor(performance.now() / 500) % 2 === 0;
    ctx.fillStyle = (eb && blinkOn) ? '#ef4444' : '#f4f4f5';
    ctx.fillText(speedText, startX + ctx.measureText(prefix).width, ly);
    ctx.restore();

    // Alight/board counter - shown only while actually dwelling at a stop,
    // so it's clear at a glance how many people just got off vs on, right
    // where and when it happened, instead of having to open the train panel
    // and infer it from the passenger count changing.
    if (train.dwellUntil != null && (train.lastAlighted || train.lastBoarded)) {
        ctx.save();
        let cScale = Math.max(0.6, Math.min(2.4, 1 / camera.zoom));
        ctx.font = 'bold ' + (11 * cScale) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        let cy = headPt.y - (10 + 15 + 12) * labelScale;
        let parts = [];
        if (train.lastAlighted) parts.push({ text: '\u2212' + train.lastAlighted, color: '#f87171' });
        if (train.lastBoarded) parts.push({ text: '+' + train.lastBoarded, color: '#4ade80' });
        let gap = 10 * cScale;
        let widths = parts.map(p => ctx.measureText(p.text).width);
        let totalW = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
        let x = headPt.x - totalW / 2;
        for (let i = 0; i < parts.length; i++) {
            ctx.fillStyle = parts[i].color;
            ctx.textAlign = 'left';
            ctx.fillText(parts[i].text, x, cy);
            x += widths[i] + gap;
        }
        ctx.restore();
    }

    // Emergency-brake hold indicator - while the player is pressing and
    // holding this train, an "EB" badge fills in clockwise over the hold
    // duration, so the impending emergency brake is visible before it
    // actually triggers (rather than the brake just snapping on with no
    // warning of how long the press needs to be).
    if (train.id === trainHoldTrainId) {
        let holdNowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let holdP = Math.max(0, Math.min(1, (holdNowMs - trainHoldStartMs) / TRAIN_EB_HOLD_MS));
        let ebScale = Math.max(0.8, Math.min(2, 1 / camera.zoom));
        let ebR = 15 * ebScale;
        ctx.save();
        ctx.translate(headPt.x, headPt.y);
        ctx.beginPath();
        ctx.arc(0, 0, ebR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        if (holdP > 0) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, ebR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * holdP);
            ctx.closePath();
            ctx.fillStyle = trainHoldTriggered ? '#ef4444' : '#f87171';
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(0, 0, ebR, 0, Math.PI * 2);
        ctx.strokeStyle = '#f4f4f5';
        ctx.lineWidth = Math.max(1.5, ebR * 0.09);
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold ' + Math.round(ebR * 0.85) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('EB', 0, ebR * 0.05);
        ctx.restore();
    }
}

// --- Camera: fit the whole diagram in view ---

function fitCameraToDiagram() {
    if (state.points.length === 0) {
        camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
        return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let p of state.points) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let pad = 100;
    let w = Math.max(1, maxX - minX + pad * 2);
    let h = Math.max(1, maxY - minY + pad * 2);
    let zoom = Math.min(window.innerWidth / w, window.innerHeight / h, 2);
    let cx = (minX + maxX) / 2;
    let cy = (minY + maxY) / 2;
    camera.zoom = zoom;
    camera.x = window.innerWidth / 2 - cx * zoom;
    camera.y = window.innerHeight / 2 - cy * zoom;
}

function zoomBy(factor, aroundScreenX, aroundScreenY) {
    let sx = aroundScreenX != null ? aroundScreenX : window.innerWidth / 2;
    let sy = aroundScreenY != null ? aroundScreenY : window.innerHeight / 2;
    let wPos = screenToWorld(sx, sy);
    let newZoom = camera.zoom * factor;
    camera.x = sx - wPos.x * newZoom;
    camera.y = sy - wPos.y * newZoom;
    camera.zoom = newZoom;
    draw();
}

// ============================================================
// --- Hit testing: trains + depot tracks ---
// ============================================================

function hitTestTrain(wx, wy) {
    let best = null, bestDist = Infinity;
    for (let train of trains) {
        if (!train._occ) continue;
        for (let seg of train._occ) {
            let t = getTrack(seg.trackId);
            if (!t) continue;
            let a = pointAtMeters(t, seg.startM);
            let b = pointAtMeters(t, seg.endM);
            if (!a || !b) continue;
            let d = distToSegment(wx, wy, a.x, a.y, b.x, b.y);
            if (d < TRAIN_HIT_PADDING && d < bestDist) { bestDist = d; best = train; }
        }
    }
    return best;
}

function distToSegment(px, py, ax, ay, bx, by) {
    let dx = bx - ax, dy = by - ay;
    let lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
    let cx = ax + dx * t, cy = ay + dy * t;
    return Math.hypot(px - cx, py - cy);
}

function hitTestDepotTrack(wx, wy) {
    let hit = getNearestTrackPoint(wx, wy, t => !!t.isDepot);
    if (hit && hit.dist < DEPOT_HIT_PADDING) return hit.track;
    return null;
}

function trainOnTrack(trackId) {
    return trains.find(tr => tr._occ && tr._occ.some(s => s.trackId === trackId));
}

// ============================================================
// --- Pointer interaction: pan, signal toggle, trains, depots, manual route ---
// ============================================================

let hoverSignal = null;
let hoverTrainId = null;

canvas.addEventListener('pointerdown', (e) => {
    if (gameOver) return;
    // The right mouse button is handled entirely by the 'contextmenu'
    // listener below (context menu, or dropping a manual-route mid-point) -
    // letting it also fall through into the normal left-click/drag pipeline
    // here would fire a spurious click/adjust-drag on release right after
    // the contextmenu handler runs.
    if (e.button === 2) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wPos = screenToWorld(sx, sy);

    // Adjust-route mode takes the pointer over entirely for a press-drag-
    // release gesture - it never pans the camera or selects anything else
    // while armed, since the whole point is to bend the armed train's route
    // through wherever the pointer ends up.
    if (adjustRouteArmedTrainId) {
        adjustRouteDragging = true;
        adjustDragPointerId = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
        updateAdjustRoutePreview(wPos.x, wPos.y);
        draw();
        return;
    }

    // Shift+drag straight on a train is a shortcut into adjust-route mode -
    // arms it and starts the bend-drag in this same gesture, so the player
    // doesn't have to select the train and press "Adjust route" first.
    if (e.shiftKey && !manualRouteArmedTrainId) {
        let shiftHitTrain = hitTestTrain(wPos.x, wPos.y);
        if (shiftHitTrain) {
            if (shiftHitTrain.targetTrackId == null) {
                showToast(shiftHitTrain.label + ' has no active route to adjust.');
                return;
            }
            armAdjustRoute(shiftHitTrain);
            adjustRouteDragging = true;
            adjustDragPointerId = e.pointerId;
            canvas.setPointerCapture(e.pointerId);
            setHint('Drag to bend ' + shiftHitTrain.label + '\u2019s route \u00B7 release to confirm');
            updateAdjustRoutePreview(wPos.x, wPos.y);
            draw();
            return;
        }
    }

    pointerDownScreen = { x: sx, y: sy };
    pointerDownSignal = hitTestSignal(wPos.x, wPos.y);
    pointerDownTrain = pointerDownSignal ? null : hitTestTrain(wPos.x, wPos.y);
    pointerDownDepotTrack = (pointerDownSignal || pointerDownTrain) ? null : hitTestDepotTrack(wPos.x, wPos.y);

    if (pointerDownTrain) {
        trainHoldTrainId = pointerDownTrain.id;
        trainHoldStartMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        trainHoldTriggered = false;
    } else {
        trainHoldTrainId = null;
        trainHoldStartMs = null;
        trainHoldTriggered = false;
    }

    isPanning = true;
    panPointerId = e.pointerId;
    panStart = { x: sx, y: sy };
    canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    mpCursorWorld = screenToWorld(sx, sy); // multiplayer: track for cursor broadcast

    // Adjust-route drag in progress: recompute the bent-route preview under
    // the pointer every move, same idea as the manual-route pick preview
    // below but targeting the train's EXISTING destination instead of a new
    // one.
    if (adjustRouteDragging && e.pointerId === adjustDragPointerId) {
        const wPos = screenToWorld(sx, sy);
        updateAdjustRoutePreview(wPos.x, wPos.y);
        draw();
        return;
    }

    // A real drag/pan cancels an in-progress emergency-brake hold - holding
    // still is part of the gesture, panning the view is a different intent.
    if (trainHoldTrainId != null) {
        let heldMoveDist = Math.hypot(sx - pointerDownScreen.x, sy - pointerDownScreen.y);
        if (heldMoveDist >= CLICK_DRAG_THRESHOLD) {
            trainHoldTrainId = null;
            trainHoldStartMs = null;
            trainHoldTriggered = false;
        }
    }

    if (isPanning && e.pointerId === panPointerId) {
        camera.x += (sx - panStart.x);
        camera.y += (sy - panStart.y);
        panStart = { x: sx, y: sy };
        draw();
        return;
    }

    const wPos = screenToWorld(sx, sy);
    let hit = hitTestSignal(wPos.x, wPos.y);
    let trainHit = hit ? null : hitTestTrain(wPos.x, wPos.y);
    let trainHitId = trainHit ? trainHit.id : null;
    let changed = false;
    if (hit !== hoverSignal) { hoverSignal = hit; changed = true; }
    if (trainHitId !== hoverTrainId) { hoverTrainId = trainHitId; changed = true; }

    // Manual-route picking mode: recompute the live path preview under the
    // cursor on every move (not just when the hovered signal/train
    // changes), since the preview target slides continuously along
    // whatever track is nearest the pointer.
    if (manualRouteArmedTrainId) {
        updateManualRoutePreview(wPos.x, wPos.y);
        changed = true;
    }

    if (changed) {
        let shiftAdjustHover = e.shiftKey && trainHit && trainHit.targetTrackId != null;
        canvas.style.cursor = hit ? 'pointer' : ((manualRouteArmedTrainId || adjustRouteArmedTrainId || shiftAdjustHover) ? 'crosshair' : (trainHit ? 'pointer' : 'grab'));
        draw();
    }
});

function endPan(e) {
    if (!isPanning || e.pointerId !== panPointerId) return;
    isPanning = false;
    panPointerId = null;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const movedDist = Math.hypot(sx - pointerDownScreen.x, sy - pointerDownScreen.y);

    // A completed emergency-brake hold consumes the release - it shouldn't
    // also fire the normal tap action (select/despawn) on the same train.
    if (movedDist < CLICK_DRAG_THRESHOLD && !trainHoldTriggered) {
        handleCanvasClick(sx, sy, e.clientX, e.clientY);
    }
    pointerDownSignal = null;
    pointerDownTrain = null;
    pointerDownDepotTrack = null;
    trainHoldTrainId = null;
    trainHoldStartMs = null;
    trainHoldTriggered = false;
}

function handleCanvasClick(sx, sy, clientX, clientY) {
    const wPos = screenToWorld(sx, sy);

    if (pointerDownSignal) { toggleSignal(pointerDownSignal); return; }

    // Manual-route picking mode takes priority over everything else. A
    // left-click here always FINALIZES the route (through any mid-points
    // already dropped with right-click - see the contextmenu handler below).
    if (manualRouteArmedTrainId) {
        let train = trains.find(t => t.id === manualRouteArmedTrainId);
        let waypoints = manualRouteWaypoints;
        manualRouteArmedTrainId = null;
        manualRoutePreview = null;
        manualRouteWaypoints = [];
        setHint(defaultHint());
        if (!train) { draw(); return; }
        let hit = getNearestTrackPoint(wPos.x, wPos.y, null);
        if (hit && hit.dist < 40) {
            setManualTarget(train, hit.track.id, pxToMeters(hit.track, hit.t_px), waypoints);
        } else {
            showToast('No track near that point - route cancelled.');
        }
        draw();
        return;
    }

    if (pointerDownTrain) {
        let train = pointerDownTrain;
        if (train.homeDepotTrackId && isTrainFullyInHomeDepot(train)) {
            despawnTrain(train);
        } else {
            selectTrain(train.id);
        }
        return;
    }

    if (pointerDownDepotTrack) {
        let occupant = trainOnTrack(pointerDownDepotTrack.id);
        if (occupant) {
            selectTrain(occupant.id);
        } else {
            openDepotMenu(pointerDownDepotTrack, clientX, clientY);
        }
        return;
    }

    // Clicked empty space - deselect.
    closeTrainPanel();
}

// Finishes an adjust-route drag: solves the bent path one last time at the
// release point and, if legal, commits it via applyRouteAdjustment (leaving
// the train's target/mode/line untouched - only its route bends).
function finishAdjustRouteDrag() {
    let train = trains.find(t => t.id === adjustRouteArmedTrainId);
    let preview = adjustRoutePreview;
    adjustRouteArmedTrainId = null;
    adjustRouteDragging = false;
    adjustDragPointerId = null;
    adjustRoutePreview = null;
    setHint(defaultHint());
    canvas.style.cursor = 'grab';
    if (!train) { draw(); return; }
    if (!preview || !preview.valid || preview.waypointTrackId == null) {
        showToast('Route adjustment cancelled.');
        draw();
        return;
    }
    applyRouteAdjustment(train, preview.waypointTrackId, preview.waypointDist);
    if (selectedTrainId === train.id) updateTrainPanel();
    draw();
}

function handlePointerUp(e) {
    if (adjustRouteDragging && e.pointerId === adjustDragPointerId) {
        finishAdjustRouteDrag();
        return;
    }
    endPan(e);
}

canvas.addEventListener('pointerup', handlePointerUp);
canvas.addEventListener('pointercancel', handlePointerUp);
canvas.addEventListener('pointerleave', () => {
    mpCursorWorld = null; // multiplayer: stop broadcasting a stale position
    if (isPanning) return;
    if (hoverSignal || hoverTrainId || (manualRouteArmedTrainId && manualRoutePreview)) {
        hoverSignal = null;
        hoverTrainId = null;
        if (manualRouteArmedTrainId) manualRoutePreview = null;
        draw();
    }
});

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    let factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomBy(factor, sx, sy);
}, { passive: false });

canvas.style.cursor = 'grab';

// Right-click opens the train context menu when over a train; otherwise it's
// suppressed everywhere (native menu would interrupt the app) - EXCEPT while
// a manual route is armed, where right-click instead drops a mid-point
// waypoint at the cursor (see armManualRoute). Left-click still finalizes
// the route through whatever mid-points were dropped this way.
document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (gameOver) return;
    if (e.target !== canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wPos = screenToWorld(sx, sy);

    if (manualRouteArmedTrainId) {
        let train = trains.find(t => t.id === manualRouteArmedTrainId);
        if (!train) {
            manualRouteArmedTrainId = null;
            manualRoutePreview = null;
            manualRouteWaypoints = [];
            setHint(defaultHint());
            return;
        }
        let hit = getNearestTrackPoint(wPos.x, wPos.y, null);
        if (!hit || hit.dist >= 40) { showToast('No track near that point.'); return; }
        let distM = pxToMeters(hit.track, hit.t_px);
        // Validate the FULL chain (existing mid-points + this new one) is
        // still reachable before locking it in, so a wildly unreachable
        // right-click can't strand the player mid-route with no way to
        // finish it.
        let testChain = manualRouteWaypoints.concat([{ trackId: hit.track.id, dist: distM }]);
        if (!computeChainedRoute(train, testChain)) { showToast('No legal path through that point.'); return; }
        manualRouteWaypoints.push({ trackId: hit.track.id, dist: distM });
        setHint('Right-click to add another mid-point, left-click ' + train.label + '\u2019s final stop \u00B7 click here to cancel');
        updateManualRoutePreview(wPos.x, wPos.y);
        draw();
        return;
    }

    // Adjust-route mode is drag-only (left mouse button) - suppress the
    // native/train context menu here too rather than letting it pop up
    // mid-gesture.
    if (adjustRouteArmedTrainId) return;

    let train = hitTestTrain(wPos.x, wPos.y);
    if (train) {
        selectTrain(train.id);
        openContextMenu(train, e.clientX, e.clientY);
    }
});

// ============================================================
// --- Simulation clock + main loop ---
// ============================================================

function formatClock(totalSeconds) {
    let wrapped = ((totalSeconds % 86400) + 86400) % 86400;
    let h = Math.floor(wrapped / 3600);
    let m = Math.floor((wrapped % 3600) / 60);
    let s = Math.floor(wrapped % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateClockDisplay() {
    document.getElementById('clock-display').textContent = formatClock(simTimeSeconds);
}

function setPaused(paused) {
    simPaused = paused;
    document.getElementById('btn-pause').innerHTML = simPaused ? '&#9654;' : '&#10074;&#10074;';
}

function simTick(now) {
    if (lastFrameTime == null) lastFrameTime = now;
    let dtSeconds = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    dtSeconds = Math.min(dtSeconds, 0.25);

    // Multiplayer client: the host is the only machine that runs physics.
    // We just keep pinging the host and render whatever state snapshot it
    // last sent us (applied directly to `trains`/`state.signals` as it
    // arrives - see MP.applySnapshot in net.js), so there's nothing to
    // step here.
    if (window.MP && MP.active && !MP.isHost) {
        MP.clientTick(now);
        if (selectedTrainId) updateTrainPanel();
        draw();
        requestAnimationFrame(simTick);
        return;
    }

    if (!simPaused && !gameOver) {
        let simDt = dtSeconds * simSpeed;
        simTimeSeconds += simDt;
        updateClockDisplay();

        // Dwell handling: depart any train whose dwell has elapsed.
        for (let train of trains) {
            if (train.dwellUntil != null && simTimeSeconds >= train.dwellUntil && !train.emergencyBrake) {
                train.dwellUntil = null;
                if (train.lineId) {
                    let line = getLine(train.lineId);
                    let atLastStop = line && Array.isArray(line.stops) && train.stopIndex === line.stops.length - 1;
                    if (atLastStop) {
                        // One-way line: reaching the last stop ends this
                        // train's assignment to the line rather than looping
                        // it back for another run on its own - a line
                        // terminates here, it doesn't automatically turn
                        // into a fresh non-revenue trip across the map back
                        // to stop 0 (that long, unattended repositioning
                        // move was also the easiest way to end up asking the
                        // pathfinder for an awkward route that doubled back
                        // on itself). The train just sits here, unassigned,
                        // until the player gives it a new line or routes it
                        // manually.
                        let lineName = line.name;
                        assignLineToTrain(train, null);
                        showToast(train.label + ' reached the end of ' + lineName + ' and is now unassigned.');
                    } else {
                        advanceToNextLineStop(train);
                    }
                } else {
                    train.mode = 'idle';
                }
            }
        }

        // Run physics in small fixed-size substeps rather than one big step
        // per frame. At high sim-speed multipliers (up to 60x) a single
        // frame's simDt can be ~1 simulated second - during which a train
        // can cover 20+ meters using braking distances that were only
        // recalculated at the *start* of that huge step. That stale-data gap
        // is exactly what let trains blow through red signals or arrive too
        // late to brake. Capping each integration step to PHYSICS_SUBSTEP_S
        // keeps the braking-constraint math accurate regardless of game speed.
        let stepsNeeded = Math.max(1, Math.ceil(simDt / PHYSICS_SUBSTEP_S));
        let subDt = simDt / stepsNeeded;
        for (let i = 0; i < stepsNeeded; i++) {
            for (let train of trains) stepTrainPhysics(train, subDt);
        }
        for (let train of trains) { train._occ = getOccupiedEdges(train); }
        for (let train of trains) trimTrainHistory(train);

        simulatePassengers(simDt);

        if (checkCollisions()) {
            if (window.MP && MP.active && MP.isHost) MP.hostTick(now);
            draw();
            requestAnimationFrame(simTick);
            return;
        }

        if (selectedTrainId) updateTrainPanel();
    } else {
        // Paused / game over: geometry can still change from manual actions
        // (reverse, despawn, a fresh spawn) - keep it fresh for rendering
        // and hit-testing even while the clock isn't advancing.
        for (let train of trains) { train._occ = getOccupiedEdges(train); }
    }

    if (window.MP && MP.active && MP.isHost) MP.hostTick(now);

    draw();
    requestAnimationFrame(simTick);
}

document.getElementById('btn-pause').addEventListener('click', () => {
    if (window.MP && MP.active && !MP.isHost) {
        MP.sendInput({ type: 'SET_PAUSED', value: !simPaused });
        return;
    }
    setPaused(!simPaused);
});

const speedSlider = document.getElementById('speed-slider');
const speedLabel = document.getElementById('speed-label');

// Shared entry point for every way time warp can be changed (slider, +/-
// buttons, or a network SET_TIME_WARP request already validated by the
// host). In multiplayer this is the ONE place that decides whether a
// change is allowed to happen locally or has to be asked of the host.
function requestTimeWarp(newValue) {
    newValue = Math.max(1, Math.min(60, Math.round(newValue)));
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('timeWarp')) {
            showToast("You don't have permission to change time warp.");
            speedSlider.value = simSpeed;
            speedLabel.textContent = simSpeed + 'x';
            return;
        }
        let cap = MP.myTimeWarpCap();
        if (cap != null) newValue = Math.min(newValue, cap);
        speedSlider.value = newValue; // optimistic UI; host confirms via TIME_WARP_UPDATE
        speedLabel.textContent = newValue + 'x';
        MP.sendInput({ type: 'SET_TIME_WARP', value: newValue });
        return;
    }
    applyTimeWarpLocal(newValue);
}

// Actually mutates simSpeed. Only ever called on the host or in
// singleplayer - never directly by a non-host client (see above).
function applyTimeWarpLocal(newValue) {
    simSpeed = Math.max(1, Math.min(60, Math.round(newValue)));
    speedSlider.value = simSpeed;
    speedLabel.textContent = simSpeed + 'x';
    if (window.MP && MP.active && MP.isHost) MP.broadcastTimeWarp(simSpeed);
}

speedSlider.addEventListener('input', () => requestTimeWarp(parseInt(speedSlider.value, 10)));

const warpMinusBtn = document.getElementById('warp-minus');
const warpPlusBtn = document.getElementById('warp-plus');
if (warpMinusBtn) warpMinusBtn.addEventListener('click', () => requestTimeWarp(simSpeed - 1));
if (warpPlusBtn) warpPlusBtn.addEventListener('click', () => requestTimeWarp(simSpeed + 1));

updateClockDisplay();
setPaused(true);
requestAnimationFrame(simTick);

document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.2));
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
document.getElementById('zoom-fit').addEventListener('click', () => { fitCameraToDiagram(); draw(); });

// ============================================================
// --- Toasts / hint ---
// ============================================================

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.innerHTML = linkify(msg);
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 5000);
}

// Escapes msg for safe HTML insertion, then turns any http(s):// URL into
// a clickable link (opened in a new tab) so things like the relay's
// certificate-warning link in WAN toasts can be tapped directly.
function linkify(msg) {
    const escaped = String(msg).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    return escaped.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) =>
        '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
}

function defaultHint() {
    return 'Drag to pan \u00B7 Scroll to zoom \u00B7 Click a depot track, then Spawn train \u00B7 Right-click a train for actions \u00B7 Shift+drag a train to bend its route';
}
function setHint(text) {
    const hint = document.getElementById('hint');
    hint.textContent = text;
    hint.classList.toggle('manual-mode', !!manualRouteArmedTrainId || !!adjustRouteArmedTrainId);
}

// The hint bar becomes clickable (see .hint.manual-mode's pointer-events)
// while either a manual route or a route adjustment is armed, so the player
// always has an obvious, explicit way to back out of the mode instead of
// having to remember that clicking empty canvas also cancels it.
document.getElementById('hint').addEventListener('click', () => {
    if (manualRouteArmedTrainId) {
        manualRouteArmedTrainId = null;
        manualRoutePreview = null;
        manualRouteWaypoints = [];
        setHint(defaultHint());
        canvas.style.cursor = 'grab';
        draw();
    } else if (adjustRouteArmedTrainId) {
        adjustRouteArmedTrainId = null;
        adjustRoutePreview = null;
        adjustRouteDragging = false;
        adjustDragPointerId = null;
        setHint(defaultHint());
        canvas.style.cursor = 'grab';
        draw();
    }
});

function setEmptyStateVisible(visible) {
    document.getElementById('empty-state').style.display = visible ? 'flex' : 'none';
}

// ============================================================
// --- Train detail panel (right side) ---
// ============================================================

function selectTrain(id) {
    selectedTrainId = id;
    document.getElementById('train-panel').classList.add('open');
    closeLineDropdown();
    updateTrainPanel();
    draw();
}

function closeTrainPanel() {
    selectedTrainId = null;
    document.getElementById('train-panel').classList.remove('open');
    closeLineDropdown();
    draw();
}

// --- Custom line-assignment dropdown -----------------------------------
// A plain <select>'s native option list is rendered by the OS/browser
// chrome, so there's no reliable way to get hover events on individual
// options in order to drive the path-preview overlay below. This is a
// minimal div-based stand-in: a button showing the current line, and an
// absolutely-positioned option list that behaves like a dropdown but is
// just ordinary DOM Claude can attach mouseenter/mouseleave to.
let lineDropdownOpen = false;
let lineHoverPreviewId = undefined; // undefined = nothing hovered; '' = "(no line)" hovered; else a line id

function closeLineDropdown() {
    lineDropdownOpen = false;
    lineHoverPreviewId = undefined;
    let menu = document.getElementById('tp-line-select-menu');
    if (menu) menu.classList.remove('open');
}

function setLineHoverPreview(lineId) {
    if (lineHoverPreviewId === lineId) return;
    lineHoverPreviewId = lineId;
    draw();
}

function populateLineSelect(wrapperEl, train) {
    let btnLabel = document.getElementById('tp-line-select-label');
    let menu = document.getElementById('tp-line-select-menu');
    let currentLine = train.lineId ? getLine(train.lineId) : null;
    btnLabel.textContent = currentLine ? (currentLine.name || '(unnamed line)') : '(no line - manual only)';

    menu.innerHTML = '';

    let makeOption = (lineId, label) => {
        let opt = document.createElement('div');
        opt.className = 'line-dropdown-option' + (train.lineId === (lineId || null) ? ' selected' : '');
        opt.textContent = label;
        opt.addEventListener('mouseenter', () => setLineHoverPreview(lineId));
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            closeLineDropdown();
            assignLineToTrain(train, lineId || null);
            updateTrainPanel();
            draw();
        });
        return opt;
    };

    menu.appendChild(makeOption('', '(no line - manual only)'));
    for (let line of state.lines) {
        menu.appendChild(makeOption(line.id, line.name || '(unnamed line)'));
    }
}

function updateTrainPanel() {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) { closeTrainPanel(); return; }

    document.getElementById('tp-title').textContent = train.label;
    document.getElementById('tp-sub').textContent = train.capacity + ' seat capacity \u00B7 ' + Math.round(train.length) + ' m long';

    let statusEl = document.getElementById('tp-status');
    statusEl.innerHTML = '';
    let pill = document.createElement('span');
    if (train.emergencyBrake) { pill.className = 'status-pill brake'; pill.textContent = 'Emergency brake'; }
    else if (train.autoEmergencyBrake) { pill.className = 'status-pill brake'; pill.textContent = 'Emergency brake (signal)'; }
    else if (train.dwellUntil != null) { pill.className = 'status-pill dwell'; pill.textContent = 'Dwelling'; }
    else if (train.mode === 'idle') { pill.className = 'status-pill'; pill.textContent = 'Idle'; }
    else { pill.className = 'status-pill ok'; pill.textContent = train.mode === 'manual' ? 'Manual route' : 'In service'; }
    statusEl.appendChild(pill);
    if (train.reversePenaltyActive) {
        let penaltyPill = document.createElement('span');
        penaltyPill.className = 'status-pill brake';
        penaltyPill.textContent = 'Reverse limited \u00B7 ' + REVERSE_PENALTY_SPEED_KMH + ' km/h';
        statusEl.appendChild(penaltyPill);
    }

    let speedEl = document.getElementById('tp-speed');
    let displayCapKmh = train.speedCapKmh;
    if (train.reversePenaltyActive) {
        displayCapKmh = (displayCapKmh != null) ? Math.min(displayCapKmh, REVERSE_PENALTY_SPEED_KMH) : REVERSE_PENALTY_SPEED_KMH;
    }
    speedEl.textContent = formatSpeedLabel(train) +
        (displayCapKmh != null ? (' (limit ' + displayCapKmh + ' km/h)') : '');
    speedEl.classList.toggle('speed-eb-flash', !!(train.emergencyBrake || train.autoEmergencyBrake));
    document.getElementById('tp-next').textContent = nextStationLabel(train);

    // Skip repopulating while the dropdown is open under the pointer -
    // rebuilding its DOM mid-hover would kill the mouseenter/mouseleave
    // state driving the path preview.
    if (!lineDropdownOpen) populateLineSelect(document.getElementById('tp-line-select'), train);

    // Platform choice at next stop, when that stop has more than one platform.
    let platSection = document.getElementById('tp-platform-section');
    let platSelect = document.getElementById('tp-platform-select');
    if (train.lineId && train.pendingStop && getStopPlatforms(train.pendingStop).length > 1) {
        platSection.style.display = '';
        if (document.activeElement !== platSelect) {
            platSelect.innerHTML = '';
            for (let p of getStopPlatforms(train.pendingStop)) {
                let opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = 'Platform ' + (p.number || p.code || p.id);
                if (train.pendingPlatformId === p.id) opt.selected = true;
                platSelect.appendChild(opt);
            }
        }
    } else {
        platSection.style.display = 'none';
    }

    let speedCapInput = document.getElementById('tp-speedcap');
    if (document.activeElement !== speedCapInput) {
        speedCapInput.value = train.speedCapKmh != null ? train.speedCapKmh : '';
    }

    document.getElementById('tp-pax-text').textContent = train.passengerCount + ' / ' + train.capacity;
    document.getElementById('tp-pax-fill').style.width = Math.min(100, (train.passengerCount / train.capacity) * 100) + '%';

    document.getElementById('tp-brake').textContent = train.emergencyBrake ? 'Release Brake' : 'Emergency Brake';
    document.getElementById('tp-reverse').disabled = train.speedMs > TRAIN_STOPPED_MS;
    document.getElementById('tp-adjust-route').disabled = (train.targetTrackId == null);
    document.getElementById('tp-despawn').style.display = isTrainFullyInHomeDepot(train) ? '' : 'none';
}

document.getElementById('tp-close').addEventListener('click', closeTrainPanel);

document.getElementById('tp-line-select-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    lineDropdownOpen = !lineDropdownOpen;
    if (!lineDropdownOpen) lineHoverPreviewId = undefined;
    document.getElementById('tp-line-select-menu').classList.toggle('open', lineDropdownOpen);
    if (lineHoverPreviewId === undefined) draw();
});

// Clears the hover preview (but leaves the dropdown open) once the pointer
// leaves the whole option list, rather than per-option on mouseleave -
// moving between adjacent rows would otherwise flicker the preview off and
// back on as the browser fires the old row's mouseleave after the new
// row's mouseenter.
document.getElementById('tp-line-select-menu').addEventListener('mouseleave', () => {
    setLineHoverPreview(undefined);
});

document.addEventListener('click', (e) => {
    if (!lineDropdownOpen) return;
    if (!document.getElementById('tp-line-select').contains(e.target)) closeLineDropdown();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lineDropdownOpen) closeLineDropdown();
});

function setTrainPlatform(train, platformId) {
    if (!train || !train.pendingStop) return;
    if (window.MP && MP.active && !MP.isHost) {
        if (!MP.can('lineAndSignalControl')) { showToast("You don't have permission to control trains."); return; }
        MP.sendInput({ type: 'SET_PLATFORM', trainId: train.id, platformId });
        return;
    }
    let oldPlatformId = train.pendingPlatformId;
    train.platformOverrides[train.pendingStop.id] = platformId;

    let plat = getPlatform(platformId);
    let track = plat && getTrack(plat.track_id);
    if (!plat || !track) { showToast('Invalid platform selection.'); return; }

    // Re-route right now, to the new platform, instead of only recording the
    // preference for the next time this stop comes around - otherwise the
    // train keeps heading for the old platform's track until it arrives.
    let route = computeTrainRoute(train, plat.track_id, pxToMeters(track, plat.t_dist));
    if (!route) {
        showToast('No route to that platform from here - will try again at the next stop.');
        return;
    }
    let arrivalForward = route.directOnCurrent ? train.headForward : route.edges[route.edges.length - 1].forward;
    train.route = route.edges;
    train.targetTrackId = plat.track_id;
    train.targetDist = platformStopDist(train, track, plat, arrivalForward);
    train.targetForward = arrivalForward;
    train.pendingPlatformId = plat.id;

    // Passengers already waiting on the platform this stop used to point at
    // move over to the one the train is actually calling at now - otherwise
    // a manual platform switch strands anyone who was waiting for this line
    // before the change, since this train will simply never show up where
    // they're standing anymore.
    let line = getLine(train.lineId);
    let oldPlat = getPlatform(oldPlatformId);
    if (line && oldPlat && oldPlat.id !== plat.id) {
        let oldWaiting = platformWaiting(oldPlat);
        let newWaiting = platformWaiting(plat);
        for (let destCode of Object.keys(oldWaiting)) {
            if (!lineServesDestination(line, destCode)) continue;
            newWaiting[destCode] = (newWaiting[destCode] || 0) + oldWaiting[destCode];
            delete oldWaiting[destCode];
        }
    }

    showToast('Platform changed - route updated.');
    draw();
}

document.getElementById('tp-platform-select').addEventListener('change', (e) => {
    let train = trains.find(t => t.id === selectedTrainId);
    setTrainPlatform(train, e.target.value);
    updateTrainPanel();
});

document.getElementById('tp-speedcap-apply').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    let raw = document.getElementById('tp-speedcap').value;
    // Accept a stray comma decimal or surrounding whitespace, since the
    // number input's raw string can carry either depending on locale/paste.
    let val = parseFloat(String(raw).trim().replace(',', '.'));
    if (raw.trim() === '' || isNaN(val)) {
        setTrainSpeedCap(train, null);
        showToast(train.label + ': speed cap cleared.');
    } else if (val < 0) {
        showToast('Speed cap must be zero or more.');
        return;
    } else {
        setTrainSpeedCap(train, val);
        showToast(train.label + ' speed capped at ' + val + ' km/h.');
    }
    updateTrainPanel();
});
document.getElementById('tp-speedcap-clear').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    document.getElementById('tp-speedcap').value = '';
    setTrainSpeedCap(train, null);
    updateTrainPanel();
});
// Pressing Enter in the field should apply it too, not just clicking the
// Set button - typing a value and hitting Enter is the natural way people
// try to use this, and it silently did nothing before.
document.getElementById('tp-speedcap').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    document.getElementById('tp-speedcap-apply').click();
});

document.getElementById('tp-brake').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    toggleEmergencyBrake(train);
    updateTrainPanel();
});
document.getElementById('tp-reverse').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    reverseTrain(train);
    updateTrainPanel();
});
document.getElementById('tp-manual-route').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    armManualRoute(train);
});
document.getElementById('tp-adjust-route').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    armAdjustRoute(train);
});
document.getElementById('tp-despawn').addEventListener('click', () => {
    let train = trains.find(t => t.id === selectedTrainId);
    if (!train) return;
    despawnTrain(train);
});

function armManualRoute(train) {
    manualRouteArmedTrainId = train.id;
    manualRoutePreview = null;
    manualRouteWaypoints = [];
    setHint('Left-click to route ' + train.label + ' there \u00B7 right-click first to add a mid-point \u00B7 click here to cancel');
    canvas.style.cursor = 'crosshair';
}

// Arms "Adjust Route": the next press-drag-release on the map bends the
// train's ALREADY-committed route (whatever it's currently doing - line
// service or a previous manual route) through wherever the drag ends up, on
// its way to the exact same final target. Requires the train to actually
// have an active target to bend around.
function armAdjustRoute(train) {
    if (train.targetTrackId == null) { showToast(train.label + ' has no active route to adjust.'); return; }
    adjustRouteArmedTrainId = train.id;
    adjustRoutePreview = null;
    adjustRouteDragging = false;
    adjustDragPointerId = null;
    setHint('Press and drag anywhere on the map to bend ' + train.label + '\u2019s route \u00B7 click here to cancel');
    canvas.style.cursor = 'crosshair';
}

// Recomputes the live "bent route" preview for an adjust-route drag in
// progress - mirrors updateManualRoutePreview, but chains through the
// train's EXISTING target instead of asking for a new one.
function updateAdjustRoutePreview(wx, wy) {
    let train = trains.find(t => t.id === adjustRouteArmedTrainId);
    if (!train || train.targetTrackId == null) { adjustRoutePreview = null; return; }

    let hit = getNearestTrackPoint(wx, wy, null);
    if (!hit || hit.dist >= 40) {
        adjustRoutePreview = { points: [], target: null, valid: false, waypointTrackId: null, waypointDist: null };
        return;
    }

    let distM = pxToMeters(hit.track, hit.t_px);
    let chained = computeChainedRoute(train, [
        { trackId: hit.track.id, dist: distM },
        { trackId: train.targetTrackId, dist: train.targetDist }
    ]);
    if (!chained) {
        adjustRoutePreview = { points: [], target: { x: hit.x, y: hit.y }, valid: false, waypointTrackId: null, waypointDist: null };
        return;
    }

    let virtualTrain = {
        headTrackId: train.headTrackId,
        headForward: train.headForward,
        headDist: train.headDist,
        route: chained.edges,
        targetTrackId: train.targetTrackId,
        targetDist: train.targetDist
    };
    adjustRoutePreview = {
        points: getTrainPathPoints(virtualTrain),
        target: { x: hit.x, y: hit.y },
        valid: true,
        waypointTrackId: hit.track.id,
        waypointDist: distM
    };
}

// ============================================================
// --- Depot spawn popup ---
// ============================================================
// Clicking an empty depot track only opens this small popup; the train
// isn't spawned until the player explicitly presses "Spawn train" in it.

const depotMenu = document.getElementById('depot-menu');
let depotMenuTrackId = null;

function openDepotMenu(track, clientX, clientY) {
    closeContextMenu();
    depotMenuTrackId = track.id;
    document.getElementById('depot-menu-title').textContent = track.depotName || 'Depot';

    depotMenu.classList.add('open');
    let x = clientX, y = clientY;
    requestAnimationFrame(() => {
        let rect = depotMenu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
        depotMenu.style.left = x + 'px';
        depotMenu.style.top = y + 'px';
    });
    depotMenu.style.left = x + 'px';
    depotMenu.style.top = y + 'px';
}

function closeDepotMenu() {
    depotMenu.classList.remove('open');
    depotMenuTrackId = null;
}

document.addEventListener('pointerdown', (e) => {
    if (depotMenu.classList.contains('open') && !depotMenu.contains(e.target)) closeDepotMenu();
});

document.getElementById('depot-spawn-btn').addEventListener('click', () => {
    let track = getTrack(depotMenuTrackId);
    closeDepotMenu();
    if (track) spawnTrainAt(track);
});

// ============================================================
// --- Right-click context menu ---
// ============================================================

const ctxMenu = document.getElementById('ctx-menu');
let ctxMenuTrainId = null;

function openContextMenu(train, clientX, clientY) {
    closeDepotMenu();
    ctxMenuTrainId = train.id;
    document.getElementById('ctx-title').textContent = train.label;
    document.getElementById('ctx-brake').textContent = train.emergencyBrake ? 'Release emergency brake' : 'Emergency brake';
    document.getElementById('ctx-reverse').disabled = train.speedMs > TRAIN_STOPPED_MS;
    document.getElementById('ctx-adjust-route').disabled = (train.targetTrackId == null);
    document.getElementById('ctx-despawn').style.display = isTrainFullyInHomeDepot(train) ? '' : 'none';

    ctxMenu.classList.add('open');
    let x = clientX, y = clientY;
    // Keep the menu on-screen.
    requestAnimationFrame(() => {
        let rect = ctxMenu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
        if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
    });
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
}

function closeContextMenu() {
    ctxMenu.classList.remove('open');
    ctxMenuTrainId = null;
}

document.addEventListener('pointerdown', (e) => {
    if (ctxMenu.classList.contains('open') && !ctxMenu.contains(e.target)) closeContextMenu();
});

document.getElementById('ctx-details').addEventListener('click', () => {
    if (ctxMenuTrainId) selectTrain(ctxMenuTrainId);
    closeContextMenu();
});
document.getElementById('ctx-brake').addEventListener('click', () => {
    let train = trains.find(t => t.id === ctxMenuTrainId);
    if (train) { toggleEmergencyBrake(train); if (selectedTrainId === train.id) updateTrainPanel(); }
    closeContextMenu();
});
document.getElementById('ctx-reverse').addEventListener('click', () => {
    let train = trains.find(t => t.id === ctxMenuTrainId);
    if (train) { reverseTrain(train); if (selectedTrainId === train.id) updateTrainPanel(); }
    closeContextMenu();
});
document.getElementById('ctx-manual').addEventListener('click', () => {
    let train = trains.find(t => t.id === ctxMenuTrainId);
    closeContextMenu();
    if (train) armManualRoute(train);
});
document.getElementById('ctx-adjust-route').addEventListener('click', () => {
    let train = trains.find(t => t.id === ctxMenuTrainId);
    closeContextMenu();
    if (train) armAdjustRoute(train);
});
document.getElementById('ctx-despawn').addEventListener('click', () => {
    let train = trains.find(t => t.id === ctxMenuTrainId);
    closeContextMenu();
    if (train) despawnTrain(train);
});

// ============================================================
// --- Game over overlay ---
// ============================================================

// Resets the running simulation back to a fresh start on the diagram
// that's already loaded (same points/tracks/platforms/signals/lines -
// none of that is touched), without reloading the page. Unlike
// loadDiagram(), this never touches MP.active/isHost/roomCode/etc, so
// calling it mid-room doesn't drop the connection or require anyone to
// rejoin - see the btn-restart handler and MP's REQUEST_RESTART below.
function resetGameState() {
    trains = [];
    nextTrainSeq = 1;
    selectedTrainId = null;
    manualRouteArmedTrainId = null;
    manualRoutePreview = null;
    manualRouteWaypoints = [];
    adjustRouteArmedTrainId = null;
    adjustRouteDragging = false;
    adjustDragPointerId = null;
    adjustRoutePreview = null;
    state.platforms.forEach(p => { p._waiting = {}; });
    gameOver = false;
    crashAnim = null;
    document.getElementById('gameover-overlay').classList.add('hidden');
    closeTrainPanel();
    setHint(defaultHint());

    simTimeSeconds = parseStartTimeToSeconds(state.meta.startTime);
    setPaused(true);
    updateClockDisplay();

    draw();
}

document.getElementById('btn-restart').addEventListener('click', () => {
    // In multiplayer, reloading the page would tear down the peer
    // connection and force everyone back through the join screen. Reset
    // the sim in place instead - the host does it directly and its next
    // snapshot carries the reset to everyone else; a guest just asks the
    // host to do it, same as any other authoritative action.
    if (window.MP && MP.active) {
        if (MP.isHost) {
            resetGameState();
        } else {
            MP.sendInput({ type: 'REQUEST_RESTART' });
        }
        return;
    }
    window.location.reload();
});

// ============================================================
// --- Import ---
// ============================================================

function loadDiagram(parsed) {
    state.points = Array.isArray(parsed.points) ? parsed.points : [];
    state.tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
    state.platforms = Array.isArray(parsed.platforms) ? parsed.platforms : [];
    state.signals = Array.isArray(parsed.signals) ? parsed.signals : [];
    state.labels = Array.isArray(parsed.labels) ? parsed.labels : [];
    state.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
    state.demand = (parsed.demand && typeof parsed.demand === 'object') ? parsed.demand : null;

    // Diagrams exported before the Builder's Map Settings feature existed
    // won't have a `meta` object at all - default it in rather than leaving
    // state.meta stale from whatever was loaded previously.
    let m = (parsed.meta && typeof parsed.meta === 'object') ? parsed.meta : {};
    state.meta = {
        name: typeof m.name === 'string' ? m.name : '',
        description: typeof m.description === 'string' ? m.description : '',
        startTime: /^\d{1,2}:\d{2}$/.test(m.startTime) ? m.startTime : DEFAULT_START_TIME
    };

    state.signals.forEach(s => {
        if (s.state !== 'blue' && s.state !== 'red') s.state = 'red';
        // A signal's direction (1 or -1) is what makes it apply to a train
        // at all - see the `matches` check in gatherLookahead. A signal
        // missing this field (or holding some other stray value) matches
        // neither forward nor backward travel, which makes it a permanent
        // no-op: it can sit there showing red forever and simply never stop
        // any train that passes it, regardless of colour. Default it the
        // same way `state` is defaulted just above, rather than leaving a
        // signal that can visually never protect anything.
        if (s.direction !== 1 && s.direction !== -1) s.direction = 1;
    });
    state.platforms.forEach(p => { p._waiting = {}; });

    trains = [];
    nextTrainSeq = 1;
    selectedTrainId = null;
    manualRouteArmedTrainId = null;
    manualRoutePreview = null;
    manualRouteWaypoints = [];
    adjustRouteArmedTrainId = null;
    adjustRouteDragging = false;
    adjustDragPointerId = null;
    adjustRoutePreview = null;
    gameOver = false;
    crashAnim = null;
    document.getElementById('gameover-overlay').classList.add('hidden');
    closeTrainPanel();
    setHint(defaultHint());

    hasLoadedDiagram = true;
    setEmptyStateVisible(false);
    fitCameraToDiagram();

    simTimeSeconds = parseStartTimeToSeconds(state.meta.startTime);
    setPaused(true);
    updateClockDisplay();

    draw();

    // Let other listeners (e.g. the multiplayer host-setup screen and main
    // menu map status in net.js) know a diagram is now available, without
    // them needing to know anything about how loadDiagram works internally.
    window.dispatchEvent(new Event('diagram-loaded'));
}

function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parsed = JSON.parse(e.target.result);
            loadDiagram(parsed);
            // Remember this map in the browser so it shows up as a pickable
            // saved map next time, instead of requiring re-import every visit.
            let fallbackName = file.name ? file.name.replace(/\.json$/i, '') : 'Untitled map';
            saveMapToLibrary({
                points: state.points, tracks: state.tracks, platforms: state.platforms,
                signals: state.signals, labels: state.labels, lines: state.lines,
                demand: state.demand, meta: state.meta
            }, fallbackName);
            showToast('Imported' + (state.meta.name ? ' "' + state.meta.name + '"' : '') + ' \u2014 saved to this browser for next time.');
        } catch (err) {
            showToast('Could not read that file - is it a diagram export?');
        }
    };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
}

// ============================================================
// --- Saved map library (localStorage, per-browser) ---
// ============================================================
// Lets the main menu offer previously-imported maps without the player
// having to keep the original .json file around and re-import it each
// visit. Purely a convenience layer on top of the same loadDiagram() path
// used by a fresh import - nothing here is authoritative game state.

const SAVED_MAPS_KEY = 'trainsig_saved_maps';
const SAVED_MAPS_MAX = 30; // evict oldest beyond this so storage can't grow unbounded

function loadSavedMapsRaw() {
    try {
        let raw = localStorage.getItem(SAVED_MAPS_KEY);
        let list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function writeSavedMapsRaw(list) {
    try {
        localStorage.setItem(SAVED_MAPS_KEY, JSON.stringify(list));
    } catch (e) {
        // Storage full/unavailable (private browsing, quota, etc) - importing
        // and playing still works, it just won't be remembered next time.
        showToast("Couldn't save this map in your browser for next time (storage full or unavailable).");
    }
}

function generateMapId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Saves/updates `diagram` (a full diagram object, meta included) in the
// saved-map library. If a saved map with the same name already exists it's
// overwritten in place (keeping its id) rather than creating a duplicate.
function saveMapToLibrary(diagram, fallbackName) {
    let meta = (diagram && diagram.meta && typeof diagram.meta === 'object') ? diagram.meta : {};
    let name = (meta.name && meta.name.trim()) || fallbackName || 'Untitled map';
    let list = loadSavedMapsRaw();
    let existingIdx = list.findIndex(m => (m.name || '').trim().toLowerCase() === name.trim().toLowerCase());
    let entry = {
        id: existingIdx >= 0 ? list[existingIdx].id : generateMapId(),
        name: name,
        description: meta.description || '',
        startTime: meta.startTime || DEFAULT_START_TIME,
        savedAt: Date.now(),
        diagram: diagram
    };
    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.unshift(entry);
    list.sort((a, b) => b.savedAt - a.savedAt);
    if (list.length > SAVED_MAPS_MAX) list = list.slice(0, SAVED_MAPS_MAX);
    writeSavedMapsRaw(list);
    renderSavedMapsList();
    return entry.id;
}

function deleteSavedMap(id) {
    let list = loadSavedMapsRaw().filter(m => m.id !== id);
    writeSavedMapsRaw(list);
    renderSavedMapsList();
}

function loadSavedMapById(id) {
    if (window.MP && MP.active) { showToast('Map import is disabled during multiplayer.'); return; }
    let entry = loadSavedMapsRaw().find(m => m.id === id);
    if (!entry) { showToast('That saved map is gone.'); return; }
    loadDiagram(entry.diagram);
    showToast('Loaded "' + entry.name + '".');
}

function renderSavedMapsList() {
    let container = document.getElementById('mp-saved-maps-list');
    if (!container) return;
    let list = loadSavedMapsRaw();
    container.innerHTML = '';
    if (list.length === 0) {
        let note = document.createElement('div');
        note.className = 'mp-map-empty-note';
        note.textContent = 'No saved maps yet \u2014 import one above.';
        container.appendChild(note);
        return;
    }
    for (let entry of list) {
        let row = document.createElement('div');
        row.className = 'mp-map-row';

        let main = document.createElement('div');
        main.className = 'mp-map-row-main';
        let nameEl = document.createElement('div');
        nameEl.className = 'mp-map-name';
        nameEl.textContent = entry.name;
        main.appendChild(nameEl);
        if (entry.description) {
            let descEl = document.createElement('div');
            descEl.className = 'mp-map-desc';
            descEl.textContent = entry.description;
            main.appendChild(descEl);
        }
        row.appendChild(main);

        let actions = document.createElement('div');
        actions.className = 'mp-map-row-actions';
        let loadBtn = document.createElement('button');
        loadBtn.className = 'btn btn-sm mp-map-load-btn';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => loadSavedMapById(entry.id));
        let delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.title = 'Remove from saved maps';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', () => deleteSavedMap(entry.id));
        actions.appendChild(loadBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);

        container.appendChild(row);
    }
}

function updateMainMenuMapStatus() {
    let el = document.getElementById('mp-main-mapstatus');
    if (!el) return;
    if (hasLoadedDiagram) {
        let pts = (state.points || []).length;
        let tracks = (state.tracks || []).length;
        let name = state.meta && state.meta.name ? state.meta.name : 'Untitled map';
        el.textContent = name + ' \u2713 (' + pts + ' points, ' + tracks + ' tracks)';
        el.classList.add('ok');
    } else {
        el.textContent = 'No diagram loaded yet.';
        el.classList.remove('ok');
    }
}

document.getElementById('mp-main-import').addEventListener('click', () => {
    if (window.MP && MP.active) { showToast('Map import is disabled during multiplayer.'); return; }
    document.getElementById('import-file').click();
});
window.addEventListener('diagram-loaded', updateMainMenuMapStatus);

const importInput = document.getElementById('import-file');
document.getElementById('btn-import-trigger').addEventListener('click', () => {
    if (window.MP && MP.active) { showToast('Map import is disabled during multiplayer.'); return; }
    importInput.click();
});
document.getElementById('btn-import-empty').addEventListener('click', () => {
    if (window.MP && MP.active) { showToast('Map import is disabled during multiplayer.'); return; }
    importInput.click();
});
importInput.addEventListener('change', (e) => {
    if (window.MP && MP.active) {
        importInput.value = '';
        showToast('Map import is disabled during multiplayer.');
        return;
    }
    handleImportFile(e.target.files[0]);
    importInput.value = '';
});

// --- Boot ---

window.addEventListener('resize', resizeCanvas);
setEmptyStateVisible(true);
setHint(defaultHint());
resizeCanvas();
renderSavedMapsList();
updateMainMenuMapStatus();