const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

// Configuración inicial
const app = express();

// Intentar arrancar con HTTPS si existen certificados en ../certs
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
    origin: "*", // En producción, especifica tu dominio
    methods: ["GET", "POST"]
  }
});
const SERVER_URL = '';
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';  // Esto permite conexiones desde cualquier IP


app.use(express.static(path.join(__dirname, '../public')));

// Almacenamiento en memoria (luego migraremos a Redis)
const users = new Map();        // socketId -> { userId, channel }
const channels = new Map();     // channelName -> Set de socketIds

// Ruta de salud para pruebas rápidas
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// Gestión de conexiones Socket.IO
io.on('connection', (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // ===== EVENTOS PRINCIPALES =====
  
  // 1. Unirse a un canal
  socket.on('join-channel', (data) => {
    const { userId, channelName = 'general' } = data;
    
    // Salir del canal anterior si existe
    if (users.has(socket.id)) {
      const oldChannel = users.get(socket.id).channel;
      channels.get(oldChannel)?.delete(socket.id);
    }
    
    // Guardar usuario
    users.set(socket.id, { userId, channel: channelName });
    
    // Unirse al nuevo canal (Socket.IO rooms)
    socket.join(channelName);
    
    // Añadir al mapa de canales
    if (!channels.has(channelName)) {
      channels.set(channelName, new Set());
    }
    channels.get(channelName).add(socket.id);
    
    console.log(`👤 ${userId} se unió al canal ${channelName}`);
    
    // Notificar a otros en el canal
    socket.to(channelName).emit('user-joined', {
      userId,
      channel: channelName
    });
    
    // Enviar lista de usuarios en el canal
    const usersInChannel = Array.from(channels.get(channelName))
      .map(id => users.get(id)?.userId)
      .filter(Boolean);
    
    io.to(channelName).emit('channel-users', usersInChannel);
  });

  // 2. Transmitir audio (modo servidor)
  socket.on('audio-stream', (data) => {
    const { channel, audioData, mode, transmissionId, mimeType, format, sampleRate, targetUser } = data;
    const user = users.get(socket.id);
    
    if (!user || !channel || !audioData) return;

    const payload = {
      userId: user.userId,
      audioData: audioData,
      mode: mode || 'full',
      transmissionId: transmissionId || null,
      mimeType: mimeType || 'audio/webm',
      format: mode === 'pcm-live' ? (format || 'pcm16') : (format || null),
      sampleRate: mode === 'pcm-live' ? (sampleRate || 16000) : (sampleRate || null)
    };
    
    // Si hay targetUser, enviar solo a ese usuario específico
    if (targetUser) {
      for (let [socketId, targetUserData] of users.entries()) {
        if (targetUserData.userId === targetUser && targetUserData.channel === channel) {
          io.to(socketId).emit('audio-broadcast', payload);
          break;
        }
      }
    } else {
      // Si no hay targetUser, reenviar a todos en el canal EXCEPTO al remitente (broadcast)
      socket.to(channel).emit('audio-broadcast', payload);
    }
  });

  // 3. Modo P2P (para redes locales)
  socket.on('p2p-offer', (data) => {
    const { targetUserId, offer } = data;
    // Buscar socket del destinatario y reenviar oferta WebRTC
    for (let [socketId, user] of users.entries()) {
      if (user.userId === targetUserId) {
        io.to(socketId).emit('p2p-offer', {
          from: users.get(socket.id)?.userId,
          offer
        });
        break;
      }
    }
  });

  socket.on('p2p-answer', (data) => {
    const { targetUserId, answer } = data;
    for (let [socketId, user] of users.entries()) {
      if (user.userId === targetUserId) {
        io.to(socketId).emit('p2p-answer', {
          from: users.get(socket.id)?.userId,
          answer
        });
        break;
      }
    }
  });

  socket.on('ice-candidate', (data) => {
    const { targetUserId, candidate } = data;
    for (let [socketId, user] of users.entries()) {
      if (user.userId === targetUserId) {
        io.to(socketId).emit('ice-candidate', {
          from: users.get(socket.id)?.userId,
          candidate
        });
        break;
      }
    }
  });

  // 4. Indicadores de voz (quién está hablando)
  socket.on('voice-activity', (data) => {
    const { channel, isTalking } = data;
    const user = users.get(socket.id);
    
    if (user) {
      socket.to(channel).emit('voice-activity', {
        userId: user.userId,
        isTalking
      });
    }
  });

  // 5. Desconexión
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    
    if (user) {
      const { userId, channel } = user;
      
      // Eliminar del canal
      channels.get(channel)?.delete(socket.id);
      if (channels.get(channel)?.size === 0) {
        channels.delete(channel);
      }
      
      // Notificar a otros
      socket.to(channel).emit('user-left', {
        userId,
        channel
      });
      
      // Actualizar lista de usuarios
      const usersInChannel = Array.from(channels.get(channel) || [])
        .map(id => users.get(id)?.userId)
        .filter(Boolean);
      
      io.to(channel).emit('channel-users', usersInChannel);
      
      users.delete(socket.id);
      console.log(`👋 ${userId} se desconectó del canal ${channel}`);
    }
    
    console.log(`🔌 Cliente desconectado: ${socket.id}`);
  });

  // 6. Heartbeat (para mantener conexión activa)
  socket.on('ping', () => {
    socket.emit('pong');
  });
});

// Iniciar servidor
server.listen(PORT, HOST, () => {
    const protocol = usingHttps ? 'https' : 'http';
    console.log(`
    ╔════════════════════════════════════╗
    ║  🎤 Servidor Walkie-Talkie activo  ║
    ╠════════════════════════════════════╣
    ║  Puerto: ${PORT}                   ║
    ║  Host: ${HOST} (todas las interfaces)║
    ║  IPs disponibles:                  ║
    `);
    
    // Mostrar todas las IPs disponibles
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  ║  ${protocol}://${net.address}:${PORT}`);
            }
        }
    }
    console.log(`  ╚════════════════════════════════════╝`);
});

