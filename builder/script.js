/** 
 * Data Structures
 * Meta: { name: string, description: string, startTime: "HH:MM" }
 *   - name/description are freeform, shown in the Game's map-select screen.
 *   - startTime is the time-of-day (24h) the in-game simulation clock starts
 *     at when this diagram is loaded in the Game. Older diagrams exported
 *     before this field existed are migrated on import to sensible defaults
 *     (see the import handler), so they keep working unchanged.
 * Points: { id, x, y }
 * Tracks: { id, p1_id, p2_id, overpass: boolean, color: string, distance: number,
 *   speedLimit: number, isDepot: boolean,
 *   depotName: string, trainMaxSpeed: string, acceleration: string, emergencyDeceleration: string,
 *   trainLength: string, turnback: boolean, oneway: 'none'|'forward'|'backward' }
 *   - distance is a numeric diagram label in meters (e.g. 3200). It is NOT tied to the
 *     drawn pixel length - this is a schematic diagram, not drawn to scale. It is also
 *     the edge weight used by line pathfinding.
 *   - speedLimit is the line speed for that track segment in km/h (e.g. 80).
 *   - depotName/trainMaxSpeed/acceleration/emergencyDeceleration/trainLength/trainCapacity
 *     only apply when isDepot is true. acceleration is used for both accelerating and
 *     normal (service) braking; emergencyDeceleration is a separate, harder braking value.
 *     trainLength is the length of train this depot is built to handle (e.g. "200 m").
 *     trainCapacity is how many passengers a train built/held at this depot can carry.
 *   - turnback: when true, this track is a designated place trains may reverse
 *     direction. Pathfinding normally refuses to route through a junction where the
 *     turn is 90 degrees or sharper (a real train can't turn on a point like that),
 *     but if either track at that junction is a turnback track, the sharp turn/reversal
 *     is allowed there.
 *   - oneway: 'none' (bidirectional, default), 'forward' (only p1->p2 allowed), or
 *     'backward' (only p2->p1 allowed). Pathfinding will not route the wrong way down
 *     a restricted track.
 * Platforms: { id, track_id, t_dist, side: 1|-1, color: string, number: string, code: string,
 *   stationCode: string, capacity: number }
 *   - code is this platform's own code (e.g. "PF-A"); stationCode identifies the
 *     station the platform belongs to (e.g. "NYP"), shared by every platform at that
 *     station, and is what's shown as the stop's label on a line.
 *   - capacity is the max number of waiting passengers this platform can hold.
 * Signals: { id, track_id, t_dist, side: 1|-1, direction: 1|-1, state: 'red'|'blue',
 *   dragOffset: { x, y } }
 *   - direction: 1 = faces the p1->p2 travel direction, -1 = faces p2->p1.
 *     A signal is only meaningful/visible to trains travelling in its facing
 *     direction; trains going the opposite way would not see this light.
 *     (Train logic itself is future work - this only models the signal's
 *     placement, facing direction, and its red/blue state.)
 *   - dragOffset is a manual world-space nudge applied only to the signal's
 *     head/button, purely for visual spacing. The post/line always still
 *     connects back to the signal's real attachment point on the track
 *     (t_dist/side), which never changes when the head is dragged.
 * Labels: { id, x, y, text, fontSize, bgVisible } - freeform text annotations, not
 *   attached to a track. fontSize is in px (default 14). bgVisible toggles the
 *   backing bubble behind the text (default true); when false the text is
 *   drawn directly on the canvas in a light color instead.
 * Lines: { id, name, color, stops: [Stop, ...] }
 *   - a rail line/route. stops is an ordered list of station stops the line calls
 *     at. The diagram shows the line as a colored path following the track network
 *     (via pathfinding, respecting oneway/turnback/turn-angle rules) between each
 *     consecutive pair of stops.
 *   Stop: { id, platformIds: [platform_id, ...], dwellSeconds: number }
 *     - a single call at a station. Usually one platform, but can hold more than
 *       one platform at the same station - e.g. a no-turnback terminus where a
 *       train arrives at one platform and must depart from a different one
 *       (a balloon loop / stub-end with separate arrival & departure platforms).
 *       When a stop has multiple platforms, pathfinding tries every platform
 *       pairing against the neighboring stop and draws whichever route is
 *       shortest/actually connects.
 *     - dwellSeconds is how long, in seconds, a train sits at this stop
 *       (doors open) before departing for the next one. Defaults to
 *       DEFAULT_DWELL_SECONDS for newly-created stops.
 * Demand: { transferAversion: number (0-100), groups: [DemandGroup, ...] }
 *   - transferAversion is a single global dial: how strongly passengers prefer a
 *     route with fewer train changes. Passengers will always transfer if that's
 *     what completing their trip requires, they just weight extra-interchange
 *     routes as increasingly unattractive the higher this number is.
 *   DemandGroup: { id, name, color, stationDemand: { [stationCode]: StationDemand } }
 *     - a rider segment/purpose, e.g. "To Work", "Back Home", "Travelers". Each
 *       group keeps its own independent demand settings per station.
 *   StationDemand: { attract: [DemandPoint, ...], inflow: [DemandPoint, ...] }
 *     - attract: demand that pulls this group's passengers TOWARDS this station
 *       (i.e. this station is their destination) as a function of time of day.
 *       Its DemandPoint values are a relative, unitless attractiveness weight
 *       (not a passenger count) - only meaningful compared to other stations'/
 *       groups' attract weight at the same moment.
 *     - inflow: demand that spawns this group's passengers AT this station (i.e.
 *       this is where they originate/enter the system) as a function of time of
 *       day. Its DemandPoint values are in passengers/minute.
 *     - each is a freeform curve the user plots directly: a sorted list of
 *       DemandPoints, hand-placed on a graph, with the curve linearly
 *       interpolated between consecutive points to get the demand at any time.
 *   DemandPoint: { id, time: "HHMM", value: number }
 *     - time is a 24h clock string from "0000" to "2359" giving when this point
 *       sits along the day. value is the demand magnitude at that instant, in
 *       whichever unit its curve uses (see StationDemand above); it has no fixed
 *       upper bound - the graph's vertical scale auto-expands to fit whatever is
 *       plotted. Points are kept sorted by time so the curve between them is
 *       well-defined.
 */
let state = {
    meta: { name: '', description: '', startTime: '05:50' },
    points: [],
    tracks: [],
    platforms: [],
    signals: [],
    labels: [],
    lines: [],
    demand: { transferAversion: 70, groups: [] }
};

// Theme (dark canvas)
const CANVAS_BG_COLOR = '#17171a';
const GRID_LINE_COLOR = '#28282c';
const DEFAULT_TRACK_COLOR = '#e4e4e7';
const DEFAULT_PLATFORM_COLOR = '#d1d5db';

// Platform Fixed Dimensions
const PLAT_WIDTH = 30;
const PLAT_LENGTH = 120;
const PLAT_GAP = 10;
const PLAT_OFFSET = PLAT_GAP + (PLAT_WIDTH / 2); // 25

// Signal Fixed Dimensions
const SIGNAL_OFFSET = 22;
const SIGNAL_RADIUS = 7;
// The post always leaves the track dead-perpendicular before it's allowed to
// bend towards the (possibly dragged) head - this stops the whole post from
// being one long diagonal line straight out of the track at an arbitrary
// angle. Its length grows/shrinks with how far the head is dragged out
// perpendicular to the track, but never goes below this minimum so the
// signal head never ends up hugging the track.
const SIGNAL_MIN_STUB_DIST = 12;

// Label Fixed Style
const LABEL_DEFAULT_FONT_SIZE = 14;
const LABEL_MIN_FONT_SIZE = 8;
const LABEL_MAX_FONT_SIZE = 72;
function labelFont(l) {
    return (l.fontSize || LABEL_DEFAULT_FONT_SIZE) + 'px sans-serif';
}
function clampLabelFontSize(val) {
    let n = parseInt(val, 10);
    if (isNaN(n)) return LABEL_DEFAULT_FONT_SIZE;
    return Math.max(LABEL_MIN_FONT_SIZE, Math.min(LABEL_MAX_FONT_SIZE, n));
}

// Line Rendering
const LINE_OFFSET_STEP = 6; // px offset per line index, so overlapping lines fan out
const LINE_ARROW_SPACING = 40; // px between animated direction arrows along a line's path
const LINE_ARROW_SPEED = 30; // px/sec the arrows drift forward, to show travel direction
const DEFAULT_DWELL_SECONDS = 30; // default time a train sits at a newly-added stop
let lineAnimOffset = 0;
// Turn-angle restriction: a real train can't take a junction where the track bends
// this sharply or worse, so pathfinding refuses to route through it unless a
// turnback track is involved. cos(90deg) = 0, so "dot <= 0" means the angle
// between the incoming and outgoing travel directions is 90 degrees or larger.
const TURN_DOT_EPSILON = 1e-9;

// App State
let mode = 'select'; // 'select', 'track', 'split', 'platform', 'signal', 'label', 'delete', 'line'
let gridSize = 40;
let activeLineId = null; // which line new stops get appended to while in 'line' mode
let demandActiveGroupId = null; // which demand group is selected in the Demand Editor
let demandActiveStationCode = null; // which station's demand is being edited in the Demand Editor
let diagonalGrid = false; // when true, grid/snap axes are rotated 45 degrees
let camera = { x: 0, y: 0, zoom: 1 };
let isDraggingCamera = false;
let lastMouse = { x: 0, y: 0 };

// Interactions
let selectedElement = null; 
let hoverElement = null;
let dragPointId = null;
let dragSignalId = null;
let dragSignalStart = null;
let dragLabelId = null;
let isDrawing = false;
let drawStartPoint = null; 
let currentMouseWorld = { x: 0, y: 0 };
let trackProjection = null;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    draw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
refreshLineSelect();

// Continuously animate the direction arrows along any drawn line paths.
// Only re-draws (and burns CPU) while there's actually a line worth animating.
let lineAnimLastTs = null;
function lineAnimationLoop(ts) {
    if (lineAnimLastTs === null) lineAnimLastTs = ts;
    let dt = (ts - lineAnimLastTs) / 1000;
    lineAnimLastTs = ts;
    // Only the selected line's path is ever drawn (see the draw() line-rendering
    // block), so only that line needs to justify the redraw/CPU cost here.
    let selLine = state.lines.find(l => l.id === activeLineId);
    if (selLine && selLine.stops && selLine.stops.length >= 2) {
        lineAnimOffset = (lineAnimOffset + dt * LINE_ARROW_SPEED) % LINE_ARROW_SPACING;
        draw();
    }
    requestAnimationFrame(lineAnimationLoop);
}
requestAnimationFrame(lineAnimationLoop);

// --- Core Math & Helpers ---

function generateId() { return Math.random().toString(36).substr(2, 9); }

function screenToWorld(sx, sy) {
    return { x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom };
}

function snapToGrid(val) {
    return Math.round(val / gridSize) * gridSize;
}

// Snaps a world (x,y) point to the grid. When diagonalGrid is on, the grid's
// axes are rotated 45 degrees, so adjacent snapped points line up on a
// diagonal - this makes drawing tracks at a clean 45-degree angle easy.
function snapPointToGrid(x, y) {
    if (!diagonalGrid) {
        return { x: snapToGrid(x), y: snapToGrid(y) };
    }
    const cos = Math.cos(Math.PI / 4), sin = Math.sin(Math.PI / 4);
    // Rotate into grid-aligned space (rotate by -45deg), snap, rotate back.
    let gx = x * cos + y * sin;
    let gy = -x * sin + y * cos;
    gx = Math.round(gx / gridSize) * gridSize;
    gy = Math.round(gy / gridSize) * gridSize;
    let wx = gx * cos - gy * sin;
    let wy = gx * sin + gy * cos;
    return { x: wx, y: wy };
}

function getPoint(id) { return state.points.find(p => p.id === id); }
function getPointAt(x, y) { return state.points.find(p => p.x === x && p.y === y); }

function getTrackProjection(wx, wy) {
    let best = null;
    let minDist = Infinity;

    for (let t of state.tracks) {
        let p1 = getPoint(t.p1_id);
        let p2 = getPoint(t.p2_id);
        
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) continue;
        
        let udx = dx / len;
        let udy = dy / len;
        
        let mx = wx - p1.x;
        let my = wy - p1.y;
        
        let dot = mx * udx + my * udy;
        
        let t_dist = Math.round(dot / gridSize) * gridSize;
        t_dist = Math.max(0, Math.min(len, t_dist));
        
        let cx = p1.x + udx * t_dist;
        let cy = p1.y + udy * t_dist;
        
        let distToMouse = Math.hypot(wx - cx, wy - cy);
        
        if (distToMouse < minDist) {
            minDist = distToMouse;
            let nx = -udy;
            let ny = udx;
            let sideDot = (wx - cx) * nx + (wy - cy) * ny;
            best = { track: t, t_dist: t_dist, cx, cy, side: sideDot > 0 ? 1 : -1, distToMouse, angle: Math.atan2(dy, dx) };
        }
    }
    return best;
}

function getPlatformGeom(plat) {
    let t = state.tracks.find(tr => tr.id === plat.track_id);
    if (!t) return null;
    let p1 = getPoint(t.p1_id);
    let p2 = getPoint(t.p2_id);
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let len = Math.hypot(dx, dy);
    
    let udx = dx / len;
    let udy = dy / len;
    let cx = p1.x + udx * plat.t_dist;
    let cy = p1.y + udy * plat.t_dist;
    
    let nx = -udy;
    let ny = udx;
    
    let px = cx + nx * plat.side * PLAT_OFFSET;
    let py = cy + ny * plat.side * PLAT_OFFSET;
    let angle = Math.atan2(dy, dx);
    
    return { px, py, angle };
}

// --- Line Pathfinding ---
// Finds a route for a train line between two platforms, following the track
// network. Two physical rules are enforced:
//   1. oneway: a track flagged 'forward'/'backward' can only be entered in that
//      direction (see canEnterTrack).
//   2. turn angle: at an actual junction/switch (a point where 3+ tracks
//      meet), continuing onto a different track is only allowed if the turn
//      is less than 90 degrees - a real switch can't bend a train sharper
//      than that. A plain 2-track pass-through point (just a bend drawn into
//      a single route, not a real switch) has no such restriction - the
//      train simply follows the track through at whatever angle it was
//      drawn. The exception at real junctions is a 'turnback' track: if
//      either track at the junction is a turnback, the sharp turn/reversal
//      is allowed, modeling the train stopping and reversing there.

