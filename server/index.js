const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();
const {
  buildAppUsers,
  isValidUserIdFormat,
  isValidPasswordFormat,
  isValidAppUser,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel,
  moveSocketToChannel,
  removeSocketFromChannel,
  findSocketIdByUserId
} = require('./core');

const app = express();

const certDir = path.join(__dirname, '../certs');
let server;
let usingHttps = false;

if (fs.existsSync(certDir)) {
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const options = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
      server = https.createServer(options, app);
      usingHttps = true;
      console.log('Usando HTTPS con certificados de', certDir);
    } catch (err) {
      console.error('Error leyendo certificados HTTPS, usando HTTP en su lugar:', err);
      server = http.createServer(app);
    }
  } else {
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  transports: ['websocket'],
  perMessageDeflate: false,
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Capa 1: autenticacion admin por HTTP Basic (protege toda la web + handshake WS)
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'cambiar-esta-clave';

// Capa 2: usuarios de la app (usuario:clave separados por coma)
// Ejemplo: APP_USERS=ana:1234,luis:abcd,maria:clave
const APP_USERS_RAW = process.env.APP_USERS || '';
const userStoreDir = path.join(__dirname, '../data');
const userStoreFile = path.join(userStoreDir, 'app-users.json');

const appUsers = buildAppUsers(APP_USERS_RAW);
const runtimeAppUsers = new Map(appUsers);

function loadPersistedUsers() {
  if (!fs.existsSync(userStoreFile)) return;
  try {
    const raw = fs.readFileSync(userStoreFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;

    for (const [userId, password] of Object.entries(parsed)) {
      if (isValidUserIdFormat(userId) && isValidPasswordFormat(password)) {
        runtimeAppUsers.set(userId, password);
      }
    }
  } catch (err) {
    console.error('No se pudo cargar data/app-users.json:', err.message);
  }
}

function persistUsers() {
  try {
    if (!fs.existsSync(userStoreDir)) {
      fs.mkdirSync(userStoreDir, { recursive: true });
    }
    const serialized = JSON.stringify(Object.fromEntries(runtimeAppUsers), null, 2);
    fs.writeFileSync(userStoreFile, serialized, 'utf8');
  } catch (err) {
    console.error('No se pudo guardar data/app-users.json:', err.message);
  }
}

loadPersistedUsers();

app.use(express.static(path.join(__dirname, '../public')));

// Memoria en proceso (futuro: Redis)
const users = new Map(); // socketId -> { userId, channel }
const channels = new Map(); // channelName -> Set<socketId>
const authenticatedSockets = new Map(); // socketId -> userId autenticado en la app

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('register-user', (data) => {
    const { userId, password } = data || {};
    const requestedUserId = String(userId || '').trim();
    const requestedPassword = String(password || '');

    if (!isValidUserIdFormat(requestedUserId)) {
      socket.emit('register-error', { message: 'Usuario invalido (3-20, letras/numeros/._-).' });
      return;
    }

    if (!isValidPasswordFormat(requestedPassword)) {
      socket.emit('register-error', { message: 'Clave invalida (4-80 caracteres).' });
      return;
    }

    if (requestedUserId === AUTH_USER) {
      socket.emit('register-error', { message: 'Ese usuario esta reservado.' });
      return;
    }

    if (runtimeAppUsers.has(requestedUserId)) {
      socket.emit('register-error', { message: 'Ese usuario ya existe.' });
      return;
    }

    runtimeAppUsers.set(requestedUserId, requestedPassword);
    persistUsers();
    socket.emit('register-success', { message: 'Usuario creado. Ahora puedes iniciar sesion.' });
  });

  socket.on('join-channel', (data) => {
    const { userId, password = '', channelName = 'general' } = data || {};
    const requestedUserId = String(userId || '').trim();
    const requestedChannel = String(channelName || 'general').trim() || 'general';
    const existingAuthUser = authenticatedSockets.get(socket.id);

    if (!requestedUserId) {
      socket.emit('auth-error', { message: 'Debes ingresar un usuario valido.' });
      return;
    }

    if (!existingAuthUser) {
      if (!isValidAppUser(requestedUserId, String(password), AUTH_USER, AUTH_PASS, runtimeAppUsers)) {
        socket.emit('auth-error', { message: 'Usuario o clave incorrectos.' });
        return;
      }
      authenticatedSockets.set(socket.id, requestedUserId);
    } else if (existingAuthUser !== requestedUserId) {
      socket.emit('auth-error', { message: 'No puedes cambiar de usuario en esta sesion.' });
      return;
    }

    const authUserId = authenticatedSockets.get(socket.id);

    const movement = moveSocketToChannel(users, channels, socket.id, authUserId, requestedChannel);
    if (movement.previousChannel) {
      socket.leave(movement.previousChannel);
    }
    socket.join(requestedChannel);

    console.log(`${authUserId} se unio al canal ${requestedChannel}`);

    socket.to(requestedChannel).emit('user-joined', {
      userId: authUserId,
      channel: requestedChannel
    });

    const usersInChannel = getUsersInChannel(channels, users, requestedChannel);

    io.to(requestedChannel).emit('channel-users', usersInChannel);
    socket.emit('join-success', { userId: authUserId, channel: requestedChannel });
  });

  socket.on('audio-stream', (data) => {
    const { channel, audioData, mode, transmissionId, mimeType, format, sampleRate, targetUser, targetUsers } = data || {};
    const user = users.get(socket.id);

    if (!user || !channel || !audioData) return;

    const payload = buildAudioPayload(
      { audioData, mode, transmissionId, mimeType, format, sampleRate },
      user.userId
    );

    const resolvedTargets = resolveTargetUsers(targetUsers, targetUser);

    if (resolvedTargets.length > 0) {
      const uniqueTargets = new Set(resolvedTargets);
      for (const [socketId, targetUserData] of users.entries()) {
        if (targetUserData.channel === channel && uniqueTargets.has(targetUserData.userId)) {
          io.to(socketId).emit('audio-broadcast', payload);
        }
      }
      return;
    }

    socket.to(channel).emit('audio-broadcast', payload);
  });

  socket.on('p2p-offer', (data) => {
    const { targetUserId, offer } = data || {};
    const targetSocketId = findSocketIdByUserId(users, targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('p2p-offer', {
        from: users.get(socket.id)?.userId,
        offer
      });
    }
  });

  socket.on('p2p-answer', (data) => {
    const { targetUserId, answer } = data || {};
    const targetSocketId = findSocketIdByUserId(users, targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('p2p-answer', {
        from: users.get(socket.id)?.userId,
        answer
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data || {};
    const targetSocketId = findSocketIdByUserId(users, targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', {
        from: users.get(socket.id)?.userId,
        candidate
      });
    }
  });

  socket.on('voice-activity', (data) => {
    const { channel, isTalking } = data || {};
    const user = users.get(socket.id);

    if (user) {
      socket.to(channel).emit('voice-activity', {
        userId: user.userId,
        isTalking
      });
    }
  });

  socket.on('disconnect', () => {
    const removed = removeSocketFromChannel(users, channels, socket.id);
    if (removed) {
      const { userId, channel } = removed;
      socket.to(channel).emit('user-left', {
        userId,
        channel
      });

      const usersInChannel = getUsersInChannel(channels, users, channel);

      io.to(channel).emit('channel-users', usersInChannel);
      console.log(`${userId} se desconecto del canal ${channel}`);
    }

    authenticatedSockets.delete(socket.id);
    console.log(`Cliente desconectado: ${socket.id}`);
  });

  socket.on('ping', () => {
    socket.emit('pong');
  });
});

server.listen(PORT, HOST, () => {
  const protocol = usingHttps ? 'https' : 'http';
  console.log(`Servidor Walkie-Talkie activo en ${protocol}://${HOST}:${PORT}`);

  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  ${protocol}://${net.address}:${PORT}`);
      }
    }
  }
});
