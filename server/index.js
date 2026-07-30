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
  isBcryptHash,
  hashPassword,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel,
  moveSocketToChannel,
  removeSocketFromChannel,
  findSocketIdByUserId,
  areUsersInSameChannel,
  isValidSdpPayload,
  isValidIceCandidate,
  isValidPublicKey
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

// Origenes permitidos. Por defecto '*' para no romper instalaciones existentes,
// pero conviene fijarlo en produccion (ALLOWED_ORIGINS=https://midominio,...).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const io = new Server(server, {
  // websocket puro: sin respaldo de long-polling. Si alguna red con proxy
  // bloquea WebSocket, anadir 'polling' aqui.
  transports: ['websocket'],
  perMessageDeflate: false,
  maxHttpBufferSize: 4 * 1024 * 1024,
  cors: {
    origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Credenciales del administrador. Sirven para entrar como un usuario mas y,
// si WEB_AUTH=true, para proteger toda la web con HTTP Basic.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'cambiar-esta-clave';

// Aviso al arrancar si se dejo la clave de ejemplo.
if (AUTH_PASS === 'cambiar-esta-clave') {
  console.warn('AVISO: AUTH_PASS tiene el valor por defecto. Define uno propio en el archivo .env');
}

// Protege la web entera con HTTP Basic. Antes habia un comentario que decia que
// esto existia, pero el middleware no estaba puesto: cualquiera con acceso a la
// red podia abrir la aplicacion.
const WEB_AUTH = String(process.env.WEB_AUTH || 'false').toLowerCase() === 'true';

// Registro de usuarios desde la pantalla de acceso. Estaba siempre abierto:
// cualquiera podia crear cuentas ilimitadas y entrar al canal.
const ALLOW_REGISTRATION = String(process.env.ALLOW_REGISTRATION ?? 'true').toLowerCase() === 'true';
// Si se define, hace falta escribirla para poder registrarse.
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';

// Capa 2: usuarios de la app (usuario:clave separados por coma)
// Ejemplo: APP_USERS=ana:1234,luis:abcd,maria:clave
const APP_USERS_RAW = process.env.APP_USERS || '';
const userStoreDir = path.join(__dirname, '../data');
const userStoreFile = path.join(userStoreDir, 'app-users.json');

const appUsers = buildAppUsers(APP_USERS_RAW);
const runtimeAppUsers = new Map();
// Hashea cualquier clave en texto plano que venga desde APP_USERS (env).
for (const [u, p] of appUsers.entries()) {
  runtimeAppUsers.set(u, isBcryptHash(p) ? p : hashPassword(p));
}

function loadPersistedUsers() {
  if (!fs.existsSync(userStoreFile)) return false;
  let mutated = false;
  try {
    const raw = fs.readFileSync(userStoreFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;

    for (const [userId, password] of Object.entries(parsed)) {
      if (!isValidUserIdFormat(userId)) continue;

      if (isBcryptHash(password)) {
        runtimeAppUsers.set(userId, password);
        continue;
      }

      // Migracion automatica: clave en texto plano -> hash bcrypt.
      if (isValidPasswordFormat(password)) {
        const hashed = hashPassword(password);
        runtimeAppUsers.set(userId, hashed);
        mutated = true;
        console.log(`Migrando clave de '${userId}' a bcrypt.`);
      }
    }
  } catch (err) {
    console.error('No se pudo cargar data/app-users.json:', err.message);
    return false;
  }
  return mutated;
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

const migratedOnLoad = loadPersistedUsers();
if (migratedOnLoad) {
  persistUsers();
  console.log('Claves migradas a bcrypt y persistidas en data/app-users.json');
}

// HTTP Basic opcional delante de todo (incluidos los archivos estaticos).
if (WEB_AUTH) {
  app.use((req, res, next) => {
    // /health se deja libre para que los monitores externos sigan funcionando.
    if (req.path === '/health') return next();

    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const user = decoded.slice(0, separator);
      const pass = decoded.slice(separator + 1);
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Walkie Talkie"');
    return res.status(401).send('Acceso restringido');
  });
  console.log('Proteccion HTTP Basic activada para toda la web.');
}

app.use(express.static(path.join(__dirname, '../public')));

/**
 * Servidores ICE para WebRTC. Con solo STUN, dos usuarios detras de NAT
 * simetrico o de un firewall corporativo no llegan a conectarse nunca; aqui se
 * puede anadir un TURN por configuracion sin tocar el codigo del cliente.
 */
app.get('/ice-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  if (process.env.TURN_URL) {
    const turn = { urls: process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean) };
    if (process.env.TURN_USER) turn.username = process.env.TURN_USER;
    if (process.env.TURN_PASS) turn.credential = process.env.TURN_PASS;
    iceServers.push(turn);
  }

  res.json({ iceServers });
});