function getTrack(id) { return state.tracks.find(t => t.id === id); }

function trackLength(t) {
    if (typeof t.distance === 'number' && isFinite(t.distance) && t.distance > 0) return t.distance;
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return 0;
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// The actual on-screen pixel length of a track, ignoring any custom
// schematic `distance` label. trackLength() above is the Dijkstra edge
// weight (a diagram label, deliberately NOT tied to pixel length - see the
// Tracks doc comment at the top of this file). Segment endpoints that get
// drawn on the canvas must use *this* pixel length instead, or a track with
// a custom distance label would have its rendered path overshoot/undershoot
// the actual track geometry on screen.
function trackPixelLength(t) {
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return 0;
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
}

// Unit vector of travel direction along track t. fromP1=true means p1->p2.
function trackDirVector(t, fromP1) {
    let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
    let dx = p2.x - p1.x, dy = p2.y - p1.y;
    if (!fromP1) { dx = -dx; dy = -dy; }
    let len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

// Can a train travel along track t starting from p1 (fromP1=true) or from p2 (fromP1=false)?
function canEnterTrack(t, fromP1) {
    if (t.oneway === 'forward') return fromP1;
    if (t.oneway === 'backward') return !fromP1;
    return true;
}

// Is the turn from track `inTrack` (arriving, direction inDir) onto `outTrack`
// (leaving, direction outDir) physically allowed?
function isTurnAllowed(inTrack, inDir, outTrack, outDir) {
    if (!inTrack) return true; // starting fresh, no incoming direction to compare against
    let dot = inDir.x * outDir.x + inDir.y * outDir.y;
    if (dot > TURN_DOT_EPSILON) return true; // turn is under 90 degrees
    return !!(inTrack.turnback || outTrack.turnback);
}

// Dijkstra over (point, arrival track) states. Returns an array of
// { track, from, to } segments (from/to are t_dist values along that track,
// direction implied by from vs to), or null if no legal route exists.
function findLinePath(platA, platB) {
    if (!platA || !platB) return null;
    let trackA = getTrack(platA.track_id);
    let trackB = getTrack(platB.track_id);
    if (!trackA || !trackB) return null;

    // Same-track direct case: only valid if oneway allows travelling straight
    // from A's position to B's position.
    if (trackA.id === trackB.id) {
        let forward = platB.t_dist >= platA.t_dist;
        if (canEnterTrack(trackA, forward)) {
            return [{ track: trackA, from: platA.t_dist, to: platB.t_dist }];
        }
    }

    const lenA = trackLength(trackA);
    const key = (pointId, arrTrackId) => pointId + '|' + (arrTrackId || '-');

    let dist = new Map();
    let prev = new Map(); // key -> { fromKey, track, fromP1 }
    let queue = [];

    function pushStart(pointId, cost, arrTrack, inDir) {
        let k = key(pointId, arrTrack.id);
        if (dist.has(k) && dist.get(k) <= cost) return;
        dist.set(k, cost);
        prev.set(k, { fromKey: null, startTrack: arrTrack, startEndsAtP1: pointId === arrTrack.p1_id });
        queue.push({ key: k, pointId, arrTrack, inDir, d: cost });
    }

    // Leaving platform A towards p1 (needs p2->p1 travel, i.e. fromP1=false)
    if (canEnterTrack(trackA, false)) {
        pushStart(trackA.p1_id, platA.t_dist, trackA, trackDirVector(trackA, false));
    }
    // Leaving platform A towards p2 (fromP1=true)
    if (canEnterTrack(trackA, true)) {
        pushStart(trackA.p2_id, lenA - platA.t_dist, trackA, trackDirVector(trackA, true));
    }

    if (queue.length === 0) return null;

    let goalKey = null;
    while (queue.length) {
        queue.sort((a, b) => a.d - b.d);
        let cur = queue.shift();
        if (cur.d > (dist.get(cur.key) ?? Infinity)) continue;

        // Reached an endpoint of B's track - close out with the final partial leg.
        let connTracks = state.tracks.filter(t => t.p1_id === cur.pointId || t.p2_id === cur.pointId);
        // A turn is only mechanically restricted at an actual junction/switch -
        // a point where 3+ tracks meet. A point with only 2 tracks (the one we
        // arrived on, plus one other) is a plain pass-through/bend in a single
        // route - drawn at whatever angle suited the diagram layout, not a real
        // switch - so the train just follows it through regardless of angle.
        let isRealJunction = connTracks.length >= 3;

        if (cur.pointId === trackB.p1_id || cur.pointId === trackB.p2_id) {
            let atP1 = cur.pointId === trackB.p1_id;
            let finalFromP1 = atP1; // travelling from this endpoint towards B's position
            let finalLeg = atP1 ? platB.t_dist : (trackLength(trackB) - platB.t_dist);
            let outDir = trackDirVector(trackB, finalFromP1);
            // Reaching B's platform by continuing on the very track we arrived on
            // (trackB === cur.arrTrack) means the train rode all the way to this
            // end and now has to reverse back onto itself to reach the platform -
            // a real reversal, same as a dead-end U-turn below. That always needs
            // isTurnAllowed's turnback check, regardless of how many tracks meet
            // here (isRealJunction only governs actual switches, not this case).
            let isFinalUTurn = cur.arrTrack.id === trackB.id;
            let turnOk = (!isRealJunction && !isFinalUTurn) || isTurnAllowed(cur.arrTrack, cur.inDir, trackB, outDir);
            if (canEnterTrack(trackB, finalFromP1) && turnOk) {
                let totalCost = cur.d + finalLeg;
                let gk = key('__goal__', trackB.id) + '@' + cur.key;
                dist.set(gk, totalCost);
                prev.set(gk, { fromKey: cur.key, endTrack: trackB, endAtP1: atP1 });
                if (goalKey === null || totalCost < dist.get(goalKey)) goalKey = gk;
                // Don't `return` immediately - a lower-cost route via a further pop
                // could still exist in theory, but since we process in cost order
                // the first arrival is optimal. Safe to stop here.
                break;
            }
        }

        for (let t of connTracks) {
            let isUTurn = t.id === cur.arrTrack.id;
            // A U-turn back onto the arrival track only makes sense at a true
            // dead end (nothing else meets this point) - at any point with
            // another track present, backtracking the way you came is never
            // useful, so it's skipped there regardless of turnback.
            if (isUTurn && connTracks.length > 1) continue;
            let fromP1 = t.p1_id === cur.pointId;
            if (!canEnterTrack(t, fromP1)) continue;
            let outDir = trackDirVector(t, fromP1);
            // A dead-end U-turn is a real reversal (same physical move a
            // turnback track is meant to allow) even though it isn't a 3+
            // track "junction" - so it must go through the same turnback
            // check as a real junction, not be waved through like a plain
            // 2-track pass-through bend would be.
            if ((isRealJunction || isUTurn) && !isTurnAllowed(cur.arrTrack, cur.inDir, t, outDir)) continue;

            let otherPoint = fromP1 ? t.p2_id : t.p1_id;
            let cost = trackLength(t);
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

    // Reconstruct the chain of track segments walked, in travel order.
    let segments = [];
    let node = prev.get(goalKey);
    let endTrack = node.endTrack, endAtP1 = node.endAtP1;
    let curKey = node.fromKey;
    // NOTE: these "from"/"to" values are on-canvas pixel positions along the
    // track (same space as platform t_dist), so they must use the real pixel
    // length, not trackLength()'s schematic distance label - otherwise a
    // track with a custom distance would render the path overshooting the
    // track's actual endpoints.
    segments.unshift({ track: endTrack, from: endAtP1 ? 0 : trackPixelLength(endTrack), to: platB.t_dist });

    while (curKey) {
        let p = prev.get(curKey);
        if (!p) break;
        if (p.startTrack) {
            // Initial leg leaving platform A
            let t = p.startTrack;
            let toEnd = p.startEndsAtP1 ? 0 : trackPixelLength(t);
            segments.unshift({ track: t, from: platA.t_dist, to: toEnd });
            break;
        } else {
            let t = p.track;
            let toEnd = p.fromP1 ? trackPixelLength(t) : 0;
            let fromStart = p.fromP1 ? 0 : trackPixelLength(t);
            segments.unshift({ track: t, from: fromStart, to: toEnd });
            curKey = p.fromKey;
        }
    }

    return segments;
}

// Resolves a line stop's platform id list into actual platform objects
// (dropping any that were deleted elsewhere without the stop being cleaned up).
function getStopPlatforms(stop) {
    if (!stop || !stop.platformIds) return [];
    return stop.platformIds.map(id => state.platforms.find(p => p.id === id)).filter(Boolean);
}

function segsLength(segs) {
    return segs.reduce((sum, seg) => sum + Math.abs(seg.to - seg.from), 0);
}

// A stop can hold more than one platform at the same station (a no-turnback
// terminus where trains arrive on one platform and leave from another). This
// tries every platform pairing between the two stops and keeps whichever
// legal route is shortest, so the line still draws a sensible path through a
// multi-platform stop without the user having to pick which platform is "the"
// one for pathfinding.
function findBestRouteBetweenStops(stopA, stopB) {
    let platsA = getStopPlatforms(stopA);
    let platsB = getStopPlatforms(stopB);
    let best = null, bestLen = Infinity;
    for (let pa of platsA) {
        for (let pb of platsB) {
            if (pa.id === pb.id) continue;
            let segs = findLinePath(pa, pb);
            if (!segs) continue;
            let len = segsLength(segs);
            if (len < bestLen) { bestLen = len; best = segs; }
        }
    }
    return best;
}

// Resolves a full line's path: an array of segment-arrays, one per
// consecutive stop pair (so a break/no-route between two stops doesn't kill
// the whole line's rendering).
function getLineSegments(line) {
    let out = [];
    for (let i = 0; i < line.stops.length - 1; i++) {
        out.push(findBestRouteBetweenStops(line.stops[i], line.stops[i + 1]));
    }
    return out;
}

// Routes a clean-angled post from the track attachment point A to the
// (possibly dragged) head H, made of up to 3 segments:
//   1. A -> B: dead-perpendicular to the track. Its length tracks how far H
//      actually sits out perpendicular to the track, but never shrinks below
//      SIGNAL_MIN_STUB_DIST, so the head never ends up hugging the track.
//   2. B -> M: a 45-degree diagonal leg (relative to the perpendicular).
//   3. M -> H: a final leg running purely along the perpendicular or purely
//      along the track direction (0 or 90 degrees relative to perpendicular).
// Segment 2 and/or 3 can collapse to zero length (e.g. when H is already
// perfectly perpendicular or already 45 degrees out), so the post is never
// forced through more bends than the head's position actually needs - it's
// just no longer capped at a single bend either.
function getSignalPath(cx, cy, trackAngle, side, headX, headY) {
    let baseAngle = trackAngle + side * (Math.PI / 2);
    let ux = Math.cos(baseAngle), uy = Math.sin(baseAngle); // perpendicular unit
    let vx = Math.cos(baseAngle + Math.PI / 2), vy = Math.sin(baseAngle + Math.PI / 2); // track-aligned unit

    let hx = headX - cx, hy = headY - cy;
    let du = hx * ux + hy * uy; // component of head offset along perpendicular
    let dv = hx * vx + hy * vy; // component of head offset along the track

    let stubLen = Math.max(SIGNAL_MIN_STUB_DIST, du);
    let bx = cx + ux * stubLen;
    let by = cy + uy * stubLen;

    // Remaining local-frame delta from the stub end to the head.
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
    let t = state.tracks.find(tr => tr.id === sig.track_id);
    if (!t) return null;
    let p1 = getPoint(t.p1_id);
    let p2 = getPoint(t.p2_id);
    if (!p1 || !p2) return null;
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;
    let len = Math.hypot(dx, dy);
    if (len === 0) return null;

    let udx = dx / len;
    let udy = dy / len;
    let cx = p1.x + udx * sig.t_dist;
    let cy = p1.y + udy * sig.t_dist;

    let trackAngle = Math.atan2(dy, dx);
    let baseAngle = trackAngle + sig.side * (Math.PI / 2);

    // Manual drag nudge - only moves the head/button visually. The post
    // always still leaves the real attachment point (cx,cy) on the track
    // dead-perpendicular first, then routes the rest of the way to this
    // (possibly nudged) head position in clean 45-degree-ish legs.
    let dragOffset = sig.dragOffset || { x: 0, y: 0 };
    let headX = cx + Math.cos(baseAngle) * SIGNAL_OFFSET + dragOffset.x;
    let headY = cy + Math.sin(baseAngle) * SIGNAL_OFFSET + dragOffset.y;

    let path = getSignalPath(cx, cy, trackAngle, sig.side, headX, headY);

    let facing = sig.direction === -1 ? trackAngle + Math.PI : trackAngle;

    return { cx, cy, bx: path.bx, by: path.by, mx: path.mx, my: path.my, px: path.px, py: path.py, facing, trackAngle };
}

function findHoverElement(wx, wy) {
    for (let p of state.points) {
        if (Math.hypot(p.x - wx, p.y - wy) < 10 / camera.zoom) return { type: 'point', id: p.id };
    }

    for (let l of state.labels) {
        ctx.font = labelFont(l);
        let w = ctx.measureText(l.text).width + 10;
        let h = (l.fontSize || LABEL_DEFAULT_FONT_SIZE) + 6;
        if (Math.abs(wx - l.x) <= w / 2 && Math.abs(wy - l.y) <= h / 2) {
            return { type: 'label', id: l.id };
        }
    }
    
    for (let p of state.platforms) {
        let geom = getPlatformGeom(p);
        if (!geom) continue;
        
        let lx = wx - geom.px;
        let ly = wy - geom.py;
        let cosA = Math.cos(-geom.angle);
        let sinA = Math.sin(-geom.angle);
        let localX = lx * cosA - ly * sinA;
        let localY = lx * sinA + ly * cosA;
        
        if (Math.abs(localX) <= PLAT_LENGTH/2 && Math.abs(localY) <= PLAT_WIDTH/2) {
            return { type: 'platform', id: p.id };
        }
    }

    for (let s of state.signals) {
        let geom = getSignalGeom(s);
        if (!geom) continue;
        if (Math.hypot(geom.px - wx, geom.py - wy) < (SIGNAL_RADIUS + 12) / camera.zoom) {
            return { type: 'signal', id: s.id };
        }
    }

    for (let t of state.tracks) {
        let p1 = getPoint(t.p1_id);
        let p2 = getPoint(t.p2_id);
        let A = wx - p1.x, B = wy - p1.y, C = p2.x - p1.x, D = p2.y - p1.y;
        let dot = A * C + B * D, len_sq = C * C + D * D, param = -1;
        if (len_sq != 0) param = dot / len_sq;
        let xx, yy;
        if (param < 0) { xx = p1.x; yy = p1.y; }
        else if (param > 1) { xx = p2.x; yy = p2.y; }
        else { xx = p1.x + param * C; yy = p1.y + param * D; }
        
        if (Math.hypot(wx - xx, wy - yy) < 8 / camera.zoom) {
            return { type: 'track', id: t.id };
        }
    }
    return null;
}

// --- Tools & UI Binding ---

function setMode(newMode) {
    mode = newMode;
    document.querySelectorAll('.tool-group button[data-mode]').forEach(b => b.classList.remove('active'));
    document.querySelector(`button[data-mode="${mode}"]`).classList.add('active');
    selectedElement = null;
    trackProjection = null;
    updateUI();
    draw();
}

function updateUI() {
    let btnOverpass = document.getElementById('btn-overpass');
    let btnEditTrack = document.getElementById('btn-edit-track');
    let btnEditPlatform = document.getElementById('btn-edit-platform');
    let btnEditLabel = document.getElementById('btn-edit-label');
    let btnToggleSignal = document.getElementById('btn-toggle-signal');
    let btnFlipSignal = document.getElementById('btn-flip-signal');
    let colorInput = document.getElementById('elem-color');
    
    btnOverpass.disabled = true;
    btnEditTrack.disabled = true;
    btnEditPlatform.disabled = true;
    btnEditLabel.disabled = true;
    btnToggleSignal.disabled = true;
    btnFlipSignal.disabled = true;

    if (selectedElement) {
        if (selectedElement.type === 'track') {
            btnOverpass.disabled = false;
            btnEditTrack.disabled = false;
            let t = state.tracks.find(tr => tr.id === selectedElement.id);
            if (t && t.color) colorInput.value = t.color;
            else colorInput.value = DEFAULT_TRACK_COLOR;
        }
        if (selectedElement.type === 'platform') {
            btnEditPlatform.disabled = false;
            let p = state.platforms.find(pl => pl.id === selectedElement.id);
            if (p && p.color) colorInput.value = p.color;
            else colorInput.value = DEFAULT_PLATFORM_COLOR;
        }
        if (selectedElement.type === 'signal') {
            btnToggleSignal.disabled = false;
            btnFlipSignal.disabled = false;
        }
        if (selectedElement.type === 'label') {
            btnEditLabel.disabled = false;
        }
    }
}

function deleteElement(elem) {
    if (!elem) return;
    
    if (elem.type === 'track') {
        let removedPlatformIds = state.platforms.filter(p => p.track_id === elem.id).map(p => p.id);
        state.tracks = state.tracks.filter(t => t.id !== elem.id);
        state.platforms = state.platforms.filter(p => p.track_id !== elem.id);
        state.signals = state.signals.filter(s => s.track_id !== elem.id);
        if (removedPlatformIds.length) {
            removePlatformsFromLineStops(removedPlatformIds);
        }
        cleanupOrphanPoints();
    } else if (elem.type === 'platform') {
        state.platforms = state.platforms.filter(p => p.id !== elem.id);
        removePlatformsFromLineStops([elem.id]);
    } else if (elem.type === 'signal') {
        state.signals = state.signals.filter(s => s.id !== elem.id);
    } else if (elem.type === 'label') {
        state.labels = state.labels.filter(l => l.id !== elem.id);
    } else if (elem.type === 'point') {
        let connectedTracks = state.tracks.filter(t => t.p1_id === elem.id || t.p2_id === elem.id);
        connectedTracks.forEach(t => deleteElement({type: 'track', id: t.id}));
        state.points = state.points.filter(p => p.id !== elem.id);
    }
    
    if (selectedElement && selectedElement.id === elem.id) {
        selectedElement = null;
        updateUI();
    }
    draw();
}

// --- Custom Modal (replaces window.prompt) ---

function openModal(title, fields, onSave) {
    const overlay = document.getElementById('edit-modal-overlay');
    const titleEl = document.getElementById('modal-title');
    const fieldsEl = document.getElementById('modal-fields');
    const saveBtn = document.getElementById('modal-save');
    const cancelBtn = document.getElementById('modal-cancel');

    titleEl.textContent = title;
    fieldsEl.innerHTML = '';
    const inputs = {};

    fields.forEach(f => {
        const wrap = document.createElement('div');
        wrap.className = 'modal-field';
        if (f.dependsOn) wrap.dataset.dependsOn = f.dependsOn;

        if (f.type === 'checkbox') {
            wrap.classList.add('modal-field-checkbox');
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'modal-input-' + f.key;
            input.checked = !!f.value;
            const span = document.createElement('span');
            span.textContent = f.label;
            label.appendChild(input);
            label.appendChild(span);
            wrap.appendChild(label);
            inputs[f.key] = input;
        } else if (f.type === 'select') {
            const label = document.createElement('label');
            label.textContent = f.label;
            label.htmlFor = 'modal-input-' + f.key;

            const select = document.createElement('select');
            select.id = 'modal-input-' + f.key;
            (f.options || []).forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                if (opt.value === f.value) o.selected = true;
                select.appendChild(o);
            });

            wrap.appendChild(label);
            wrap.appendChild(select);
            inputs[f.key] = select;
        } else if (f.type === 'textarea') {
            const label = document.createElement('label');
            label.textContent = f.label;
            label.htmlFor = 'modal-input-' + f.key;

            const input = document.createElement('textarea');
            input.id = 'modal-input-' + f.key;
            input.value = f.value ?? '';
            if (f.placeholder) input.placeholder = f.placeholder;
            input.rows = f.rows || 3;
            // Inline styles (rather than relying on external CSS, which
            // doesn't define a .modal-field textarea rule) so this renders
            // consistently with the other dark-themed modal inputs.
            input.style.cssText = 'font: inherit; font-size: 14px; padding: 6px 8px; ' +
                'border: 1px solid #3f3f46; border-radius: 4px; background-color: #131315; ' +
                'color: #f4f4f5; resize: vertical; width: 100%; box-sizing: border-box;';

            wrap.appendChild(label);
            wrap.appendChild(input);
            inputs[f.key] = input;
        } else {
            const label = document.createElement('label');
            label.textContent = f.label;
            label.htmlFor = 'modal-input-' + f.key;

            const input = document.createElement('input');
            input.type = (f.type === 'number') ? 'number' : (f.type === 'time') ? 'time' : 'text';
            input.id = 'modal-input-' + f.key;
            input.value = f.value ?? '';
            if (f.placeholder) input.placeholder = f.placeholder;
            if (f.type === 'number') {
                if (f.min !== undefined) input.min = f.min;
                if (f.max !== undefined) input.max = f.max;
                if (f.step !== undefined) input.step = f.step;
            }

            wrap.appendChild(label);
            wrap.appendChild(input);
            inputs[f.key] = input;
        }

        fieldsEl.appendChild(wrap);
    });

    function updateVisibility() {
        fieldsEl.querySelectorAll('[data-depends-on]').forEach(el => {
            const depInput = inputs[el.dataset.dependsOn];
            const visible = depInput ? !!depInput.checked : true;
            el.style.display = visible ? '' : 'none';
        });
    }
    fields.forEach(f => {
        if (f.type === 'checkbox') {
            inputs[f.key].addEventListener('change', updateVisibility);
        }
    });
    updateVisibility();

    overlay.classList.remove('hidden');
    const firstInput = fieldsEl.querySelector('input[type="text"]') || fieldsEl.querySelector('input');
    if (firstInput) { firstInput.focus(); if (firstInput.select) firstInput.select(); }

    function cleanup() {
        overlay.classList.add('hidden');
        saveBtn.removeEventListener('click', saveHandler);
        cancelBtn.removeEventListener('click', cancelHandler);
        overlay.removeEventListener('keydown', keyHandler);
    }
    function saveHandler() {
        const values = {};
        fields.forEach(f => {
            values[f.key] = (f.type === 'checkbox') ? inputs[f.key].checked : inputs[f.key].value;
        });
        cleanup();
        onSave(values);
    }
    function cancelHandler() {
        cleanup();
    }
    function keyHandler(e) {
        if (e.key === 'Enter' && e.target.type !== 'checkbox') saveHandler();
        else if (e.key === 'Escape') cancelHandler();
    }

    saveBtn.addEventListener('click', saveHandler);
    cancelBtn.addEventListener('click', cancelHandler);
    overlay.addEventListener('keydown', keyHandler);
}

function cleanupOrphanPoints() {
    let used = new Set();
    state.tracks.forEach(t => { used.add(t.p1_id); used.add(t.p2_id); });
    state.points = state.points.filter(p => used.has(p.id));
}

// --- Event Listeners ---

document.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => setMode(e.target.dataset.mode));
});

