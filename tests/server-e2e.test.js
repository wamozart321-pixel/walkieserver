// Prueba el servidor de verdad: lo arranca, conecta clientes reales por
// Socket.IO y comprueba el flujo completo (acceso, canal, senalizacion y
// limites de uso).
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 3987;
const URL = `http://localhost:${PORT}`;

let servidor;
const sockets = [];

function conectar() {
  const s = io(URL, { transports: ['websocket'], reconnection: false });
  sockets.push(s);
  return s;
}

function esperar(socket, evento, ms = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(evento, (data) => {
      clearTimeout(t);
      resolve(data ?? {});
    });
  });
}

async function entrar(userId, password = 'clave1234', canal = 'general') {
  const s = conectar();
  await esperar(s, 'connect');
  s.emit('join-channel', { userId, password, channelName: canal });
  const ok = await esperar(s, 'join-success');
  return { socket: s, ok };
}

beforeAll(async () => {
  servidor = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_USERS: 'ana:clave1234,luis:clave1234',
      AUTH_PASS: 'clave-de-prueba',
      ALLOW_REGISTRATION: 'true'
    },
    stdio: 'ignore'
  });

  // Esperar a que el servidor responda.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL}/health`);
      if (res.ok) return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('El servidor de pruebas no arranco');
}, 20000);

afterAll(() => {
  sockets.forEach((s) => { try { s.disconnect(); } catch (_) {} });
  if (servidor) servidor.kill();
});

describe('servidor (extremo a extremo)', () => {
  it('publica la configuracion ICE para WebRTC', async () => {
    const res = await fetch(`${URL}/ice-config`);
    const cfg = await res.json();
    expect(Array.isArray(cfg.iceServers)).toBe(true);
    expect(cfg.iceServers.length).toBeGreaterThan(0);
  });

  it('publica los ajustes de la pantalla de acceso', async () => {
    const res = await fetch(`${URL}/app-config`);
    const cfg = await res.json();
    expect(cfg.allowRegistration).toBe(true);
    expect(cfg.requiresInviteCode).toBe(false);
  });

  it('sirve socket.io desde el propio servidor (sin CDN)', async () => {
    const res = await fetch(`${URL}/vendor/socket.io.min.js`);
    expect(res.status).toBe(200);
  });

  it('rechaza una clave incorrecta', async () => {
    const s = conectar();
    await esperar(s, 'connect');
    s.emit('join-channel', { userId: 'ana', password: 'incorrecta' });
    expect(await esperar(s, 'auth-error')).not.toBeNull();
  });

  it('deja entrar con las credenciales correctas', async () => {
    const { ok } = await entrar('ana');
    expect(ok?.userId).toBe('ana');
    expect(ok?.channel).toBe('general');
  });

  it('reparte la lista de usuarios del canal', async () => {
    const a = await entrar('ana');
    const aviso = esperar(a.socket, 'channel-users');
    await entrar('luis');
    const lista = await aviso;
    expect(lista).toContain('ana');
    expect(lista).toContain('luis');
  });

  it('enruta la senalizacion entre dos usuarios del canal', async () => {
    const a = await entrar('ana');
    const l = await entrar('luis');

    const recibe = esperar(l.socket, 'p2p-offer');
    a.socket.emit('p2p-offer', {
      targetUserId: 'luis',
      offer: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' }
    });

    const oferta = await recibe;
    expect(oferta?.from).toBe('ana');
  });

  it('descarta la senalizacion con formato invalido', async () => {
    const a = await entrar('ana');
    const l = await entrar('luis');

    const recibe = esperar(l.socket, 'p2p-offer', 800);
    a.socket.emit('p2p-offer', { targetUserId: 'luis', offer: { type: 'basura', sdp: 'x' } });
    expect(await recibe).toBeNull();
  });

  it('entrega el audio solo al destinatario indicado', async () => {
    const a = await entrar('ana');
    const l = await entrar('luis');

    const recibe = esperar(l.socket, 'audio-broadcast');
    a.socket.emit('audio-stream', {
      channel: 'general',
      targetUsers: ['luis'],
      audioData: 'QUJD',
      mode: 'full',
      mimeType: 'audio/webm'
    });

    const audio = await recibe;
    expect(audio?.userId).toBe('ana');
    expect(audio?.audioData).toBe('QUJD');
  });

  it('descarta un audio demasiado grande', async () => {
    const a = await entrar('ana');
    const l = await entrar('luis');

    const recibe = esperar(l.socket, 'audio-broadcast', 1500);
    a.socket.emit('audio-stream', {
      channel: 'general',
      targetUsers: ['luis'],
      audioData: 'A'.repeat(3 * 1024 * 1024),
      mode: 'full'
    });

    expect(await recibe).toBeNull();
  });

  it('no permite registrar un usuario que ya existe', async () => {
    const s = conectar();
    await esperar(s, 'connect');
    s.emit('register-user', { userId: 'ana', password: 'otra1234' });
    const err = await esperar(s, 'register-error');
    expect(err?.message).toContain('ya existe');
  });

  it('corta el registro masivo de cuentas', async () => {
    const s = conectar();
    await esperar(s, 'connect');

    let bloqueado = false;
    for (let i = 0; i < 10; i++) {
      s.emit('register-user', { userId: `tmp${i}${Date.now() % 997}`, password: 'clave1234' });
      const r = await esperar(s, 'register-error', 400);
      if (r && String(r.message).includes('Demasiados')) {
        bloqueado = true;
        break;
      }
    }
    expect(bloqueado).toBe(true);
  }, 15000);

  it('cierra la sesion anterior si el mismo usuario entra en otro sitio', async () => {
    const primera = await entrar('ana');
    const aviso = esperar(primera.socket, 'session-replaced');

    const segunda = await entrar('ana');
    expect(segunda.ok?.userId).toBe('ana');

    // La sesion antigua recibe el aviso y se cierra.
    expect(await aviso).not.toBeNull();

    // Y la senalizacion llega a la sesion nueva, no a la vieja.
    const luis = await entrar('luis');
    const recibe = esperar(segunda.socket, 'p2p-offer');
    luis.socket.emit('p2p-offer', {
      targetUserId: 'ana',
      offer: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' }
    });
    expect((await recibe)?.from).toBe('luis');
  });

  it('avisa al canal cuando alguien se va', async () => {
    const a = await entrar('ana');
    const l = await entrar('luis');

    const salida = esperar(a.socket, 'user-left');
    l.socket.disconnect();
    expect((await salida)?.userId).toBe('luis');
  });
});
