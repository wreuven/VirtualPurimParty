const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const sharp = require('sharp');
const { execFile } = require('child_process');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// Multer config for uploads
const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|mp3|ogg|wav/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, type: req.body.mediaType || 'image' });
});

// Face crop endpoint — takes an uploaded image, detects face, returns square crop
app.get('/face-crop', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !url.startsWith('/uploads/')) return res.status(400).json({ error: 'Invalid url' });
    const srcPath = path.join(__dirname, 'public', url);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'Not found' });

    // Detect face using Python OpenCV
    const faceData = await new Promise((resolve, reject) => {
      execFile('python3', [path.join(__dirname, 'face_crop.py'), srcPath], (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout.trim())); } catch(e) { reject(e); }
      });
    });

    const outName = 'face-' + uuidv4() + '.jpg';
    const outPath = path.join(__dirname, 'public/uploads', outName);

    if (faceData) {
      // Crop to detected face
      await sharp(srcPath)
        .extract({ left: faceData.x, top: faceData.y, width: faceData.w, height: faceData.h })
        .resize(256, 256)
        .jpeg({ quality: 85 })
        .toFile(outPath);
    } else {
      // No face found — center-crop square
      const meta = await sharp(srcPath).metadata();
      const side = Math.min(meta.width, meta.height);
      await sharp(srcPath)
        .extract({ left: Math.floor((meta.width - side) / 2), top: Math.floor((meta.height - side) / 2), width: side, height: side })
        .resize(256, 256)
        .jpeg({ quality: 85 })
        .toFile(outPath);
    }

    res.json({ url: '/uploads/' + outName });
  } catch(e) {
    console.error('Face crop error:', e);
    res.status(500).json({ error: 'Crop failed' });
  }
});

// State
const players = {};
let partyMusic = null; // { url, name, uploadedBy }
const sharedMedia = []; // { id, url, type, x, y, uploadedBy, uploadedById, timestamp }

// mediasoup state
const VOICE_PROXIMITY = 250;
let msWorker, msRouter;
const transports = {};  // transportId → transport
const producers = {};   // socketId → producer
const consumers = {};   // consumerId → { consumer, socketId, producerSocketId }

async function initMediasoup() {
  msWorker = await mediasoup.createWorker({
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });
  msWorker.on('died', () => { console.error('mediasoup Worker died!'); process.exit(1); });
  msRouter = await msWorker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    ],
  });
  console.log('mediasoup Router ready');
}