document.getElementById('btn-overpass').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'track') {
        let t = state.tracks.find(tr => tr.id === selectedElement.id);
        if (t) t.overpass = !t.overpass;
        draw();
    }
});

document.getElementById('btn-edit-track').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'track') {
        let t = state.tracks.find(tr => tr.id === selectedElement.id);
        if (t) {
            openModal('Edit Track Info', [
                { key: 'distance', type: 'number', label: 'Distance in meters (diagram only, not to scale)', value: (typeof t.distance === 'number') ? t.distance : '', placeholder: 'e.g. 3200', min: 0, step: 1 },
                { key: 'speedLimit', type: 'number', label: 'Speed Limit (km/h)', value: (typeof t.speedLimit === 'number') ? t.speedLimit : '', placeholder: 'e.g. 80', min: 0, step: 1 },
                { key: 'oneway', type: 'select', label: 'One-way restriction (pathfinding)', value: t.oneway || 'none', options: [
                    { value: 'none', label: 'Bidirectional' },
                    { value: 'forward', label: 'One-way: Point 1 → Point 2 only' },
                    { value: 'backward', label: 'One-way: Point 2 → Point 1 only' }
                ] },
                { key: 'turnback', type: 'checkbox', label: 'Intended turnback (lets pathfinding reverse here)', value: !!t.turnback },
                { key: 'isDepot', type: 'checkbox', label: 'This track is a Depot', value: !!t.isDepot },
                { key: 'depotName', type: 'text', label: 'Depot Name', value: t.depotName || '', placeholder: 'e.g. North Yard', dependsOn: 'isDepot' },
                { key: 'trainMaxSpeed', type: 'text', label: 'Train Max Speed', value: t.trainMaxSpeed || '', placeholder: 'e.g. 100 km/h', dependsOn: 'isDepot' },
                { key: 'trainLength', type: 'text', label: 'Train Length', value: t.trainLength || '', placeholder: 'e.g. 200 m', dependsOn: 'isDepot' },
                { key: 'trainCapacity', type: 'number', label: 'Train Capacity (passengers/train)', value: (typeof t.trainCapacity === 'number') ? t.trainCapacity : '', placeholder: 'e.g. 900', min: 0, step: 1, dependsOn: 'isDepot' },
                { key: 'acceleration', type: 'text', label: 'Acceleration / Deceleration', value: t.acceleration || '', placeholder: 'e.g. 1.0 m/s²', dependsOn: 'isDepot' },
                { key: 'emergencyDeceleration', type: 'text', label: 'Emergency Deceleration', value: t.emergencyDeceleration || '', placeholder: 'e.g. 2.5 m/s²', dependsOn: 'isDepot' }
            ], (vals) => {
                let d = parseFloat(vals.distance);
                t.distance = isNaN(d) ? undefined : d;
                let sl = parseFloat(vals.speedLimit);
                t.speedLimit = isNaN(sl) ? undefined : sl;
                t.oneway = vals.oneway || 'none';
                t.turnback = !!vals.turnback;
                t.isDepot = vals.isDepot;
                if (t.isDepot) {
                    t.depotName = vals.depotName;
                    t.trainMaxSpeed = vals.trainMaxSpeed;
                    t.trainLength = vals.trainLength;
                    let tc = parseInt(vals.trainCapacity, 10);
                    t.trainCapacity = isNaN(tc) ? undefined : tc;
                    t.acceleration = vals.acceleration;
                    t.emergencyDeceleration = vals.emergencyDeceleration;
                } else {
                    delete t.depotName;
                    delete t.trainMaxSpeed;
                    delete t.trainLength;
                    delete t.trainCapacity;
                    delete t.acceleration;
                    delete t.emergencyDeceleration;
                }
                draw();
            });
        }
    }
});

document.getElementById('btn-edit-platform').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'platform') {
        let p = state.platforms.find(pl => pl.id === selectedElement.id);
        if (p) {
            openModal('Edit Platform', [
                { key: 'number', label: 'Platform Number', value: p.number || '' },
                { key: 'code', label: 'Platform Code', value: p.code || '', placeholder: 'e.g. PF-A' },
                { key: 'stationCode', label: 'Station Code', value: p.stationCode || '', placeholder: 'e.g. NYP' },
                { key: 'capacity', type: 'number', label: 'Capacity (max waiting passengers)', value: (typeof p.capacity === 'number') ? p.capacity : '', placeholder: 'e.g. 300', min: 0, step: 1 }
            ], (vals) => {
                p.number = vals.number;
                p.code = vals.code;
                let prevStationCode = p.stationCode;
                p.stationCode = vals.stationCode;
                let c = parseInt(vals.capacity, 10);
                p.capacity = isNaN(c) ? undefined : c;
                draw();
                refreshLineSelect();
                if (prevStationCode !== p.stationCode) refreshDemandEditorIfOpen();
            });
        }
    }
});

document.getElementById('btn-toggle-signal').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'signal') {
        let s = state.signals.find(sg => sg.id === selectedElement.id);
        if (s) { s.state = s.state === 'red' ? 'blue' : 'red'; draw(); }
    }
});

document.getElementById('btn-flip-signal').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'signal') {
        let s = state.signals.find(sg => sg.id === selectedElement.id);
        if (s) { s.direction = s.direction === 1 ? -1 : 1; draw(); }
    }
});

