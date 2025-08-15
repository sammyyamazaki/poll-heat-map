const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

  socket.on('newPin', (pin) => {
    const check = canAcceptPin(socket.id);
    if (!check.ok) {
      socket.emit('pinRejected', { reason: check.reason });
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