async function createWebRtcTransport() {
  const transport = await msRouter.createWebRtcTransport({
    listenInfos: [
      { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
      { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });
  transports[transport.id] = transport;
  transport.on('routerclose', () => { delete transports[transport.id]; });
  return transport;
}

initMediasoup();

function notifyProducerProximity(producerSocketId) {
  const producerPlayer = players[producerSocketId];
  if (!producerPlayer || !producers[producerSocketId]) return;
  for (const [sid, p] of Object.entries(players)) {
    if (sid === producerSocketId) continue;
    const dist = Math.hypot(producerPlayer.x - p.x, producerPlayer.y - p.y);
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    if (dist < VOICE_PROXIMITY) {
      sock.emit('subscribeProducer', { producerSocketId });
    }
  }
}

// Throttled proximity check on move
const lastProximityCheck = {};
function checkMoveProximity(socketId) {
  const now = Date.now();
  if (lastProximityCheck[socketId] && now - lastProximityCheck[socketId] < 500) return;
  lastProximityCheck[socketId] = now;
  const me = players[socketId];
  if (!me) return;
  for (const [sid, p] of Object.entries(players)) {
    if (sid === socketId) continue;
    const dist = Math.hypot(me.x - p.x, me.y - p.y);
    // If I have a producer, notify sid whether to sub/unsub
    if (producers[socketId]) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        if (dist < VOICE_PROXIMITY) sock.emit('subscribeProducer', { producerSocketId: socketId });
        else sock.emit('unsubscribeProducer', { producerSocketId: socketId });
      }
    }
    // If sid has a producer, notify me whether to sub/unsub
    if (producers[sid]) {
      const mySock = io.sockets.sockets.get(socketId);
      if (mySock) {
        if (dist < VOICE_PROXIMITY) mySock.emit('subscribeProducer', { producerSocketId: sid });
        else mySock.emit('unsubscribeProducer', { producerSocketId: sid });
      }
    }
  }
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', (data) => {
    players[socket.id] = {
      id: socket.id,
      name: data.name,
      costume: data.costume || 'queen_esther',
      x: 400 + Math.random() * 400,
      y: 300 + Math.random() * 200,
      color: data.color || `hsl(${Math.random()*360},70%,60%)`
    };
    socket.emit('state', { players, partyMusic, sharedMedia });
    socket.broadcast.emit('playerJoined', players[socket.id]);
  });

  socket.on('move', (pos) => {
    if (!players[socket.id]) return;
    players[socket.id].x = Math.max(30, Math.min(1170, pos.x));
    players[socket.id].y = Math.max(30, Math.min(670, pos.y));
    io.emit('playerMoved', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y });
    checkMoveProximity(socket.id);
  });

  socket.on('chatMessage', (msg) => {
    if (!players[socket.id]) return;
    // Only deliver to nearby players (within 200px)
    const me = players[socket.id];
    const sanitized = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 200);
    for (const [id, p] of Object.entries(players)) {
      const dist = Math.hypot(me.x - p.x, me.y - p.y);
      if (dist < 250) {
        io.to(id).emit('chatMessage', { from: me.name, fromId: socket.id, text: sanitized, dist });
      }
    }
  });

  socket.on('sendEmoji', (data) => {
    if (!players[socket.id]) return;
    const positiveEmojis = ['😊','🎉','❤️','⭐','👏','🥳','💃','🕺','✨','🌟','💖','😄','🤗','👍','🎊','🎭','👑','🍷','📜','🔔','🎶','🌈'];
    if (positiveEmojis.includes(data.emoji)) {
      const sender = players[socket.id];
      const receiver = players[data.to];
      io.to(data.to).emit('receiveEmoji', { from: sender.name, emoji: data.emoji });
      // Animate emoji flying from sender to receiver for everyone
      if (receiver) {
        io.emit('flyingEmoji', {
          emoji: data.emoji,
          fromX: sender.x, fromY: sender.y - 40,
          toX: receiver.x, toY: receiver.y - 40
        });
      }
    }
  });

  socket.on('shareMedia', (data) => {
    if (!players[socket.id]) return;
    const item = {
      id: uuidv4(),
      url: data.url,
      type: data.type,
      x: players[socket.id].x,
      y: players[socket.id].y - 60,
      uploadedBy: players[socket.id].name,
      uploadedById: socket.id,
      timestamp: Date.now()
    };
    sharedMedia.push(item);
    // Keep only last 30
    if (sharedMedia.length > 30) sharedMedia.shift();
    io.emit('mediaShared', item);
  });

  socket.on('deleteMedia', (mediaId) => {
    const idx = sharedMedia.findIndex(m => m.id === mediaId);
    if (idx !== -1 && sharedMedia[idx].uploadedById === socket.id) {
      sharedMedia.splice(idx, 1);
      io.emit('mediaDeleted', mediaId);
    }
  });

  socket.on('getPlayerMedia', (playerId, callback) => {
    const items = sharedMedia.filter(m => m.uploadedById === playerId);
    callback(items);
  });

  socket.on('changeCostume', (costume) => {
    if (!players[socket.id]) return;
    players[socket.id].costume = costume;
    io.emit('costumeChanged', { id: socket.id, costume });
  });

  socket.on('setPartyMusic', (data) => {
    if (!players[socket.id]) return;
    partyMusic = { url: data.url, name: data.name, uploadedBy: players[socket.id].name };
    io.emit('partyMusicChanged', partyMusic);
  });

  // Voice chat signaling (mediasoup SFU)
  socket.on('micStatus', (data) => {
    socket.broadcast.emit('micStatus', { id: socket.id, micOn: data.micOn });
  });

  socket.on('msGetRouterCapabilities', (_, cb) => {
    cb(msRouter.rtpCapabilities);
  });

  socket.on('msCreateTransports', async (_, cb) => {
    try {
      const send = await createWebRtcTransport();
      const recv = await createWebRtcTransport();
      // tag transports with socket id for cleanup
      send._socketId = socket.id;
      recv._socketId = socket.id;
      cb({
        send: { id: send.id, iceParameters: send.iceParameters, iceCandidates: send.iceCandidates, dtlsParameters: send.dtlsParameters },
        recv: { id: recv.id, iceParameters: recv.iceParameters, iceCandidates: recv.iceCandidates, dtlsParameters: recv.dtlsParameters },
      });
    } catch (e) { console.error('msCreateTransports error:', e); cb({ error: e.message }); }
  });

  socket.on('msConnectTransport', async (data, cb) => {
    try {
      const transport = transports[data.transportId];
      if (!transport) return cb({ error: 'transport not found' });
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      cb({});
    } catch (e) { console.error('msConnectTransport error:', e); cb({ error: e.message }); }
  });

  socket.on('msProduce', async (data, cb) => {
    try {
      const transport = transports[data.transportId];
      if (!transport) return cb({ error: 'transport not found' });
      const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters });
      producers[socket.id] = producer;
      producer.on('transportclose', () => { delete producers[socket.id]; });
      cb({ id: producer.id });
      // Notify nearby players about this new producer
      notifyProducerProximity(socket.id);
    } catch (e) { console.error('msProduce error:', e); cb({ error: e.message }); }
  });

  socket.on('msConsume', async (data, cb) => {
    try {
      const producer = producers[data.producerSocketId];
      if (!producer) return cb({ error: 'producer not found' });
      if (!msRouter.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities })) {
        return cb({ error: 'cannot consume' });
      }
      const transport = transports[data.transportId];
      if (!transport) return cb({ error: 'transport not found' });
      const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities, paused: false });
      consumers[consumer.id] = { consumer, socketId: socket.id, producerSocketId: data.producerSocketId };
      consumer.on('transportclose', () => { delete consumers[consumer.id]; });
      consumer.on('producerclose', () => {
        socket.emit('unsubscribeProducer', { producerSocketId: data.producerSocketId });
        delete consumers[consumer.id];
      });
      cb({ id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (e) { console.error('msConsume error:', e); cb({ error: e.message }); }
  });

  socket.on('msCloseProducer', (_, cb) => {
    const producer = producers[socket.id];
    if (producer) {
      producer.close();
      delete producers[socket.id];
    }
    // close all consumers of this producer
    for (const [cid, c] of Object.entries(consumers)) {
      if (c.producerSocketId === socket.id) {
        c.consumer.close();
        io.to(c.socketId).emit('unsubscribeProducer', { producerSocketId: socket.id });
        delete consumers[cid];
      }
    }
    if (cb) cb({});
  });

  socket.on('disconnect', () => {
    // Clean up mediasoup resources
    const producer = producers[socket.id];
    if (producer) { producer.close(); delete producers[socket.id]; }
    // Close consumers where this socket is the consumer
    for (const [cid, c] of Object.entries(consumers)) {
      if (c.socketId === socket.id || c.producerSocketId === socket.id) {
        c.consumer.close();
        if (c.socketId !== socket.id) {
          io.to(c.socketId).emit('unsubscribeProducer', { producerSocketId: socket.id });
        }
        delete consumers[cid];
      }
    }
    // Close transports belonging to this socket
    for (const [tid, t] of Object.entries(transports)) {
      if (t._socketId === socket.id) { t.close(); delete transports[tid]; }
    }
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Purim Party running at http://localhost:${PORT}`));