document.getElementById('btn-edit-label').addEventListener('click', () => {
    if (selectedElement && selectedElement.type === 'label') {
        let l = state.labels.find(lb => lb.id === selectedElement.id);
        if (l) {
            openModal('Edit Text Label', [
                { key: 'text', type: 'text', label: 'Label Text', value: l.text || '', placeholder: 'e.g. Junction A' },
                { key: 'fontSize', type: 'number', label: 'Font Size (px)', value: l.fontSize || LABEL_DEFAULT_FONT_SIZE, min: LABEL_MIN_FONT_SIZE, max: LABEL_MAX_FONT_SIZE, step: 1 },
                { key: 'bgVisible', type: 'checkbox', label: 'Show background', value: l.bgVisible !== false }
            ], (vals) => {
                l.text = vals.text;
                l.fontSize = clampLabelFontSize(vals.fontSize);
                l.bgVisible = !!vals.bgVisible;
                draw();
            });
        }
    }
});

document.getElementById('btn-toggle-diagonal-grid').addEventListener('click', (e) => {
    diagonalGrid = !diagonalGrid;
    e.target.textContent = diagonalGrid ? 'Diagonal Grid: On' : 'Diagonal Grid: Off';
    e.target.classList.toggle('active', diagonalGrid);
    draw();
});

document.getElementById('elem-color').addEventListener('input', (e) => {
    let val = e.target.value;
    if (selectedElement) {
        if (selectedElement.type === 'track') {
            let t = state.tracks.find(tr => tr.id === selectedElement.id);
            if (t) t.color = val;
        } else if (selectedElement.type === 'platform') {
            let p = state.platforms.find(pl => pl.id === selectedElement.id);
            if (p) p.color = val;
        }
        draw();
    }
});

document.getElementById('grid-size').addEventListener('input', (e) => {
    gridSize = parseInt(e.target.value);
    document.getElementById('grid-val').innerText = gridSize;
    draw();
});

// --- Lines ---

// Strips deleted platform ids out of every line's stops, dropping any stop
// that's left with no platforms at all (a plain single-platform stop
// disappears exactly like before; a multi-platform stop just loses that one
// platform and keeps the rest).
function removePlatformsFromLineStops(platformIds) {
    state.lines.forEach(ln => {
        ln.stops.forEach(stop => {
            stop.platformIds = stop.platformIds.filter(id => !platformIds.includes(id));
        });
        ln.stops = ln.stops.filter(stop => stop.platformIds.length > 0);
    });
}

function platformLabel(plat) {
    if (!plat) return '(missing platform)';
    return plat.number ? ('Plat ' + plat.number) : plat.id.substr(0, 4);
}

function stationStopLabel(stop) {
    let plats = getStopPlatforms(stop);
    if (plats.length === 0) return '(missing station)';
    let station = plats[0].stationCode || '(no station code)';
    let platList = plats.map(platformLabel).join(', ');
    return station + ' - ' + platList;
}

function refreshLineSelect() {
    let sel = document.getElementById('line-select');
    let prev = activeLineId;
    sel.innerHTML = '';
    let noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = state.lines.length ? '(no line selected)' : '(no lines yet)';
    sel.appendChild(noneOpt);
    state.lines.forEach(ln => {
        let opt = document.createElement('option');
        opt.value = ln.id;
        opt.textContent = ln.name || 'Unnamed Line';
        sel.appendChild(opt);
    });
    if (prev && state.lines.some(ln => ln.id === prev)) {
        sel.value = prev;
        activeLineId = prev;
    } else {
        sel.value = '';
        activeLineId = null;
    }
}

document.getElementById('line-select').addEventListener('change', (e) => {
    activeLineId = e.target.value || null;
    draw(); // the canvas only ever draws the selected line's path, so refresh immediately
});

document.getElementById('btn-new-line').addEventListener('click', () => {
    setTimeout(() => {
        openModal('New Line', [
            { key: 'name', type: 'text', label: 'Line Name', value: '', placeholder: 'e.g. Red Line' },
            { key: 'color', type: 'text', label: 'Line Color (hex)', value: '#ef4444', placeholder: '#ef4444' }
        ], (vals) => {
            if (!vals.name || vals.name.trim() === '') return;
            let newLine = { id: generateId(), name: vals.name.trim(), color: vals.color || '#ef4444', stops: [] };
            state.lines.push(newLine);
            refreshLineSelect();
            document.getElementById('line-select').value = newLine.id;
            activeLineId = newLine.id;
            if (mode !== 'line') setMode('line');
            draw();
        });
    }, 0);
});

document.getElementById('btn-manage-lines').addEventListener('click', () => {
    openLineManager();
});

function openLineManager() {
    const overlay = document.getElementById('line-modal-overlay');
    const body = document.getElementById('line-modal-body');

    function render() {
        body.innerHTML = '';
        if (state.lines.length === 0) {
            let p = document.createElement('p');
            p.className = 'line-empty-note';
            p.textContent = 'No lines yet. Use "New Line" to create one, then click platforms in "Add Line / Stations" mode.';
            body.appendChild(p);
            return;
        }
        state.lines.forEach(line => {
            const entry = document.createElement('div');
            entry.className = 'line-entry';

            const header = document.createElement('div');
            header.className = 'line-entry-header';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = line.name || '';
            nameInput.addEventListener('input', () => {
                line.name = nameInput.value;
                refreshLineSelect();
                draw();
            });

            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = line.color || '#ef4444';
            colorInput.addEventListener('input', () => {
                line.color = colorInput.value;
                draw();
            });

            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete Line';
            delBtn.addEventListener('click', () => {
                if (!confirm('Delete line "' + (line.name || 'Unnamed Line') + '"?')) return;
                state.lines = state.lines.filter(ln => ln.id !== line.id);
                if (activeLineId === line.id) activeLineId = null;
                refreshLineSelect();
                render();
                draw();
            });

            header.appendChild(nameInput);
            header.appendChild(colorInput);
            header.appendChild(delBtn);
            entry.appendChild(header);

            const list = document.createElement('ul');
            list.className = 'line-stops-list';
            if (line.stops.length === 0) {
                let li = document.createElement('li');
                li.className = 'line-empty-note';
                li.textContent = 'No stations yet.';
                list.appendChild(li);
            }
            line.stops.forEach((stop, idx) => {
                let row = document.createElement('li');
                row.className = 'line-stop-row';

                let top = document.createElement('div');
                top.className = 'stop-row-top';

                let label = document.createElement('span');
                label.className = 'stop-label';
                label.textContent = (idx + 1) + '. ' + stationStopLabel(stop);
                top.appendChild(label);

                let dwellWrap = document.createElement('span');
                dwellWrap.className = 'stop-dwell';
                dwellWrap.title = 'How long a train waits at this stop before departing';
                dwellWrap.style.display = 'inline-flex';
                dwellWrap.style.alignItems = 'center';
                dwellWrap.style.gap = '4px';
                dwellWrap.style.marginLeft = '10px';
                dwellWrap.style.fontSize = '12px';
                dwellWrap.style.color = '#a1a1aa';
                let dwellLabel = document.createElement('label');
                dwellLabel.textContent = 'Dwell';
                let dwellInput = document.createElement('input');
                dwellInput.type = 'number';
                dwellInput.min = '0';
                dwellInput.step = '5';
                dwellInput.className = 'stop-dwell-input';
                dwellInput.style.width = '56px';
                dwellInput.value = (typeof stop.dwellSeconds === 'number') ? stop.dwellSeconds : DEFAULT_DWELL_SECONDS;
                dwellInput.addEventListener('input', () => {
                    let v = parseInt(dwellInput.value, 10);
                    stop.dwellSeconds = (isNaN(v) || v < 0) ? 0 : v;
                });
                let dwellUnit = document.createElement('span');
                dwellUnit.textContent = 's';
                dwellWrap.appendChild(dwellLabel);
                dwellWrap.appendChild(dwellInput);
                dwellWrap.appendChild(dwellUnit);
                top.appendChild(dwellWrap);

                let upBtn = document.createElement('button');
                upBtn.textContent = '↑';
                upBtn.disabled = idx === 0;
                upBtn.addEventListener('click', () => {
                    [line.stops[idx - 1], line.stops[idx]] = [line.stops[idx], line.stops[idx - 1]];
                    render(); draw();
                });

                let downBtn = document.createElement('button');
                downBtn.textContent = '↓';
                downBtn.disabled = idx === line.stops.length - 1;
                downBtn.addEventListener('click', () => {
                    [line.stops[idx + 1], line.stops[idx]] = [line.stops[idx], line.stops[idx + 1]];
                    render(); draw();
                });

                let rmBtn = document.createElement('button');
                rmBtn.textContent = '✕';
                rmBtn.title = 'Remove this whole station stop';
                rmBtn.addEventListener('click', () => {
                    line.stops.splice(idx, 1);
                    render(); draw();
                });

                top.appendChild(upBtn);
                top.appendChild(downBtn);
                top.appendChild(rmBtn);
                row.appendChild(top);

                // Platform chips - a stop normally holds one platform, but can
                // hold several at the same station (e.g. a no-turnback terminus
                // with separate arrival/departure platforms). Each platform can
                // be individually removed from the stop without deleting the
                // whole station stop.
                let chipsWrap = document.createElement('div');
                chipsWrap.className = 'stop-platforms';
                getStopPlatforms(stop).forEach(plat => {
                    let chip = document.createElement('span');
                    chip.className = 'stop-platform-chip';
                    let chipLabel = document.createElement('span');
                    chipLabel.textContent = platformLabel(plat);
                    chip.appendChild(chipLabel);
                    let chipRm = document.createElement('button');
                    chipRm.textContent = '✕';
                    chipRm.title = 'Remove this platform from the stop';
                    chipRm.addEventListener('click', () => {
                        stop.platformIds = stop.platformIds.filter(id => id !== plat.id);
                        if (stop.platformIds.length === 0) {
                            line.stops.splice(idx, 1);
                        }
                        render(); draw();
                    });
                    chip.appendChild(chipRm);
                    chipsWrap.appendChild(chip);
                });
                row.appendChild(chipsWrap);

                list.appendChild(row);
            });
            entry.appendChild(list);
            body.appendChild(entry);
        });
    }

    render();
    overlay.classList.remove('hidden');
}

document.getElementById('line-modal-close').addEventListener('click', () => {
    document.getElementById('line-modal-overlay').classList.add('hidden');
    refreshLineSelect();
    draw();
});

// --- Demand Editor ---
// Passenger demand is modeled per demand group (a rider purpose, e.g. "To Work"),
// per station (identified by stationCode, shared across that station's platforms).
// Each group/station pair has two independent freeform demand curves: "attract"
// (pulls this group's passengers here as a destination, as a relative weight)
// and "inflow" (spawns this group's passengers here as an origin, in
// passengers/minute). Each curve is just a set of user-placed
// points on a 24-hour graph - the demand at any moment is the straight-line
// interpolation between the two points either side of it. See the Demand doc
// comment at the top of this file for the full data shape.

const SVGNS = 'http://www.w3.org/2000/svg';

// Graph layout constants (viewBox units, scaled to fit by CSS).
const DEMAND_GRAPH_PAD_LEFT = 42;
const DEMAND_GRAPH_PAD_RIGHT = 10;
const DEMAND_GRAPH_PAD_TOP = 10;
const DEMAND_GRAPH_PAD_BOTTOM = 20;
const DEMAND_GRAPH_PLOT_W = 620;
const DEMAND_GRAPH_PLOT_H = 190;
const DEMAND_GRAPH_W = DEMAND_GRAPH_PAD_LEFT + DEMAND_GRAPH_PLOT_W + DEMAND_GRAPH_PAD_RIGHT;
const DEMAND_GRAPH_H = DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H + DEMAND_GRAPH_PAD_BOTTOM;
const DEMAND_DAY_MINUTES = 24 * 60 - 1; // 1439 - matches the "2359" max clock value

// "Nice" round numbers the Y-axis ceiling snaps to. The axis has no fixed cap -
// it auto-expands to whichever of these is the smallest one still >= the
// largest value currently on the curve (or the curve's default floor), so
// plotting a big spike just grows the scale instead of clipping it.
const DEMAND_GRAPH_NICE_STEPS = [5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];
function niceAxisMax(v) {
    for (let step of DEMAND_GRAPH_NICE_STEPS) {
        if (step >= v) return step;
    }
    return Math.ceil(v / 1000) * 1000;
}

// Tracks the document-level mousemove/mouseup listeners each open graph editor
// installs, so they can be torn down before the Demand Editor rebuilds its DOM
// (otherwise every re-render would leak another pair of listeners).
let demandGraphCleanupFns = [];

function getStationCodes() {
    let set = new Set();
    state.platforms.forEach(p => {
        if (p.stationCode && p.stationCode.trim() !== '') set.add(p.stationCode);
    });
    return Array.from(set).sort();
}

// Clamps/reformats a user-typed time string into a strict "HHMM" (0000-2359).
// Falls back to the previous value if what was typed can't be salvaged at all.
function sanitizeHHMM(val, fallback) {
    if (typeof val !== 'string') return fallback;
    let digits = val.replace(/[^0-9]/g, '');
    if (digits === '') return fallback;
    digits = digits.padStart(4, '0').substr(-4);
    let hh = parseInt(digits.substr(0, 2), 10);
    let mm = parseInt(digits.substr(2, 2), 10);
    if (isNaN(hh) || isNaN(mm)) return fallback;
    hh = Math.max(0, Math.min(23, hh));
    mm = Math.max(0, Math.min(59, mm));
    return String(hh).padStart(2, '0') + String(mm).padStart(2, '0');
}

function hhmmToMinutes(hhmm) {
    let s = sanitizeHHMM(hhmm, '0000');
    return parseInt(s.substr(0, 2), 10) * 60 + parseInt(s.substr(2, 2), 10);
}

function minutesToHHMM(mins) {
    mins = Math.max(0, Math.min(DEMAND_DAY_MINUTES, Math.round(mins)));
    let hh = Math.floor(mins / 60);
    let mm = mins % 60;
    return String(hh).padStart(2, '0') + String(mm).padStart(2, '0');
}

function newDemandPoint(time, value) {
    return { id: generateId(), time: time, value: value };
}

