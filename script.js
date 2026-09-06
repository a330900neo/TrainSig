/** 
 * Data Structures
 * Points: { id, x, y }
 * Tracks: { id, p1_id, p2_id, overpass: boolean, color: string, distance: string,
 *   speedLimit: string, isDepot: boolean,
 *   depotName: string, trainMaxSpeed: string, acceleration: string, emergencyDeceleration: string }
 *   - distance is a free-form diagram label (e.g. "3.2 km"). It is NOT tied to the
 *     drawn pixel length - this is a schematic diagram, not drawn to scale.
 *   - speedLimit is the line speed for that track segment (e.g. "80 km/h").
 *   - depotName/trainMaxSpeed/acceleration/emergencyDeceleration only apply when
 *     isDepot is true. acceleration is used for both accelerating and normal
 *     (service) braking; emergencyDeceleration is a separate, harder braking value.
 * Platforms: { id, track_id, t_dist, side: 1|-1, color: string, number: string, code: string }
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
 */
let state = {
    points: [],
    tracks: [],
    platforms: [],
    signals: [],
    labels: []
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

// App State
let mode = 'select'; // 'select', 'track', 'split', 'platform', 'signal', 'label', 'delete'
let gridSize = 40;
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
        state.tracks = state.tracks.filter(t => t.id !== elem.id);
        state.platforms = state.platforms.filter(p => p.track_id !== elem.id);
        state.signals = state.signals.filter(s => s.track_id !== elem.id);
        cleanupOrphanPoints();
    } else if (elem.type === 'platform') {
        state.platforms = state.platforms.filter(p => p.id !== elem.id);
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
        } else {
            const label = document.createElement('label');
            label.textContent = f.label;
            label.htmlFor = 'modal-input-' + f.key;

            const input = document.createElement('input');
            input.type = (f.type === 'number') ? 'number' : 'text';
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
                { key: 'distance', type: 'text', label: 'Distance label (diagram only, not to scale)', value: t.distance || '', placeholder: 'e.g. 3.2 km' },
                { key: 'speedLimit', type: 'text', label: 'Speed Limit', value: t.speedLimit || '', placeholder: 'e.g. 80 km/h' },
                { key: 'isDepot', type: 'checkbox', label: 'This track is a Depot', value: !!t.isDepot },
                { key: 'depotName', type: 'text', label: 'Depot Name', value: t.depotName || '', placeholder: 'e.g. North Yard', dependsOn: 'isDepot' },
                { key: 'trainMaxSpeed', type: 'text', label: 'Train Max Speed', value: t.trainMaxSpeed || '', placeholder: 'e.g. 100 km/h', dependsOn: 'isDepot' },
                { key: 'acceleration', type: 'text', label: 'Acceleration / Deceleration', value: t.acceleration || '', placeholder: 'e.g. 1.0 m/s²', dependsOn: 'isDepot' },
                { key: 'emergencyDeceleration', type: 'text', label: 'Emergency Deceleration', value: t.emergencyDeceleration || '', placeholder: 'e.g. 2.5 m/s²', dependsOn: 'isDepot' }
            ], (vals) => {
                t.distance = vals.distance;
                t.speedLimit = vals.speedLimit;
                t.isDepot = vals.isDepot;
                if (t.isDepot) {
                    t.depotName = vals.depotName;
                    t.trainMaxSpeed = vals.trainMaxSpeed;
                    t.acceleration = vals.acceleration;
                    t.emergencyDeceleration = vals.emergencyDeceleration;
                } else {
                    delete t.depotName;
                    delete t.trainMaxSpeed;
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
                { key: 'code', label: 'Platform Code', value: p.code || '', placeholder: 'e.g. PF-A' }
            ], (vals) => {
                p.number = vals.number;
                p.code = vals.code;
                draw();
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
            if (!state.signals) state.signals = [];
            if (!state.platforms) state.platforms = [];
            if (!state.tracks) state.tracks = [];
            if (!state.points) state.points = [];
            if (!state.labels) state.labels = [];
            selectedElement = null;
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
                t.distance = Math.round(len1) + ' m';
                
                state.tracks.push({
                    id: t2_id, p1_id: existingPt.id, p2_id: old_p2, 
                    overpass: t.overpass, color: t.color, distance: Math.round(len2) + ' m'
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
    else if (mode === 'delete') {
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
                    distance: Math.round(len) + ' m'
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

    const drawTrackSegment = (x1, y1, x2, y2, color, isSel, isHov, isOverpass) => {
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
        if (!t.distance) continue;
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
        let text = t.distance;
        let w = ctx.measureText(text).width + 8;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(-w / 2, -8, w, 16);
        ctx.fillStyle = '#4b5563';
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    // 3.55 Draw Speed Limit signs (small round sign, placed on the opposite side from the distance label)
    for (let t of state.tracks) {
        if (!t.speedLimit) continue;
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
        ctx.fillText(t.speedLimit, 0, 0);
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