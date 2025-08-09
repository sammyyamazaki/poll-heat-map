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

let pins = [];

io.on('connection', (socket) => {
  socket.emit('init', pins);
  socket.on('newPin', (pin) => {
    if (pin && typeof pin.lat === 'number' && typeof pin.lon === 'number') {
      const size = Math.max(1, Math.min(5, parseInt(pin.size || 2, 10)));
      const clean = { lat: +pin.lat, lon: +pin.lon, size };
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

server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));