// Accepts either an already point-based curve (backfills ids/defaults) or an
// older time-window/shape/intensity curve from a previous version of this tool,
// and returns a plain array of DemandPoints either way - sampling old windows
// into a handful of points that approximate their shape.
function migrateCurveArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    let sample = arr[0];
    if (sample && typeof sample.shape === 'undefined' && typeof sample.value !== 'undefined') {
        arr.forEach(pt => {
            if (!pt.id) pt.id = generateId();
            pt.time = sanitizeHHMM(pt.time, '0000');
            let v = parseFloat(pt.value);
            pt.value = isNaN(v) ? 0 : Math.max(0, v);
        });
        return arr;
    }
    let points = [];
    arr.forEach(seg => {
        let startMin = hhmmToMinutes(seg.start || '0000');
        let endMin = hhmmToMinutes(seg.end || '2359');
        let midMin = Math.round((startMin + endMin) / 2);
        let intensity = Math.max(0, (typeof seg.intensity === 'number') ? seg.intensity : 50);
        if (seg.shape === 'valley') {
            points.push(newDemandPoint(minutesToHHMM(startMin), intensity));
            points.push(newDemandPoint(minutesToHHMM(midMin), Math.round(intensity * 0.3)));
            points.push(newDemandPoint(minutesToHHMM(endMin), intensity));
        } else if (seg.shape === 'random') {
            points.push(newDemandPoint(minutesToHHMM(startMin), intensity));
            points.push(newDemandPoint(minutesToHHMM(midMin), Math.round(intensity * 0.6)));
            points.push(newDemandPoint(minutesToHHMM(endMin), intensity));
        } else {
            points.push(newDemandPoint(minutesToHHMM(startMin), 0));
            points.push(newDemandPoint(minutesToHHMM(midMin), intensity));
            points.push(newDemandPoint(minutesToHHMM(endMin), 0));
        }
    });
    return points;
}

function ensureGroupStationDemand(group, stationCode) {
    if (!group.stationDemand) group.stationDemand = {};
    if (!group.stationDemand[stationCode]) {
        group.stationDemand[stationCode] = { attract: [], inflow: [] };
    }
    let sd = group.stationDemand[stationCode];
    sd.attract = migrateCurveArray(sd.attract);
    sd.inflow = migrateCurveArray(sd.inflow);
    return sd;
}

// Re-renders the Demand Editor's contents only if it's currently open - used
// after edits made elsewhere (e.g. renaming a platform's station code) that
// could change what the editor should be showing.
function refreshDemandEditorIfOpen() {
    let overlay = document.getElementById('demand-modal-overlay');
    if (overlay && !overlay.classList.contains('hidden')) renderDemandEditor();
}

function openDemandEditor() {
    const overlay = document.getElementById('demand-modal-overlay');
    const tInput = document.getElementById('demand-transfer-aversion');
    const tVal = document.getElementById('demand-transfer-aversion-val');
    tInput.value = state.demand.transferAversion;
    tVal.textContent = state.demand.transferAversion;

    if (!demandActiveGroupId && state.demand.groups.length) {
        demandActiveGroupId = state.demand.groups[0].id;
    }
    renderDemandEditor();
    overlay.classList.remove('hidden');
}

function renderDemandEditor() {
    renderDemandGroupsList();
    renderDemandMainCol();
}

function renderDemandGroupsList() {
    const listEl = document.getElementById('demand-groups-list');
    listEl.innerHTML = '';
    if (state.demand.groups.length === 0) {
        let p = document.createElement('p');
        p.className = 'demand-empty-note';
        p.textContent = 'No groups yet.';
        listEl.appendChild(p);
        return;
    }
    state.demand.groups.forEach(group => {
        const item = document.createElement('div');
        item.className = 'demand-group-item' + (group.id === demandActiveGroupId ? ' active' : '');
        item.addEventListener('click', () => {
            demandActiveGroupId = group.id;
            renderDemandEditor();
        });

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'swatch';
        colorInput.value = group.color || '#3b82f6';
        colorInput.style.cssText = 'width:16px;height:16px;padding:0;border:none;';
        colorInput.addEventListener('click', (e) => e.stopPropagation());
        colorInput.addEventListener('input', () => { group.color = colorInput.value; });

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'gname';
        nameInput.value = group.name || '';
        nameInput.style.cssText = 'flex-grow:1;min-width:0;background:transparent;border:none;color:#e4e4e7;font-size:13px;padding:0;';
        nameInput.addEventListener('click', (e) => e.stopPropagation());
        nameInput.addEventListener('change', () => { group.name = nameInput.value.trim() || 'Unnamed Group'; });

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Delete Group';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirm('Delete demand group "' + (group.name || 'Unnamed Group') + '"?')) return;
            state.demand.groups = state.demand.groups.filter(g => g.id !== group.id);
            if (demandActiveGroupId === group.id) {
                demandActiveGroupId = state.demand.groups.length ? state.demand.groups[0].id : null;
            }
            renderDemandEditor();
        });

        item.appendChild(colorInput);
        item.appendChild(nameInput);
        item.appendChild(delBtn);
        listEl.appendChild(item);
    });
}

function renderDemandMainCol() {
    // Tear down any listeners the previously-rendered graphs installed before
    // we throw away their DOM and build fresh ones below.
    demandGraphCleanupFns.forEach(fn => fn());
    demandGraphCleanupFns = [];

    const col = document.getElementById('demand-main-col');
    col.innerHTML = '';

    const group = state.demand.groups.find(g => g.id === demandActiveGroupId);
    if (!group) {
        let p = document.createElement('p');
        p.className = 'demand-no-station-note';
        p.textContent = 'Select or create a group to edit its demand.';
        col.appendChild(p);
        return;
    }

    const stationCodes = getStationCodes();
    if (stationCodes.length === 0) {
        let p = document.createElement('p');
        p.className = 'demand-no-station-note';
        p.textContent = 'No stations yet - add platforms with a Station Code first.';
        col.appendChild(p);
        return;
    }

    if (!demandActiveStationCode || !stationCodes.includes(demandActiveStationCode)) {
        demandActiveStationCode = stationCodes[0];
    }

    const select = document.createElement('select');
    select.className = 'demand-station-select';
    stationCodes.forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code;
        if (code === demandActiveStationCode) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', () => {
        demandActiveStationCode = select.value;
        renderDemandMainCol();
    });
    col.appendChild(select);

    const stationDemand = ensureGroupStationDemand(group, demandActiveStationCode);

    col.appendChild(buildDemandGraphEditor(
        'Attract Demand (' + group.name + ' relative pull TOWARDS this station)',
        stationDemand.attract,
        'weight',
        10
    ));

    col.appendChild(buildDemandGraphEditor(
        'Inflow Demand (' + group.name + ' passengers spawned AT this station)',
        stationDemand.inflow,
        'passengers/min',
        60
    ));
}

// Builds one freeform demand-curve graph editor. `points` is the live array
// reference from state - it's mutated directly as the user clicks/drags, so
// nothing needs to be passed back up to the caller. `unitLabel` is shown as
// the curve's unit (e.g. "passengers/min", "weight"). `floorMax` is the
// smallest the Y-axis ceiling will ever auto-shrink to (so an empty or
// low-valued curve still gets a sensibly-sized graph instead of a sliver);
// the axis grows past it automatically once a plotted point exceeds it.
function buildDemandGraphEditor(title, points, unitLabel, floorMax) {
    const box = document.createElement('div');
    box.className = 'demand-curve-box';

    const titleEl = document.createElement('div');
    titleEl.className = 'demand-section-title';
    titleEl.textContent = title;
    box.appendChild(titleEl);

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + DEMAND_GRAPH_W + ' ' + DEMAND_GRAPH_H);
    svg.setAttribute('class', 'demand-graph-svg');
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.display = 'block';
    svg.style.cursor = 'crosshair';

    const bg = document.createElementNS(SVGNS, 'rect');
    bg.setAttribute('x', DEMAND_GRAPH_PAD_LEFT);
    bg.setAttribute('y', DEMAND_GRAPH_PAD_TOP);
    bg.setAttribute('width', DEMAND_GRAPH_PLOT_W);
    bg.setAttribute('height', DEMAND_GRAPH_PLOT_H);
    bg.setAttribute('fill', '#101012');
    bg.setAttribute('stroke', '#2e2e33');
    svg.appendChild(bg);

    // Rebuilt every redraw() since the Y-axis ceiling (and therefore its
    // gridlines/labels) auto-scales to whatever is currently plotted.
    const gridGroup = document.createElementNS(SVGNS, 'g');
    svg.appendChild(gridGroup);

    const polyline = document.createElementNS(SVGNS, 'polyline');
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', '#3b82f6');
    polyline.setAttribute('stroke-width', '2');
    svg.appendChild(polyline);

    const pointsGroup = document.createElementNS(SVGNS, 'g');
    svg.appendChild(pointsGroup);

    box.appendChild(svg);

    const hint = document.createElement('div');
    hint.className = 'demand-hint';
    hint.textContent = 'Click empty space to add a point, drag a point to move it, double-click a point to delete it. Unit: ' + unitLabel + '.';
    box.appendChild(hint);

    const pointEditor = document.createElement('div');
    pointEditor.className = 'demand-point-editor';
    box.appendChild(pointEditor);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear All Points';
    clearBtn.style.marginTop = '8px';
    clearBtn.addEventListener('click', () => {
        if (points.length === 0) return;
        if (!confirm('Clear all points on this curve?')) return;
        points.length = 0;
        selectedPoint = null;
        redraw();
    });
    box.appendChild(clearBtn);

    let draggingPoint = null;
    let selectedPoint = null;
    let axisMax = floorMax; // recomputed at the top of every redraw()

    function svgCoordsFromEvent(e) {
        let rect = svg.getBoundingClientRect();
        let scaleX = DEMAND_GRAPH_W / rect.width;
        let scaleY = DEMAND_GRAPH_H / rect.height;
        return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
    }

    function clampToPlot(coords) {
        return {
            x: Math.max(DEMAND_GRAPH_PAD_LEFT, Math.min(DEMAND_GRAPH_PAD_LEFT + DEMAND_GRAPH_PLOT_W, coords.x)),
            y: Math.max(DEMAND_GRAPH_PAD_TOP, Math.min(DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H, coords.y))
        };
    }

    // Trims a tick value to at most one decimal place, dropping a trailing ".0".
    function formatAxisTick(v) {
        let rounded = Math.round(v * 10) / 10;
        return (rounded % 1 === 0) ? String(rounded) : rounded.toFixed(1);
    }

    function renderYAxisGrid() {
        gridGroup.innerHTML = '';
        [0, 0.25, 0.5, 0.75, 1].forEach(frac => {
            let v = axisMax * frac;
            let y = demandValueToY(v, axisMax);
            let line = document.createElementNS(SVGNS, 'line');
            line.setAttribute('x1', DEMAND_GRAPH_PAD_LEFT);
            line.setAttribute('x2', DEMAND_GRAPH_PAD_LEFT + DEMAND_GRAPH_PLOT_W);
            line.setAttribute('y1', y);
            line.setAttribute('y2', y);
            line.setAttribute('stroke', '#28282c');
            gridGroup.appendChild(line);

            let label = document.createElementNS(SVGNS, 'text');
            label.setAttribute('x', DEMAND_GRAPH_PAD_LEFT - 5);
            label.setAttribute('y', y + 3);
            label.setAttribute('text-anchor', 'end');
            label.setAttribute('font-size', '9');
            label.setAttribute('fill', '#71717a');
            label.textContent = formatAxisTick(v);
            gridGroup.appendChild(label);
        });
        for (let h = 0; h <= 24; h += 3) {
            let mins = Math.min(DEMAND_DAY_MINUTES, h * 60);
            let x = demandTimeToX(mins);
            let line = document.createElementNS(SVGNS, 'line');
            line.setAttribute('x1', x);
            line.setAttribute('x2', x);
            line.setAttribute('y1', DEMAND_GRAPH_PAD_TOP);
            line.setAttribute('y2', DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H);
            line.setAttribute('stroke', '#28282c');
            gridGroup.appendChild(line);

            let label = document.createElementNS(SVGNS, 'text');
            label.setAttribute('x', x);
            label.setAttribute('y', DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H + 13);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('font-size', '9');
            label.setAttribute('fill', '#71717a');
            label.textContent = String(h).padStart(2, '0') + ':00';
            gridGroup.appendChild(label);
        }
        // Unit annotation, tucked into the plot's top-left corner.
        let unitLbl = document.createElementNS(SVGNS, 'text');
        unitLbl.setAttribute('x', DEMAND_GRAPH_PAD_LEFT + 6);
        unitLbl.setAttribute('y', DEMAND_GRAPH_PAD_TOP + 12);
        unitLbl.setAttribute('font-size', '9');
        unitLbl.setAttribute('fill', '#52525b');
        unitLbl.textContent = unitLabel;
        gridGroup.appendChild(unitLbl);
    }

    function renderPointEditor() {
        pointEditor.innerHTML = '';
        if (!selectedPoint || !points.includes(selectedPoint)) {
            pointEditor.style.display = 'none';
            return;
        }
        pointEditor.style.display = 'flex';

        const timeLabel = document.createElement('label');
        timeLabel.textContent = 'Time';
        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.className = 'dc-time';
        timeInput.maxLength = 4;
        timeInput.value = selectedPoint.time;
        timeInput.addEventListener('change', () => {
            selectedPoint.time = sanitizeHHMM(timeInput.value, selectedPoint.time);
            redraw();
        });

        const valLabel = document.createElement('label');
        valLabel.textContent = 'Value (' + unitLabel + ')';
        const valInput = document.createElement('input');
        valInput.type = 'number';
        valInput.className = 'dc-intensity';
        valInput.min = 0; valInput.step = 'any';
        valInput.value = selectedPoint.value;
        valInput.addEventListener('change', () => {
            let v = parseFloat(valInput.value);
            selectedPoint.value = isNaN(v) ? 0 : Math.max(0, v);
            redraw();
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete Point';
        delBtn.addEventListener('click', () => {
            let idx = points.indexOf(selectedPoint);
            if (idx !== -1) points.splice(idx, 1);
            selectedPoint = null;
            redraw();
        });

        pointEditor.appendChild(timeLabel);
        pointEditor.appendChild(timeInput);
        pointEditor.appendChild(valLabel);
        pointEditor.appendChild(valInput);
        pointEditor.appendChild(delBtn);
    }

    function redraw() {
        points.sort((a, b) => hhmmToMinutes(a.time) - hhmmToMinutes(b.time));

        let highestPlotted = points.reduce((m, p) => Math.max(m, p.value), 0);
        axisMax = niceAxisMax(Math.max(floorMax, highestPlotted));
        renderYAxisGrid();

        polyline.setAttribute('points', points.map(p =>
            demandTimeToX(hhmmToMinutes(p.time)) + ',' + demandValueToY(p.value, axisMax)
        ).join(' '));

        pointsGroup.innerHTML = '';
        points.forEach(p => {
            let circle = document.createElementNS(SVGNS, 'circle');
            circle.setAttribute('cx', demandTimeToX(hhmmToMinutes(p.time)));
            circle.setAttribute('cy', demandValueToY(p.value, axisMax));
            circle.setAttribute('r', (selectedPoint === p) ? 6 : 4.5);
            circle.setAttribute('fill', (selectedPoint === p) ? '#f59e0b' : '#3b82f6');
            circle.setAttribute('stroke', '#e4e4e7');
            circle.setAttribute('stroke-width', '1.5');
            circle.style.cursor = 'grab';
            circle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                draggingPoint = p;
            });
            circle.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                let idx = points.indexOf(p);
                if (idx !== -1) points.splice(idx, 1);
                if (selectedPoint === p) selectedPoint = null;
                redraw();
            });
            pointsGroup.appendChild(circle);
        });

        renderPointEditor();
    }

    svg.addEventListener('mousedown', (e) => {
        if (e.target !== bg) return; // clicks on points/labels are handled by their own listeners
        let c = clampToPlot(svgCoordsFromEvent(e));
        let newPoint = newDemandPoint(minutesToHHMM(demandXToTime(c.x)), demandYToValue(c.y, axisMax));
        points.push(newPoint);
        draggingPoint = newPoint;
        selectedPoint = newPoint;
        redraw();
    });

    function onMove(e) {
        if (!draggingPoint) return;
        let c = clampToPlot(svgCoordsFromEvent(e));
        draggingPoint.time = minutesToHHMM(demandXToTime(c.x));
        draggingPoint.value = demandYToValue(c.y, axisMax);
        redraw();
    }
    function onUp() {
        if (draggingPoint) {
            selectedPoint = draggingPoint;
            draggingPoint = null;
            redraw();
        }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    demandGraphCleanupFns.push(() => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    });

    redraw();
    return box;
}

