const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const RESET_PASSWORD = process.env.RESET_PASSWORD || 'geheim123';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Pins: { id, lat, lon, size, ts, by }
let pins = [];

// Rate limit per socket: token bucket (1.5s per token, burst 3)
const buckets = new Map(); // socket.id -> { tokens, last }
const RATE_MS = 1500, BURST = 3;

// Merge radius (meters)
const MERGE_RADIUS_M = 10;

// Helpers
function now(){ return Date.now(); }
function id(){ return crypto.randomBytes(8).toString('hex'); }

function haversineMeters(a, b){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}

function takeToken(sid){
  const t = now();
  let b = buckets.get(sid) || { tokens: BURST, last: t };
  const elapsed = t - b.last;
  const refill = Math.floor(elapsed / RATE_MS);
  if (refill > 0){
    b.tokens = Math.min(BURST, b.tokens + refill);
    b.last = t;
  }
  if (b.tokens <= 0) { buckets.set(sid, b); return false; }
  b.tokens -= 1;
  buckets.set(sid, b);
  return true;
}

// Undo stacks per socket: last actions ({type:'add'|'merge', pinId, prevSize})
const undoStacks = new Map();

io.on('connection', (socket) => {
  // Init with all pins
  socket.emit('init', pins);

  socket.on('newPin', ({ lat, lon, size }) => {
    lat = +lat; lon = +lon; size = +size;
    if (!isFinite(lat) || !isFinite(lon)) return;
    if (!(size >= 1 && size <= 5)) size = 2;

    // Rate limit
    if (!takeToken(socket.id)) {
      socket.emit('pinRejected', { reason: 'rate_limit' });
      return;
    }

    // Merge with existing within MERGE_RADIUS_M
    let merged = null, mergedPrevSize = null;
    for (let i=0;i<pins.length;i++){
      const p = pins[i];
      const d = haversineMeters({lat,lon},{lat:p.lat,lon:p.lon});
      if (d <= MERGE_RADIUS_M){
        merged = p;
        mergedPrevSize = p.size;
        // merge strategy: take max size and refresh timestamp
        p.size = Math.max(p.size, size);
        p.ts = now();
        io.emit('pinUpdated', p);
        break;
      }
    }

    if (merged){
      const st = undoStacks.get(socket.id) || [];
      st.push({ type: 'merge', pinId: merged.id, prevSize: mergedPrevSize });
      if (st.length > 50) st.shift();
      undoStacks.set(socket.id, st);
      return;
    }

    // New pin
    const p = { id: id(), lat, lon, size, ts: now(), by: socket.id };
    pins.push(p);
    io.emit('pinAdded', p);

    const st = undoStacks.get(socket.id) || [];
    st.push({ type: 'add', pinId: p.id });
    if (st.length > 50) st.shift();
    undoStacks.set(socket.id, st);
  });

  socket.on('undo', () => {
    const st = undoStacks.get(socket.id) || [];
    const last = st.pop();
    if (!last) return;

    if (last.type === 'add'){
      const idx = pins.findIndex(p => p.id === last.pinId);
      if (idx >= 0){
        const [removed] = pins.splice(idx,1);
        io.emit('pinRemoved', removed.id);
      }
    } else if (last.type === 'merge'){
      const p = pins.find(x => x.id === last.pinId);
      if (p){
        p.size = last.prevSize;
        p.ts = now();
        io.emit('pinUpdated', p);
      }
    }
    undoStacks.set(socket.id, st);
  });

  socket.on('disconnect', () => {
    buckets.delete(socket.id);
    undoStacks.delete(socket.id);
  });
});

// Reset (protected by password in query/body)
app.post('/reset', (req, res) => {
  const token = (req.query.p || req.body.p || '').toString();
  if (token !== RESET_PASSWORD) return res.status(401).json({ ok:false, error:'unauthorized' });
  pins = [];
  io.emit('reset');
  res.json({ ok:true });
});

// Export KML
app.get('/pins.kml', (req, res) => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  ${pins.map(p => `<Placemark><name>size: ${p.size}</name><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point><TimeStamp><when>${new Date(p.ts).toISOString()}</when></TimeStamp></Placemark>`).join('\n  ')}
</Document></kml>`;
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.send(kml);
});

// Export GPX
app.get('/pins.gpx', (req, res) => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="realtime-heatmap" xmlns="http://www.topografix.com/GPX/1/1">
  ${pins.map(p => `<wpt lat="${p.lat}" lon="${p.lon}"><name>size: ${p.size}</name><time>${new Date(p.ts).toISOString()}</time></wpt>`).join('\n  ')}
</gpx>`;
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.send(gpx);
});

server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));
