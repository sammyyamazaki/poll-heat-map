const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Added: Rate limit, merge, undo state ---
const crypto = require('crypto');
const RATE_MS = 1500, BURST = 3; // Token bucket: 1 Pin / 1.5s, Burst 3
const MERGE_RADIUS_M = 10;       // Merge-Radius in Metern
const buckets = new Map();       // socket.id -> { tokens, last }
const undoStacks = new Map();    // socket.id -> [{type:'add'|'merge', pinId, prevSize}]

function now(){ return Date.now(); }
function id(){ return crypto.randomBytes(8).toString('hex'); }
function takeToken(sid){
  const t = now();
  let b = buckets.get(sid) || { tokens: BURST, last: t };
  const elapsed = t - b.last;
  const refill = Math.floor(elapsed / RATE_MS);
  if (refill > 0){ b.tokens = Math.min(BURST, b.tokens + refill); b.last = t; }
  if (b.tokens <= 0){ buckets.set(sid, b); return false; }
  b.tokens -= 1; buckets.set(sid, b); return true;
}
function haversineMeters(a, b){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}


const PORT = process.env.PORT || 3000;
const RESET_PASSWORD = process.env.RESET_PASSWORD || 'geheim123';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let pins = []; // {lat, lon, size, ts}

const MIN_INTERVAL_MS = 1000;
const MAX_PER_MINUTE = 30;
const recentBySocket = new Map();

function canAcceptPin(socketId) {
  const now = Date.now();
  const state = recentBySocket.get(socketId) || { last: 0, windowStart: now, count: 0 };
  if (now - state.last < MIN_INTERVAL_MS) return { ok: false, reason: 'too_fast' };
  if (now - state.windowStart > 60000) { state.windowStart = now; state.count = 0; }
  if (state.count >= MAX_PER_MINUTE) return { ok: false, reason: 'rate_limit' };
  state.last = now;
  state.count += 1;
  recentBySocket.set(socketId, state);
  return { ok: true };
}

io.on('connection', (socket) => {
  socket.emit('init', pins);

  socket.on('undo', () => {
    const st = undoStacks.get(socket.id) || [];
    const last = st.pop();
    if (!last) return;
    if (last.type === 'add'){
      const idx = pins.findIndex(p => p.id === last.pinId);
      if (idx >= 0){ const [removed] = pins.splice(idx,1); io.emit('pinRemoved', removed.id); }
    } else if (last.type === 'merge'){
      const p = pins.find(x => x.id === last.pinId);
      if (p){ p.size = last.prevSize; p.ts = Date.now(); io.emit('pinUpdated', p); }
    }
    undoStacks.set(socket.id, st);
  });

  socket.on('newPin', ({ lat, lon, size }) => {
    lat = +lat; lon = +lon; size = +size;
    if (!isFinite(lat) || !isFinite(lon)) return;
    if (!(size >= 1 && size <= 5)) size = 2;

    // Rate limit
    if (!takeToken(socket.id)) {
      socket.emit('pinRejected', { reason: 'rate_limit' });
      return;
    }

    // Merge within MERGE_RADIUS_M (max size)
    let merged = null, mergedPrevSize = null;
    for (let i=0;i<pins.length;i++){
      const p = pins[i];
      const d = haversineMeters({lat,lon},{lat:p.lat,lon:p.lon});
      if (d <= MERGE_RADIUS_M){
        merged = p; mergedPrevSize = p.size;
        p.size = Math.max(p.size, size); p.ts = Date.now();
        io.emit('pinUpdated', p);
        break;
      }
    }
    if (merged){
      const st = undoStacks.get(socket.id) || [];
      st.push({ type:'merge', pinId: merged.id, prevSize: mergedPrevSize });
      if (st.length > 50) st.shift();
      undoStacks.set(socket.id, st);
      return;
    }

    // Add new pin
    const p = { id: id(), lat, lon, size, ts: Date.now(), by: socket.id };
    pins.push(p);
    io.emit('pinAdded', p);

    const st = undoStacks.get(socket.id) || [];
    st.push({ type:'add', pinId: p.id });
    if (st.length > 50) st.shift();
    undoStacks.set(socket.id, st);
  });
      return;
    }
    if (pin && typeof pin.lat === 'number' && typeof pin.lon === 'number') {
      const size = Math.max(1, Math.min(5, parseInt(pin.size || 2, 10)));
      const clean = { lat: +pin.lat, lon: +pin.lon, size, ts: Date.now() };
      pins.push(clean);
      io.emit('pinAdded', clean);
    }
  });
});

app.post('/reset', (req, res) => {
  const { password } = req.body || {};
  if (password !== RESET_PASSWORD) return res.status(403).json({ error: 'Ungültiges Passwort' });
  pins = [];
  io.emit('reset');
  res.json({ ok: true });
});

app.get('/pins.geojson', (req, res) => {
  const fc = {
    type: 'FeatureCollection',
    features: pins.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { size: p.size, ts: p.ts }
    }))
  };
  res.setHeader('Content-Type', 'application/geo+json');
  res.send(JSON.stringify(fc, null, 2));
});

app.get('/pins.csv', (req, res) => {
  const header = 'lat,lon,size,timestamp\n';
  const rows = pins.map(p => `${p.lat},${p.lon},${p.size},${p.ts}`).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(header + rows + '\n');
});

app.get('/pins.kml', (req, res) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Pins</name>
    ${pins.map(p => `<Placemark><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point><ExtendedData><Data name="size"><value>${p.size}</value></Data><Data name="ts"><value>${p.ts}</value></Data></ExtendedData></Placemark>`).join('\n    ')}
  </Document>
</kml>`;
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.send(kml);
});

app.get('/pins.gpx', (req, res) => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="realtime-heatmap" xmlns="http://www.topografix.com/GPX/1/1">
  ${pins.map(p => `<wpt lat="${p.lat}" lon="${p.lon}"><name>size:${p.size}</name><time>${new Date(p.ts).toISOString()}</time></wpt>`).join('\n  ')}
</gpx>`;
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.send(gpx);
});

server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));