function demandTimeToX(mins) {
    return DEMAND_GRAPH_PAD_LEFT + (mins / DEMAND_DAY_MINUTES) * DEMAND_GRAPH_PLOT_W;
}
function demandXToTime(x) {
    return Math.max(0, Math.min(DEMAND_DAY_MINUTES, Math.round(((x - DEMAND_GRAPH_PAD_LEFT) / DEMAND_GRAPH_PLOT_W) * DEMAND_DAY_MINUTES)));
}
function demandValueToY(val, axisMax) {
    let clamped = Math.max(0, Math.min(axisMax, val));
    return DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H - (clamped / axisMax) * DEMAND_GRAPH_PLOT_H;
}
function demandYToValue(y, axisMax) {
    let raw = ((DEMAND_GRAPH_PAD_TOP + DEMAND_GRAPH_PLOT_H - y) / DEMAND_GRAPH_PLOT_H) * axisMax;
    // Round to a step that's fine near the bottom of small-scale curves (like
    // "weight") but doesn't force awkward fractions on large ones. toFixed()
    // afterwards mops up float noise (e.g. 0.1 steps producing 5.300000000000001).
    let step = axisMax > 100 ? 1 : (axisMax > 20 ? 0.5 : 0.1);
    let decimals = step < 1 ? 1 : 0;
    let stepped = parseFloat((Math.round(raw / step) * step).toFixed(decimals));
    return Math.max(0, Math.min(axisMax, stepped));
}

document.getElementById('btn-demand').addEventListener('click', () => {
    openDemandEditor();
});

document.getElementById('demand-modal-close').addEventListener('click', () => {
    document.getElementById('demand-modal-overlay').classList.add('hidden');
});

document.getElementById('demand-transfer-aversion').addEventListener('input', (e) => {
    state.demand.transferAversion = parseInt(e.target.value, 10);
    document.getElementById('demand-transfer-aversion-val').textContent = state.demand.transferAversion;
});

document.getElementById('demand-add-group-btn').addEventListener('click', () => {
    const nameInput = document.getElementById('demand-new-group-name');
    const colorInput = document.getElementById('demand-new-group-color');
    let name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const group = { id: generateId(), name, color: colorInput.value || '#3b82f6', stationDemand: {} };
    state.demand.groups.push(group);
    demandActiveGroupId = group.id;
    nameInput.value = '';
    renderDemandEditor();
});

document.getElementById('btn-export').addEventListener('click', () => {
    const data = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
    const a = document.createElement('a');
    a.href = data; a.download = "track_diagram.json"; a.click();
});

document.getElementById('btn-import-trigger').addEventListener('click', () => {
    document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            state = JSON.parse(e.target.result);
            // Migrate diagrams exported before the Map Settings (name/
            // description/start time) feature existed - default them in
            // rather than leaving the diagram without a `meta` object.
            if (!state.meta || typeof state.meta !== 'object') state.meta = {};
            if (typeof state.meta.name !== 'string') state.meta.name = '';
            if (typeof state.meta.description !== 'string') state.meta.description = '';
            if (typeof state.meta.startTime !== 'string' || !/^\d{2}:\d{2}$/.test(state.meta.startTime)) {
                state.meta.startTime = '05:50';
            }
            if (!state.signals) state.signals = [];
            if (!state.platforms) state.platforms = [];
            if (!state.tracks) state.tracks = [];
            if (!state.points) state.points = [];
            if (!state.labels) state.labels = [];
            if (!state.lines) state.lines = [];
            if (!state.demand) state.demand = { transferAversion: 70, groups: [] };
            if (typeof state.demand.transferAversion !== 'number') state.demand.transferAversion = 70;
            if (!state.demand.groups) state.demand.groups = [];
            state.demand.groups.forEach(g => {
                if (!g.stationDemand) g.stationDemand = {};
                Object.keys(g.stationDemand).forEach(code => {
                    let sd = g.stationDemand[code];
                    sd.attract = migrateCurveArray(sd.attract || []);
                    sd.inflow = migrateCurveArray(sd.inflow || []);
                });
            });
            // Migrate older diagrams where distance was a free-form string
            // (e.g. "3.2 km") into a plain number of meters.
            state.tracks.forEach(t => {
                if (typeof t.distance === 'string') {
                    let n = parseFloat(t.distance);
                    if (!isNaN(n)) {
                        if (/km/i.test(t.distance)) n *= 1000;
                        t.distance = Math.round(n);
                    } else {
                        delete t.distance;
                    }
                }
                if (!t.oneway) t.oneway = 'none';
            });
            // Migrate older diagrams where a line's stops were a flat list of
            // platform ids into the current { id, platformIds: [...] } stop
            // objects (one platform per stop, same as the old behavior).
            state.lines.forEach(ln => {
                if (!ln.stops) { ln.stops = []; return; }
                ln.stops = ln.stops.map(s => {
                    if (typeof s === 'string') return { id: generateId(), platformIds: [s] };
                    if (!s.platformIds) s.platformIds = s.platformId ? [s.platformId] : [];
                    return s;
                });
                // Migrate older diagrams saved before per-stop dwell time existed.
                ln.stops.forEach(s => {
                    if (typeof s.dwellSeconds !== 'number' || !isFinite(s.dwellSeconds) || s.dwellSeconds < 0) {
                        s.dwellSeconds = DEFAULT_DWELL_SECONDS;
                    }
                });
            });
            activeLineId = null;
            selectedElement = null;
            demandActiveGroupId = null;
            demandActiveStationCode = null;
            refreshLineSelect();
            updateMapSettingsButton();
            updateUI(); draw();
        } catch (err) { alert("Invalid JSON file."); }
    };
    reader.readAsText(file);
    event.target.value = null;
});

// --- Canvas Mouse Events ---

canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    let wPos = screenToWorld(sx, sy);
    let snappedPt = snapPointToGrid(wPos.x, wPos.y);
    let snappedX = snappedPt.x;
    let snappedY = snappedPt.y;

    if (e.button === 2) {
        isDraggingCamera = true;
        lastMouse = { x: sx, y: sy };
        return;
    }

    if (e.button === 0) {
        if (mode === 'select') {
            selectedElement = findHoverElement(wPos.x, wPos.y);
            updateUI();
            if (selectedElement && selectedElement.type === 'point') {
                dragPointId = selectedElement.id;
            } else if (selectedElement && selectedElement.type === 'signal') {
                let s = state.signals.find(sg => sg.id === selectedElement.id);
                if (s) {
                    dragSignalId = s.id;
                    dragSignalStart = {
                        mouseWX: wPos.x, mouseWY: wPos.y,
                        offsetX: (s.dragOffset && s.dragOffset.x) || 0,
                        offsetY: (s.dragOffset && s.dragOffset.y) || 0
                    };
                }
            } else if (selectedElement && selectedElement.type === 'label') {
                dragLabelId = selectedElement.id;
            }
        } 
        else if (mode === 'delete') {
            let el = findHoverElement(wPos.x, wPos.y);
            if (el) deleteElement(el);
        }
        else if (mode === 'track') {
            let existingPt = getPointAt(snappedX, snappedY);
            if (!existingPt) {
                existingPt = { id: generateId(), x: snappedX, y: snappedY };
                state.points.push(existingPt);
            }
            isDrawing = true;
            drawStartPoint = existingPt;
        }
        else if (mode === 'split' && trackProjection && trackProjection.distToMouse < 30) {
            let t = trackProjection.track;
            let len = Math.hypot(getPoint(t.p2_id).x - getPoint(t.p1_id).x, getPoint(t.p2_id).y - getPoint(t.p1_id).y);
            
            if (trackProjection.t_dist > 0 && trackProjection.t_dist < len) {
                let existingPt = getPointAt(trackProjection.cx, trackProjection.cy);
                if (!existingPt) {
                    existingPt = { id: generateId(), x: trackProjection.cx, y: trackProjection.cy };
                    state.points.push(existingPt);
                }
                
                let t2_id = generateId();
                let old_p2 = t.p2_id;
                let origP1 = getPoint(t.p1_id);
                let origP2 = getPoint(old_p2);
                let len1 = Math.hypot(existingPt.x - origP1.x, existingPt.y - origP1.y);
                let len2 = Math.hypot(origP2.x - existingPt.x, origP2.y - existingPt.y);

                t.p2_id = existingPt.id;
                t.distance = Math.round(len1);
                
                state.tracks.push({
                    id: t2_id, p1_id: existingPt.id, p2_id: old_p2, 
                    overpass: t.overpass, color: t.color, distance: Math.round(len2),
                    oneway: t.oneway || 'none'
                });
                
                state.platforms.forEach(p => {
                    if (p.track_id === t.id && p.t_dist > trackProjection.t_dist) {
                        p.track_id = t2_id;
                        p.t_dist -= trackProjection.t_dist;
                    }
                });

                state.signals.forEach(s => {
                    if (s.track_id === t.id && s.t_dist > trackProjection.t_dist) {
                        s.track_id = t2_id;
                        s.t_dist -= trackProjection.t_dist;
                    }
                });
            }
        }
        else if (mode === 'platform' && trackProjection && trackProjection.distToMouse < 60) {
            state.platforms.push({
                id: generateId(), track_id: trackProjection.track.id, t_dist: trackProjection.t_dist,
                side: trackProjection.side, color: document.getElementById('elem-color').value || DEFAULT_PLATFORM_COLOR, number: "1", code: ""
            });
        }
        else if (mode === 'signal') {
            let existingHit = findHoverElement(wPos.x, wPos.y);
            if (existingHit && existingHit.type === 'signal') {
                // Clicked an existing signal while still in "Add Signal" mode - drag it instead of adding a new one.
                let s = state.signals.find(sg => sg.id === existingHit.id);
                if (s) {
                    selectedElement = existingHit;
                    updateUI();
                    dragSignalId = s.id;
                    dragSignalStart = {
                        mouseWX: wPos.x, mouseWY: wPos.y,
                        offsetX: (s.dragOffset && s.dragOffset.x) || 0,
                        offsetY: (s.dragOffset && s.dragOffset.y) || 0
                    };
                }
            } else if (trackProjection && trackProjection.distToMouse < 60) {
                let newSignal = {
                    id: generateId(), track_id: trackProjection.track.id, t_dist: trackProjection.t_dist,
                    side: trackProjection.side, direction: 1, state: 'red'
                };
                state.signals.push(newSignal);
                selectedElement = { type: 'signal', id: newSignal.id };
                updateUI();
            }
        }
        else if (mode === 'label') {
            // Deferred with setTimeout so the modal (and its input focus) is opened
            // *after* this mousedown has fully finished, instead of mid-press. Some
            // browsers can flakily drop focus() calls made on a newly-created input
            // while the mouse button is still down, which made the popup look like it
            // failed to appear or grab keyboard input.
            setTimeout(() => {
                openModal('Add Text Label', [
                    { key: 'text', type: 'text', label: 'Label Text', value: '', placeholder: 'e.g. Junction A' },
                    { key: 'fontSize', type: 'number', label: 'Font Size (px)', value: LABEL_DEFAULT_FONT_SIZE, min: LABEL_MIN_FONT_SIZE, max: LABEL_MAX_FONT_SIZE, step: 1 },
                    { key: 'bgVisible', type: 'checkbox', label: 'Show background', value: true }
                ], (vals) => {
                    if (vals.text && vals.text.trim() !== '') {
                        let fontSize = clampLabelFontSize(vals.fontSize);
                        let newLabel = { id: generateId(), x: snappedX, y: snappedY, text: vals.text, fontSize, bgVisible: !!vals.bgVisible };
                        state.labels.push(newLabel);
                        selectedElement = { type: 'label', id: newLabel.id };
                        updateUI();
                        draw();
                    }
                });
            }, 0);
        }
        else if (mode === 'line') {
            let hit = findHoverElement(wPos.x, wPos.y);
            if (!activeLineId) {
                alert('Pick a line from the dropdown, or click "New Line" first.');
            } else if (hit && hit.type === 'platform') {
                let line = state.lines.find(ln => ln.id === activeLineId);
                let plat = state.platforms.find(p => p.id === hit.id);
                if (line && plat) {
                    let lastStop = line.stops[line.stops.length - 1];
                    let lastPlats = lastStop ? getStopPlatforms(lastStop) : [];
                    // Clicking a platform at the SAME station right after the
                    // current last stop adds it to that stop instead of starting
                    // a new one - this is how a multi-platform stop (e.g. a
                    // no-turnback terminus with separate arrival/departure
                    // platforms) gets built. Hold Shift to force a new stop
                    // even at the same station (e.g. passing through twice on
                    // a loop line).
                    let sameStation = !e.shiftKey && lastStop && plat.stationCode &&
                        lastPlats.length > 0 && lastPlats[0].stationCode === plat.stationCode;
                    if (sameStation) {
                        if (!lastStop.platformIds.includes(hit.id)) {
                            lastStop.platformIds.push(hit.id);
                        }
                    } else {
                        line.stops.push({ id: generateId(), platformIds: [hit.id], dwellSeconds: DEFAULT_DWELL_SECONDS });
                    }
                    selectedElement = hit;
                }
            }
        }
        draw();
    }
});