// Ajustes que el cliente necesita saber para pintar bien la pantalla de acceso.
app.get('/app-config', (req, res) => {
  res.json({
    allowRegistration: ALLOW_REGISTRATION,
    requiresInviteCode: ALLOW_REGISTRATION && REGISTRATION_CODE.length > 0
  });
});

// Memoria en proceso (futuro: Redis)
const users = new Map(); // socketId -> { userId, channel }
const channels = new Map(); // channelName -> Set<socketId>
const authenticatedSockets = new Map(); // socketId -> userId autenticado en la app

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

/**
 * Limitador sencillo por socket y por accion (ventana deslizante).
 * Evita que un cliente autenticado sature el canal o pruebe claves en bucle.
 */
const REGISTER_LIMIT = { max: 5, windowMs: 60_000 };
const JOIN_LIMIT = { max: 20, windowMs: 60_000 };
const AUDIO_LIMIT = { max: 120, windowMs: 10_000 };

function allowAction(socket, action, limit) {
  if (!socket._rateBuckets) socket._rateBuckets = new Map();

  const now = Date.now();
  const times = (socket._rateBuckets.get(action) || []).filter((t) => now - t < limit.windowMs);

  if (times.length >= limit.max) {
    socket._rateBuckets.set(action, times);
    return false;
  }

  times.push(now);
  socket._rateBuckets.set(action, times);
  return true;
}

// Tamano maximo por mensaje de audio. maxHttpBufferSize permite hasta 8 MB por
// paquete; un clip de voz normal no pasa de unos cientos de kilobytes.
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

function audioPayloadSize(audioData) {
  if (!audioData) return 0;
  if (typeof audioData === 'string') return audioData.length;
  if (audioData.byteLength !== undefined) return audioData.byteLength;
  if (audioData.length !== undefined) return audioData.length;
  return 0;
}