// mousemove/mouseup are bound to `window` rather than `canvas`. If they were bound to
// the canvas, moving the mouse fast enough to briefly leave the (fairly small) canvas
// element mid-drag - very easy to do when nudging a small signal head, or panning -
// would silently stop the drag dead until the cursor re-entered the canvas. Binding to
// `window` means an in-progress drag/pan/track-draw keeps tracking the mouse anywhere
// on the page, and only lets go on mouseup, which is what users expect from a drag.
window.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const isActiveDrag = isDraggingCamera || dragPointId || dragSignalId || dragLabelId || isDrawing;
    const overCanvas = sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height;

    // When nothing is being dragged, ignore mouse movement that happens outside the
    // canvas (e.g. over the toolbar) so hover/preview state doesn't get updated for a
    // position that isn't actually on the diagram.
    if (!isActiveDrag && !overCanvas) return;

    if (isDraggingCamera) {
        camera.x += (sx - lastMouse.x);
        camera.y += (sy - lastMouse.y);
        lastMouse = { x: sx, y: sy };
        draw();
        return;
    }

    let wPos = screenToWorld(sx, sy);
    currentMouseWorld = snapPointToGrid(wPos.x, wPos.y);

    if (dragPointId) {
        let p = getPoint(dragPointId);
        p.x = currentMouseWorld.x;
        p.y = currentMouseWorld.y;
    } else if (dragSignalId) {
        let s = state.signals.find(sg => sg.id === dragSignalId);
        if (s && dragSignalStart) {
            let dx = wPos.x - dragSignalStart.mouseWX;
            let dy = wPos.y - dragSignalStart.mouseWY;
            s.dragOffset = { x: dragSignalStart.offsetX + dx, y: dragSignalStart.offsetY + dy };
        }
    } else if (dragLabelId) {
        let l = state.labels.find(lb => lb.id === dragLabelId);
        if (l) {
            l.x = currentMouseWorld.x;
            l.y = currentMouseWorld.y;
        }
    } else if (mode === 'select') {
        if (overCanvas) hoverElement = findHoverElement(wPos.x, wPos.y);
    }
    else if (mode === 'delete' || mode === 'line') {
        if (overCanvas) hoverElement = findHoverElement(wPos.x, wPos.y);
    }
    else if (mode === 'platform' || mode === 'split' || mode === 'signal') {
        if (overCanvas) trackProjection = getTrackProjection(wPos.x, wPos.y);
    }
    
    draw();
});

window.addEventListener('mouseup', (e) => {
    if (e.button === 2) { isDraggingCamera = false; return; }

    if (mode === 'select' && dragPointId) {
        let p = getPoint(dragPointId);
        let others = state.points.filter(pt => pt.x === p.x && pt.y === p.y && pt.id !== p.id);
        if (others.length > 0) {
            let targetId = others[0].id;
            state.tracks.forEach(t => {
                if (t.p1_id === p.id) t.p1_id = targetId;
                if (t.p2_id === p.id) t.p2_id = targetId;
            });
            cleanupOrphanPoints();
        }
        dragPointId = null;
    }
    dragSignalId = null;
    dragSignalStart = null;
    dragLabelId = null;
    
    if (isDrawing && mode === 'track') {
        if (drawStartPoint.x !== currentMouseWorld.x || drawStartPoint.y !== currentMouseWorld.y) {
            let existingPt = getPointAt(currentMouseWorld.x, currentMouseWorld.y);
            if (!existingPt) {
                existingPt = { id: generateId(), x: currentMouseWorld.x, y: currentMouseWorld.y };
                state.points.push(existingPt);
            }
            let exists = state.tracks.some(t => 
                (t.p1_id === drawStartPoint.id && t.p2_id === existingPt.id) ||
                (t.p2_id === drawStartPoint.id && t.p1_id === existingPt.id)
            );
            if (!exists) {
                let len = Math.hypot(existingPt.x - drawStartPoint.x, existingPt.y - drawStartPoint.y);
                state.tracks.push({
                    id: generateId(), p1_id: drawStartPoint.id, p2_id: existingPt.id,
                    overpass: false, color: document.getElementById('elem-color').value || DEFAULT_TRACK_COLOR,
                    distance: Math.round(len), oneway: 'none'
                });
            }
        } else {
            cleanupOrphanPoints();
        }
    }

    isDrawing = false;
    drawStartPoint = null;
    draw();
});

canvas.addEventListener('contextmenu', e => e.preventDefault());
// Also guard the page-level contextmenu in case a right-click pan ends with the
// cursor outside the canvas (now possible since panning tracks via `window`).
window.addEventListener('contextmenu', e => { if (isDraggingCamera) e.preventDefault(); });

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    
    let zoomAmount = e.deltaY > 0 ? 0.9 : 1.1;
    let newZoom = camera.zoom * zoomAmount;
    
    let wPos = screenToWorld(sx, sy);
    camera.x = sx - wPos.x * newZoom;
    camera.y = sy - wPos.y * newZoom;
    camera.zoom = newZoom;
    
    draw();
});

// --- Drawing Loop ---

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    // 1. Draw Grid
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = 1 / camera.zoom;
    let left = -camera.x / camera.zoom;
    let top = -camera.y / camera.zoom;
    let right = left + canvas.width / camera.zoom;
    let bottom = top + canvas.height / camera.zoom;
    
    ctx.beginPath();
    if (!diagonalGrid) {
        for (let x = Math.floor(left / gridSize) * gridSize; x < right; x += gridSize) {
            ctx.moveTo(x, top); ctx.lineTo(x, bottom);
        }
        for (let y = Math.floor(top / gridSize) * gridSize; y < bottom; y += gridSize) {
            ctx.moveTo(left, y); ctx.lineTo(right, y);
        }
    } else {
        // Grid rotated 45 degrees: two families of diagonal lines (x-y=c and x+y=c)
        let step = gridSize * Math.SQRT2;
        let corners = [[left, top], [right, top], [left, bottom], [right, bottom]];
        let diffs = corners.map(([x, y]) => x - y);
        let sums = corners.map(([x, y]) => x + y);
        let diffMin = Math.floor(Math.min(...diffs) / step) * step;
        let diffMax = Math.ceil(Math.max(...diffs) / step) * step;
        let sumMin = Math.floor(Math.min(...sums) / step) * step;
        let sumMax = Math.ceil(Math.max(...sums) / step) * step;

        for (let c = diffMin; c <= diffMax; c += step) {
            // x - y = c  =>  y = x - c
            ctx.moveTo(left, left - c);
            ctx.lineTo(right, right - c);
        }
        for (let c = sumMin; c <= sumMax; c += step) {
            // x + y = c  =>  y = c - x
            ctx.moveTo(left, c - left);
            ctx.lineTo(right, c - right);
        }
    }
    ctx.stroke();

    // 2. Draw Platforms
    const renderPlatform = (geom, color, number, code, isSel, isHov, isPhantom) => {
        ctx.save();
        ctx.translate(geom.px, geom.py);
        ctx.rotate(geom.angle);
        
        ctx.globalAlpha = isPhantom ? 0.4 : 1.0;
        
        if (isSel) {
            ctx.fillStyle = color;
            ctx.strokeStyle = '#2563eb';
            ctx.lineWidth = 3;
            // Draw a subtle selection glow
            ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 10;
        } else {
            ctx.fillStyle = color;
            ctx.strokeStyle = isHov ? '#60a5fa' : '#9ca3af';
            ctx.lineWidth = 2;
        }
        
        ctx.fillRect(-PLAT_LENGTH/2, -PLAT_WIDTH/2, PLAT_LENGTH, PLAT_WIDTH);
        ctx.shadowBlur = 0; // Reset shadow for stroke & text
        ctx.strokeRect(-PLAT_LENGTH/2, -PLAT_WIDTH/2, PLAT_LENGTH, PLAT_WIDTH);

        ctx.fillStyle = '#374151';
        if (code) {
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(number, 0, -6);
            ctx.font = '10px sans-serif';
            ctx.fillText(code, 0, 8);
        } else {
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(number, 0, 0);
        }
        ctx.restore();
    };

    for (let p of state.platforms) {
        let geom = getPlatformGeom(p);
        if (!geom) continue;
        
        let isSel = (selectedElement && selectedElement.id === p.id);
        let isHov = (hoverElement && hoverElement.id === p.id);
        let col = p.color || DEFAULT_PLATFORM_COLOR;
        if (mode === 'delete' && isHov) col = '#fca5a5';
        
        renderPlatform(geom, col, p.number, p.code, isSel, isHov, false);
    }

    if (mode === 'platform' && trackProjection && trackProjection.distToMouse < 60) {
        let nx = -Math.sin(trackProjection.angle);
        let ny = Math.cos(trackProjection.angle);
        let px = trackProjection.cx + nx * trackProjection.side * PLAT_OFFSET;
        let py = trackProjection.cy + ny * trackProjection.side * PLAT_OFFSET;
        renderPlatform({ px, py, angle: trackProjection.angle }, document.getElementById('elem-color').value || DEFAULT_PLATFORM_COLOR, '+', '', false, false, true);
    }

    // 3. Draw Tracks
    // 3a. Depot underlay - a dashed amber highlight beneath any track marked as a depot
    for (let t of state.tracks) {
        if (!t.isDepot) continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 7;
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    // 3a2. One-way arrow markers + turnback markers
    for (let t of state.tracks) {
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        let dx = p2.x - p1.x, dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) continue;
        let udx = dx / len, udy = dy / len;

        if (t.oneway === 'forward' || t.oneway === 'backward') {
            let dir = t.oneway === 'forward' ? 1 : -1;
            let ax = udx * dir, ay = udy * dir;
            for (let frac of [0.33, 0.67]) {
                let mx = p1.x + dx * frac, my = p1.y + dy * frac;
                ctx.save();
                ctx.translate(mx, my);
                ctx.rotate(Math.atan2(ay, ax));
                ctx.beginPath();
                ctx.moveTo(-6, -5);
                ctx.lineTo(6, 0);
                ctx.lineTo(-6, 5);
                ctx.closePath();
                ctx.fillStyle = '#fbbf24';
                ctx.fill();
                ctx.restore();
            }
        }

        if (t.turnback) {
            let mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            let nx = -udy, ny = udx;
            let bx = mx + nx * 24, by = my + ny * 24;
            ctx.save();
            ctx.translate(bx, by);
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            let label = 'TB';
            let w = ctx.measureText(label).width + 8;
            ctx.fillStyle = 'rgba(168, 85, 247, 0.9)';
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(-w/2, -8, w, 16, 3) : ctx.rect(-w/2, -8, w, 16);
            ctx.fill();
            ctx.fillStyle = '#2e1065';
            ctx.fillText(label, 0, 0);
            ctx.restore();
        }
    }

    const drawTrackSegment = (x1, y1, x2, y2, color, isSel, isHov, isOverpass) => {
        ctx.lineCap = 'round';
        if (isOverpass) {
            ctx.beginPath();
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            ctx.lineWidth = 12; ctx.strokeStyle = CANVAS_BG_COLOR; ctx.stroke();
        }
        
        // Highlight layer below actual track
        if (isSel) {
            ctx.beginPath();
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            ctx.lineWidth = 10;
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.4)';
            ctx.stroke();
        } else if (isHov && mode === 'delete') {
            ctx.beginPath();
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            ctx.lineWidth = 10;
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
            ctx.stroke();
        }
        
        // Actual track layer (Preserves user's custom color)
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.lineWidth = 4;
        ctx.strokeStyle = color || DEFAULT_TRACK_COLOR;
        ctx.stroke();
    };

    for (let pass of [false, true]) {
        for (let t of state.tracks) {
            if (t.overpass !== pass) continue;
            let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
            let isSel = (selectedElement && selectedElement.id === t.id);
            let isHov = (hoverElement && hoverElement.id === t.id);
            drawTrackSegment(p1.x, p1.y, p2.x, p2.y, t.color, isSel, isHov, pass);
        }
    }

    // 3.5 Draw Track Distance Labels (diagram-only, not tied to drawn length)
    for (let t of state.tracks) {
        if (t.distance === undefined || t.distance === null || t.distance === '') continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;

        let mx = (p1.x + p2.x) / 2;
        let my = (p1.y + p2.y) / 2;
        let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

        // Keep text upright (never upside-down)
        let drawAngle = angle;
        if (drawAngle > Math.PI / 2 || drawAngle < -Math.PI / 2) drawAngle += Math.PI;

        let nx = -Math.sin(angle), ny = Math.cos(angle);
        let offset = 16;
        let lx = mx + nx * offset;
        let ly = my + ny * offset;

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(drawAngle);
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let text = (typeof t.distance === 'number' ? t.distance : parseFloat(t.distance)) + ' m';
        let w = ctx.measureText(text).width + 8;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(-w / 2, -8, w, 16);
        ctx.fillStyle = '#4b5563';
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    // 3.55 Draw Speed Limit signs (small round sign, placed on the opposite side from the distance label)
    for (let t of state.tracks) {
        if (typeof t.speedLimit !== 'number' || isNaN(t.speedLimit)) continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        let dx = p2.x - p1.x, dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) continue;
        let udx = dx / len, udy = dy / len;
        let sx = p1.x + udx * len * 0.25;
        let sy = p1.y + udy * len * 0.25;
        let nx = -udy, ny = udx;
        let hx = sx - nx * 16;
        let hy = sy - ny * 16;

        ctx.save();
        ctx.translate(hx, hy);
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#dc2626';
        ctx.stroke();
        ctx.fillStyle = '#18181b';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(t.speedLimit), 0, 0);
        ctx.restore();
    }

    // 3.56 Draw Depot name badges
    for (let t of state.tracks) {
        if (!t.isDepot) continue;
        let p1 = getPoint(t.p1_id), p2 = getPoint(t.p2_id);
        if (!p1 || !p2) continue;
        let dx = p2.x - p1.x, dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy);
        if (len === 0) continue;
        let udx = dx / len, udy = dy / len;
        let mx = (p1.x + p2.x) / 2;
        let my = (p1.y + p2.y) / 2;
        let angle = Math.atan2(dy, dx);
        let drawAngle = angle;
        if (drawAngle > Math.PI / 2 || drawAngle < -Math.PI / 2) drawAngle += Math.PI;
        let nx = -udy, ny = udx;
        let offset = -30;
        let lx = mx + nx * offset;
        let ly = my + ny * offset;

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(drawAngle);
        let text = 'DEPOT' + (t.depotName ? (': ' + t.depotName) : '');
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let w = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
        ctx.fillRect(-w / 2, -9, w, 18);
        ctx.strokeStyle = '#a16207';
        ctx.lineWidth = 1;
        ctx.strokeRect(-w / 2, -9, w, 18);
        ctx.fillStyle = '#422006';
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    // 3.58 Draw Lines (colored route overlays following the track network between stops)
    function tDistToWorld(track, tdist) {
        let p1 = getPoint(track.p1_id), p2 = getPoint(track.p2_id);
        let dx = p2.x - p1.x, dy = p2.y - p1.y;
        let len = Math.hypot(dx, dy) || 1;
        let ux = dx / len, uy = dy / len;
        return { x: p1.x + ux * tdist, y: p1.y + uy * tdist, nx: -uy, ny: ux, ux, uy };
    }

    // Walks `dist` px along a path of {track, from, to} segments (each seg's
    // travel direction runs from `from` towards `to`, which may be either
    // increasing or decreasing t_dist). Returns the world point, offset
    // sideways by offsetMag, plus the direction of travel there - or null if
    // dist overshoots the whole path.
    function walkLinePath(segs, dist, offsetMag) {
        let remaining = dist;
        for (let seg of segs) {
            let segLen = Math.abs(seg.to - seg.from);
            if (remaining <= segLen) {
                let sign = seg.to >= seg.from ? 1 : -1;
                let tdist = seg.from + sign * remaining;
                let w = tDistToWorld(seg.track, tdist);
                return {
                    x: w.x + w.nx * offsetMag,
                    y: w.y + w.ny * offsetMag,
                    angle: Math.atan2(w.uy * sign, w.ux * sign)
                };
            }
            remaining -= segLen;
        }
        return null;
    }

    function pathPixelLength(segs) {
        return segs.reduce((sum, seg) => sum + Math.abs(seg.to - seg.from), 0);
    }

    // Only the currently-selected line (the "line-select" dropdown / activeLineId)
    // gets its pathfound route drawn on the canvas, rather than every line at
    // once - so the diagram doesn't get cluttered with every route's path when
    // the user is only working on one line at a time.
    let linesToDraw = state.lines.filter(l => l.id === activeLineId);
    linesToDraw.forEach((line, lineIdx) => {
        let color = line.color || '#ef4444';
        let offsetMag = 0; // only one line is ever drawn now, so no need to fan multiple lines apart
        let segLists = getLineSegments(line);

        segLists.forEach((segs, pairIdx) => {
            if (!segs) {
                // No legal route found between this pair of stops - show a thin
                // dashed straight connector so the gap is visible rather than
                // silent. Anchored on each stop's first platform.
                let platA = getStopPlatforms(line.stops[pairIdx])[0];
                let platB = getStopPlatforms(line.stops[pairIdx + 1])[0];
                let ga = platA && getPlatformGeom(platA);
                let gb = platB && getPlatformGeom(platB);
                if (ga && gb) {
                    ctx.save();
                    ctx.setLineDash([5, 5]);
                    ctx.strokeStyle = color;
                    ctx.globalAlpha = 0.5;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(ga.px, ga.py);
                    ctx.lineTo(gb.px, gb.py);
                    ctx.stroke();
                    ctx.restore();
                }
                return;
            }
            ctx.save();
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            segs.forEach((seg, i) => {
                let a = tDistToWorld(seg.track, seg.from);
                let b = tDistToWorld(seg.track, seg.to);
                let ax = a.x + a.nx * offsetMag, ay = a.y + a.ny * offsetMag;
                let bx = b.x + b.nx * offsetMag, by = b.y + b.ny * offsetMag;
                if (i === 0) ctx.moveTo(ax, ay);
                else ctx.lineTo(ax, ay);
                ctx.lineTo(bx, by);
            });
            ctx.stroke();
            ctx.restore();

            // Animated direction arrows marching along the pathfound route,
            // spaced evenly and continuously drifting forward to show which
            // way trains on this line travel between these two stops.
            let totalLen = pathPixelLength(segs);
            if (totalLen > 1) {
                ctx.save();
                ctx.fillStyle = color;
                ctx.strokeStyle = '#18181b';
                ctx.lineWidth = 1;
                let d = lineAnimOffset % LINE_ARROW_SPACING;
                while (d < totalLen) {
                    let pt = walkLinePath(segs, d, offsetMag);
                    if (pt) {
                        ctx.save();
                        ctx.translate(pt.x, pt.y);
                        ctx.rotate(pt.angle);
                        ctx.beginPath();
                        ctx.moveTo(7, 0);
                        ctx.lineTo(-5, -5);
                        ctx.lineTo(-5, 5);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                    }
                    d += LINE_ARROW_SPACING;
                }
                ctx.restore();
            }
        });

        // Stop markers with order numbers - every platform in a stop gets a
        // marker with that stop's number, so a multi-platform terminus shows
        // the same number on each of its platforms.
        line.stops.forEach((stop, idx) => {
            getStopPlatforms(stop).forEach(plat => {
                let geom = getPlatformGeom(plat);
                if (!geom) return;
                ctx.save();
                ctx.beginPath();
                ctx.arc(geom.px, geom.py, 7, 0, Math.PI * 2);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = '#18181b';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 8px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(String(idx + 1), geom.px, geom.py);
                ctx.restore();
            });
        });
    });

    // 3.6 Draw Signals (directional: red/blue light, arrow shows the facing/valid travel direction)
    const renderSignal = (geom, sigState, isSel, isHov, isPhantom) => {
        ctx.save();
        ctx.globalAlpha = isPhantom ? 0.4 : 1.0;

        // Post connecting the track centerline to the signal head. It always
        // leaves the track dead-perpendicular first, then routes the rest of
        // the way to the head through clean 45-degree-ish legs (not capped at
        // a single bend) instead of being one long diagonal straight off the
        // track.
        ctx.beginPath();
        ctx.moveTo(geom.cx, geom.cy);
        ctx.lineTo(geom.bx, geom.by);
        ctx.lineTo(geom.mx, geom.my);
        ctx.lineTo(geom.px, geom.py);
        ctx.strokeStyle = '#a1a1aa';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.translate(geom.px, geom.py);

        // Selection / hover ring
        if (isSel || isHov) {
            ctx.beginPath();
            ctx.arc(0, 0, SIGNAL_RADIUS + 4, 0, Math.PI * 2);
            ctx.strokeStyle = isSel ? '#2563eb' : (mode === 'delete' ? '#ef4444' : '#60a5fa');
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Direction arrow: points along the travel direction this signal faces.
        // Only trains travelling this way would see the light.
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

        // Signal head
        ctx.beginPath();
        ctx.arc(0, 0, SIGNAL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = sigState === 'blue' ? '#3b82f6' : '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#e4e4e7';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    };

    for (let s of state.signals) {
        let geom = getSignalGeom(s);
        if (!geom) continue;
        let isSel = (selectedElement && selectedElement.id === s.id);
        let isHov = (hoverElement && hoverElement.id === s.id);
        renderSignal(geom, s.state, isSel, isHov, false);
    }

    if (mode === 'signal' && trackProjection && trackProjection.distToMouse < 60) {
        let baseAngle = trackProjection.angle + trackProjection.side * (Math.PI / 2);
        let headX = trackProjection.cx + Math.cos(baseAngle) * SIGNAL_OFFSET;
        let headY = trackProjection.cy + Math.sin(baseAngle) * SIGNAL_OFFSET;
        let path = getSignalPath(trackProjection.cx, trackProjection.cy, trackProjection.angle, trackProjection.side, headX, headY);
        renderSignal({
            cx: trackProjection.cx, cy: trackProjection.cy,
            bx: path.bx, by: path.by, mx: path.mx, my: path.my, px: path.px, py: path.py,
            facing: trackProjection.angle
        }, 'red', false, false, true);
    }

    // 4. Draw Track Endpoints
    ctx.lineWidth = 4;
    for (let pt of state.points) {
        let degree = state.tracks.filter(t => t.p1_id === pt.id || t.p2_id === pt.id).length;
        if (degree === 1) {
            let track = state.tracks.find(t => t.p1_id === pt.id || t.p2_id === pt.id);
            if (track) {
                let otherPt = getPoint(track.p1_id === pt.id ? track.p2_id : track.p1_id);
                let angle = Math.atan2(otherPt.y - pt.y, otherPt.x - pt.x);
                let perp1 = angle + Math.PI / 2;
                ctx.strokeStyle = track.color || DEFAULT_TRACK_COLOR;

                let len = 10;
                ctx.beginPath();
                ctx.moveTo(pt.x + Math.cos(perp1) * len, pt.y + Math.sin(perp1) * len);
                ctx.lineTo(pt.x - Math.cos(perp1) * len, pt.y - Math.sin(perp1) * len);
                ctx.stroke();
            }
        }
    }

    // 5. Draw Points
    if (mode === 'select' || mode === 'delete') {
        for (let p of state.points) {
            let isSel = (selectedElement && selectedElement.id === p.id);
            let isHov = (hoverElement && hoverElement.id === p.id);
            ctx.beginPath();
            ctx.arc(p.x, p.y, isSel ? 6 : 4, 0, Math.PI * 2);
            let pCol = isSel ? '#2563eb' : '#9ca3af';
            if (mode === 'delete' && isHov) pCol = '#ef4444';
            ctx.fillStyle = pCol;
            ctx.fill();
        }
    }

    // Current Drawing Track
    if (isDrawing && mode === 'track' && drawStartPoint) {
        ctx.beginPath();
        ctx.moveTo(drawStartPoint.x, drawStartPoint.y);
        ctx.lineTo(currentMouseWorld.x, currentMouseWorld.y);
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(37, 99, 235, 0.5)'; ctx.stroke();
    }

    if (mode === 'track' || dragPointId) {
        ctx.beginPath();
        ctx.arc(currentMouseWorld.x, currentMouseWorld.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444'; ctx.fill();
    } else if (mode === 'split' && trackProjection && trackProjection.distToMouse < 30) {
        ctx.beginPath();
        ctx.arc(trackProjection.cx, trackProjection.cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // 6. Draw Text Labels (freeform annotations, always on top)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let l of state.labels) {
        let isSel = (selectedElement && selectedElement.id === l.id);
        let isHov = (hoverElement && hoverElement.id === l.id);
        let bgVisible = l.bgVisible !== false; // default true for older saved diagrams
        let fontSize = l.fontSize || LABEL_DEFAULT_FONT_SIZE;

        ctx.font = labelFont(l);
        let w = ctx.measureText(l.text).width + 10;
        let h = fontSize + 6;

        if (bgVisible) {
            // Solid backing bubble - text sits on a light card regardless of
            // the (dark) canvas background, so it's always legible.
            ctx.fillStyle = isSel ? 'rgba(59,130,246,0.25)' : 'rgba(244,244,245,0.9)';
            ctx.fillRect(l.x - w / 2, l.y - h / 2, w, h);
            ctx.lineWidth = isSel ? 2 : 1;
            ctx.strokeStyle = isSel ? '#2563eb' : (isHov ? '#60a5fa' : '#71717a');
            if (mode === 'delete' && isHov) ctx.strokeStyle = '#ef4444';
            ctx.strokeRect(l.x - w / 2, l.y - h / 2, w, h);
            ctx.fillStyle = '#18181b';
        } else {
            // No backing - text floats directly on the canvas. Only show an
            // outline (no fill) when selected/hovered, purely so the label
            // stays discoverable/clickable; otherwise it's invisible.
            if (isSel || isHov) {
                ctx.save();
                ctx.setLineDash(isSel ? [] : [4, 3]);
                ctx.lineWidth = isSel ? 2 : 1;
                ctx.strokeStyle = isSel ? '#2563eb' : (mode === 'delete' ? '#ef4444' : '#60a5fa');
                ctx.strokeRect(l.x - w / 2, l.y - h / 2, w, h);
                ctx.restore();
            }
            ctx.fillStyle = '#e4e4e7';
        }

        ctx.fillText(l.text, l.x, l.y);
    }

    ctx.restore();
}

// ============================================================
// --- Map Settings (name / description / in-game start time) ---
// ============================================================
// Injected purely in JS (rather than requiring an HTML change) so this
// works by just swapping in the new script.js, with no dependency on the
// exact markup of the page it's dropped into. Reuses the existing generic
// openModal() helper the rest of the Builder already relies on.

(function initMapSettingsUI() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    const exportBtn = document.getElementById('btn-export');
    const exportGroup = exportBtn ? exportBtn.closest('.tool-group') : null;

    const group = document.createElement('div');
    group.className = 'tool-group';

    const btn = document.createElement('button');
    btn.id = 'btn-map-settings';
    btn.type = 'button';
    btn.textContent = 'Map Settings';
    btn.title = 'Set the map name, description and in-game start time';
    btn.addEventListener('click', openMapSettingsModal);
    group.appendChild(btn);

    if (exportGroup && exportGroup.parentNode === toolbar) {
        toolbar.insertBefore(group, exportGroup);
    } else {
        toolbar.appendChild(group);
    }
})();

function openMapSettingsModal() {
    if (!state.meta || typeof state.meta !== 'object') {
        state.meta = { name: '', description: '', startTime: '05:50' };
    }
    openModal('Map Settings', [
        { key: 'name', label: 'Map name', type: 'text', value: state.meta.name,
            placeholder: 'e.g. Central Line' },
        { key: 'description', label: 'Description', type: 'textarea', rows: 3,
            value: state.meta.description,
            placeholder: 'Shown to players when they pick this map' },
        { key: 'startTime', label: 'In-game start time', type: 'time',
            value: /^\d{2}:\d{2}$/.test(state.meta.startTime) ? state.meta.startTime : '05:50' }
    ], (values) => {
        state.meta.name = (values.name || '').trim();
        state.meta.description = (values.description || '').trim();
        state.meta.startTime = /^\d{2}:\d{2}$/.test(values.startTime) ? values.startTime : (state.meta.startTime || '05:50');
        updateMapSettingsButton();
    });
}

function updateMapSettingsButton() {
    const btn = document.getElementById('btn-map-settings');
    if (!btn) return;
    const name = (state.meta && state.meta.name) ? state.meta.name.trim() : '';
    btn.textContent = name ? ('Map Settings: ' + name) : 'Map Settings';
}
updateMapSettingsButton();