io.on('connection', (socket) => {
  console.log(`Cliente conectado: ${socket.id}`);

  socket.on('register-user', (data) => {
    const { userId, password, code } = data || {};
    const requestedUserId = String(userId || '').trim();
    const requestedPassword = String(password || '');

    if (!ALLOW_REGISTRATION) {
      socket.emit('register-error', { message: 'El registro esta desactivado. Pide una cuenta al administrador.' });
      return;
    }

    if (REGISTRATION_CODE && String(code || '') !== REGISTRATION_CODE) {
      socket.emit('register-error', { message: 'Codigo de invitacion incorrecto.' });
      return;
    }

    // Sin esto, un script podia crear cuentas sin limite.
    if (!allowAction(socket, 'register', REGISTER_LIMIT)) {
      socket.emit('register-error', { message: 'Demasiados intentos. Espera un momento.' });
      return;
    }

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

    runtimeAppUsers.set(requestedUserId, hashPassword(requestedPassword));
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
      // Limita los intentos de clave por conexion.
      if (!allowAction(socket, 'join', JOIN_LIMIT)) {
        socket.emit('auth-error', { message: 'Demasiados intentos. Espera un momento.' });
        return;
      }

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

    // Sesion unica por usuario. Con dos conexiones del mismo nombre (movil y PC,
    // o dos pestanas), la senalizacion y el audio dirigido iban siempre al primer
    // socket encontrado, asi que la sesion nueva se quedaba muda sin motivo
    // aparente. Ahora la anterior se cierra de forma explicita.
    const previousSocketId = findSocketIdByUserId(users, authUserId);
    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      const removed = removeSocketFromChannel(users, channels, previousSocketId);
      authenticatedSockets.delete(previousSocketId);

      if (removed) {
        socket.to(removed.channel).emit('user-left', {
          userId: removed.userId,
          channel: removed.channel
        });
      }

      if (previousSocket) {
        previousSocket.emit('session-replaced', {
          message: 'Has iniciado sesion en otro dispositivo.'
        });
        previousSocket.disconnect(true);
      }
      console.log(`${authUserId} inicio sesion en otro sitio; se cierra la sesion anterior.`);
    }

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

  // Solo se permite si el socket esta autenticado y el destinatario esta en el mismo canal.
  function requirePeer(targetUserId) {
    if (!authenticatedSockets.has(socket.id)) return null;
    if (typeof targetUserId !== 'string' || !targetUserId.trim()) return null;
    return areUsersInSameChannel(users, socket.id, targetUserId);
  }

  socket.on('audio-stream', (data) => {
    if (!authenticatedSockets.has(socket.id)) return;
    const { channel, audioData, mode, transmissionId, mimeType, format, sampleRate, targetUser, targetUsers, encryption } = data || {};
    const user = users.get(socket.id);

    if (!user || !channel || user.channel !== channel || !audioData) return;

    if (audioPayloadSize(audioData) > MAX_AUDIO_BYTES) {
      console.warn(`Audio descartado de ${user.userId}: supera el tamano maximo.`);
      return;
    }

    if (!allowAction(socket, 'audio', AUDIO_LIMIT)) {
      // Silencioso a proposito: avisar en cada paquete generaria mas trafico.
      return;
    }

    // El servidor jamas decodifica el audio; los datos pueden ser ciphertext.
    const payload = buildAudioPayload(
      { audioData, mode, transmissionId, mimeType, format, sampleRate, encryption },
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
    if (!isValidSdpPayload(offer)) return;
    const targetSocketId = requirePeer(targetUserId);
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('p2p-offer', {
      from: users.get(socket.id)?.userId,
      offer
    });
  });

  socket.on('p2p-answer', (data) => {
    const { targetUserId, answer } = data || {};
    if (!isValidSdpPayload(answer)) return;
    const targetSocketId = requirePeer(targetUserId);
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('p2p-answer', {
      from: users.get(socket.id)?.userId,
      answer
    });
  });

  socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data || {};
    if (!isValidIceCandidate(candidate)) return;
    const targetSocketId = requirePeer(targetUserId);
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('ice-candidate', {
      from: users.get(socket.id)?.userId,
      candidate
    });
  });

  // Intercambio de claves publicas para E2E (ECDH). El servidor solo enruta.
  socket.on('key-exchange', (data) => {
    const { targetUserId } = data || {};
    if (!isValidPublicKey(data)) return;
    const targetSocketId = requirePeer(targetUserId);
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('key-exchange', {
      from: users.get(socket.id)?.userId,
      publicKey: data.publicKey,
      algorithm: data.algorithm || 'ECDH-P256'
    });
  });

  socket.on('voice-activity', (data) => {
    if (!authenticatedSockets.has(socket.id)) return;
    const { channel, isTalking } = data || {};
    const user = users.get(socket.id);

    if (user && user.channel === channel) {
      socket.to(channel).emit('voice-activity', {
        userId: user.userId,
        isTalking: !!isTalking
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
