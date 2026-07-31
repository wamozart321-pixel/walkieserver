// Configuracion
const SERVER_STORAGE_KEY = 'walkie.serverUrl';

/**
 * Direccion del servidor.
 *
 * En la web basta con el origen desde el que se sirve la pagina, pero la app de
 * Android carga los archivos desde el propio telefono ("capacitor://localhost"),
 * asi que ahi hay que decirle a que servidor conectarse. Se guarda para las
 * siguientes veces.
 */
function isLocalPackage() {
    const p = window.location.protocol;
    return p === 'file:' || p === 'capacitor:' || window.location.hostname === 'localhost' && p !== 'http:' && p !== 'https:';
}

function getSavedServerUrl() {
    try {
        return localStorage.getItem(SERVER_STORAGE_KEY) || '';
    } catch (_) {
        return '';
    }
}

function saveServerUrl(url) {
    try {
        if (url) localStorage.setItem(SERVER_STORAGE_KEY, url);
        else localStorage.removeItem(SERVER_STORAGE_KEY);
    } catch (_) {}
}

function normalizeServerUrl(raw) {
    let url = String(raw || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    return url.replace(/\/+$/, '');
}

function getServerUrl() {
    const saved = getSavedServerUrl();
    if (saved) return saved;
    if (isLocalPackage()) return '';
    return window.location.origin;
}

let SERVER_URL = getServerUrl();
let socket = null;
let currentStream = null; // Stream del micro (se mantiene vivo entre PTT)

let isRecording = false;
let currentUser = '';
let currentPassword = '';
let currentChannel = 'general';
let usersInChannel = [];
const selectedContacts = new Set();

// Estado de la lista de usuarios (para no rehacer el DOM en cada actualizacion).
const userItems = new Map(); // userId -> elemento
const talkingUsers = new Set(); // quien esta hablando ahora mismo

// Audio del historial fuera del DOM.
const HISTORY_LIMIT = 20;
const historyClips = new Map(); // clipId -> { audioData, mimeType }
let historyClipCounter = 0;

let pingSentAtMs = 0;
let lastRttMs = null;
let pingIntervalId = null;

// MediaRecorder solo para guardar historial al soltar PTT
let mediaRecorder = null;
let mediaRecorderChunks = [];
let mediaRecorderMimeType = 'audio/webm';

// WebRTC: audio en tiempo real P2P
// La conexion se establece al seleccionar un contacto (ANTES de pulsar PTT).
// PTT solo mutea/desmutea el track de audio = instantaneo.
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    // Pre-gather candidatos ICE antes incluso de crear la oferta:
    // reduce de forma muy notable el tiempo hasta connectionState='connected'.
    iceCandidatePoolSize: 10
};

/**
 * Pide al servidor la lista de servidores ICE. Permite anadir un TURN por
 * configuracion (.env) sin tocar el codigo: con solo STUN, dos usuarios detras
 * de NAT simetrico o de un firewall corporativo nunca llegan a conectarse.
 */
async function loadIceConfig() {
    if (!SERVER_URL) return;
    try {
        const res = await fetch(`${SERVER_URL}/ice-config`, { cache: 'no-store' });
        if (!res.ok) return;
        const cfg = await res.json();
        if (Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0) {
            RTC_CONFIG.iceServers = cfg.iceServers;
            console.log(`[WebRTC] ${cfg.iceServers.length} servidores ICE cargados del servidor.`);
        }
    } catch (err) {
        console.warn('[WebRTC] No se pudo leer /ice-config, se usan los STUN por defecto:', err.message);
    }
}
const rtcPeers = new Map();
const rtcRemoteAudioEls = new Map();
const rtcDataChannels = new Map(); // userId -> RTCDataChannel ('clip')
const rtcPendingIce = new Map(); // userId -> RTCIceCandidateInit[] (buffer hasta tener remoteDescription)

// ========== E2E (WebCrypto) ==========
// Estrategia: cada usuario genera un par ECDH P-256.
// Al seleccionar un contacto, ambos extremos intercambian la clave publica
// via el canal de senalizacion y derivan una AES-GCM 256 unica por par.
// El servidor solo enruta y nunca ve la clave compartida ni el plano.
const E2E_ALGO = 'ECDH-P256-AESGCM';
let e2eLocalKeyPair = null;
let e2eLocalPublicJwk = null;
const e2eSharedKeys = new Map(); // userId -> CryptoKey AES-GCM
const e2eKeyExchangeSent = new Set(); // userId al que ya enviamos clave
const e2ePendingClips = new Map(); // userId -> Map<msgId, { mimeType, total, parts: ArrayBuffer[] }>

async function ensureLocalKeyPair() {
    if (e2eLocalKeyPair) return e2eLocalKeyPair;
    if (!window.crypto || !window.crypto.subtle) {
        console.warn('[E2E] WebCrypto no disponible: el cifrado E2E queda deshabilitado.');
        return null;
    }
    e2eLocalKeyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
    );
    e2eLocalPublicJwk = await crypto.subtle.exportKey('jwk', e2eLocalKeyPair.publicKey);
    return e2eLocalKeyPair;
}

async function sendPublicKeyTo(targetUserId) {
    if (!socket || !socket.connected) return;
    const keyPair = await ensureLocalKeyPair();
    if (!keyPair || !e2eLocalPublicJwk) return;
    const publicKey = btoa(JSON.stringify(e2eLocalPublicJwk));
    socket.emit('key-exchange', {
        targetUserId,
        publicKey,
        algorithm: E2E_ALGO
    });
    e2eKeyExchangeSent.add(targetUserId);
    console.log(`[E2E] Clave publica enviada a ${targetUserId}`);
}

async function deriveSharedKeyFrom(fromUserId, publicKeyB64) {
    const keyPair = await ensureLocalKeyPair();
    if (!keyPair) return null;
    let remoteJwk;
    try {
        remoteJwk = JSON.parse(atob(publicKeyB64));
    } catch (e) {
        console.error('[E2E] Clave publica recibida invalida:', e);
        return null;
    }
    try {
        const remotePublicKey = await crypto.subtle.importKey(
            'jwk',
            remoteJwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
        const sharedKey = await crypto.subtle.deriveKey(
            { name: 'ECDH', public: remotePublicKey },
            keyPair.privateKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        e2eSharedKeys.set(fromUserId, sharedKey);
        console.log(`[E2E] Clave compartida derivada con ${fromUserId}`);
        updateAudioStats();

        // Reciprocidad: si todavia no enviamos la nuestra, hazlo.
        if (!e2eKeyExchangeSent.has(fromUserId)) {
            await sendPublicKeyTo(fromUserId);
        }
        return sharedKey;
    } catch (err) {
        console.error('[E2E] Error derivando clave compartida:', err);
        return null;
    }
}

async function encryptForPeer(userId, plaintextBuffer) {
    const key = e2eSharedKeys.get(userId);
    if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        plaintextBuffer
    );
    return {
        iv: arrayBufferToBase64(iv.buffer),
        ciphertext: arrayBufferToBase64(ciphertext)
    };
}

async function decryptFromPeer(userId, ivB64, ciphertextB64) {
    const key = e2eSharedKeys.get(userId);
    if (!key) return null;
    const iv = new Uint8Array(base64ToArrayBuffer(ivB64));
    const ciphertext = base64ToArrayBuffer(ciphertextB64);
    if (!ciphertext) return null;
    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );
    return plaintext;
}

// Elementos del DOM
const authPanel = document.getElementById('authPanel');
const mainPanel = document.getElementById('mainPanel');
const connectionIndicator = document.getElementById('connectionIndicator');
const connectionText = document.getElementById('connectionText');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const connectBtn = document.getElementById('connectBtn');
const registerBtn = document.getElementById('registerBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const pttButton = document.getElementById('pttButton');
const pttHint = document.querySelector('.ptt-hint');
const channelSelect = document.getElementById('channelSelect');
const createChannelBtn = document.getElementById('createChannelBtn');
const userCount = document.getElementById('userCount');
const usersList = document.getElementById('usersList');
const historyList = document.getElementById('historyList');
const inviteGroup = document.getElementById('inviteGroup');
const inviteCodeInput = document.getElementById('inviteCodeInput');
const serverGroup = document.getElementById('serverGroup');
const serverUrlInput = document.getElementById('serverUrlInput');
const saveServerBtn = document.getElementById('saveServerBtn');
const serverHint = document.getElementById('serverHint');
const audioProfileSelect = document.getElementById('audioProfileSelect');
const audioStats = document.getElementById('audioStats');
const audioProfileHelp = document.getElementById('audioProfileHelp');
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

if (!navigator.mediaDevices) {
    console.error('Este navegador no soporta captura de audio.');
}

/**
 * Aviso no bloqueante. Sustituye a alert(), que en movil congela la interfaz
 * y obliga a tocar dos veces para seguir.
 */
function showToast(message, kind = 'info', timeout = 4000) {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.className = 'toast-host';
        document.body.appendChild(host);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.textContent = message;
    host.appendChild(toast);

    const remove = () => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 250);
    };

    toast.addEventListener('click', remove);
    setTimeout(remove, timeout);
}

function updateAudioStats() {
    if (!audioStats) return;
    const rtt = lastRttMs === null ? '--' : `${Math.round(lastRttMs)}ms`;
    const peers = rtcPeers.size;
    const connected = Array.from(rtcPeers.values())
        .filter(pc => pc.connectionState === 'connected').length;
    const dcOpen = Array.from(rtcDataChannels.values()).filter(dc => dc.readyState === 'open').length;
    const e2e = e2eSharedKeys.size;
    const kbps = Math.round(getAudioProfile().bitrate / 1000);

    // Deja claro si la voz va en directo o si el mensaje solo llega al soltar.
    let modo;
    if (peers === 0) {
        modo = 'sin conexiones';
    } else if (connected === peers) {
        modo = 'VOZ EN DIRECTO';
    } else if (connected > 0) {
        modo = `directo con ${connected} de ${peers}`;
    } else {
        modo = 'conectando (el mensaje llega al soltar)';
    }

    audioStats.textContent =
        `${modo} | ${kbps}kbps | RTT: ${rtt} | Datos: ${dcOpen} | Cifrado: ${e2e}`;
}

// ========== WEBRTC (AUDIO EN TIEMPO REAL) ==========

function attachDataChannel(targetUserId, dc) {
    rtcDataChannels.set(targetUserId, dc);
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
        console.log(`[WebRTC] DataChannel '${dc.label}' abierto con ${targetUserId}`);
        updateAudioStats();
        refreshConnLabels();
    };
    dc.onclose = () => {
        if (rtcDataChannels.get(targetUserId) === dc) {
            rtcDataChannels.delete(targetUserId);
        }
        updateAudioStats();
        refreshConnLabels();
    };
    dc.onerror = (e) => {
        console.warn(`[WebRTC] DataChannel error con ${targetUserId}:`, e);
    };
    dc.onmessage = (event) => {
        handleDataChannelMessage(targetUserId, event.data);
    };
}

// ========== Seguir activo en segundo plano ==========
//
// Con la pestana en segundo plano (o el movil con la pantalla apagada), el
// navegador ralentiza los temporizadores y el sistema puede suspender la
// aplicacion, con lo que dejarian de llegar mensajes. Dos medidas:
//
//  1. Wake Lock: pide al sistema que no apague la pantalla mientras se esta
//     conectado. Es lo unico que Android respeta sin codigo nativo.
//  2. Una pista de audio en silencio siempre sonando: mientras hay audio
//     activo, ni el navegador ni Android suspenden el proceso.

let wakeLock = null;
let silencioContext = null;
let servicioAndroidActivo = false;

/** El plugin nativo solo existe dentro de la aplicación de Android. */
function pluginSegundoPlano() {
    return window.Capacitor?.Plugins?.BackgroundMode || null;
}

/**
 * Arranca el servicio en primer plano de Android. Es lo unico que impide que el
 * sistema suspenda la aplicacion al minimizarla: muestra una notificacion
 * permanente ("WeasyTalkie esta escuchando") y mantiene el proceso vivo.
 */
async function iniciarServicioAndroid() {
    const plugin = pluginSegundoPlano();
    if (!plugin || servicioAndroidActivo) return;

    try {
        const r = await plugin.start();
        servicioAndroidActivo = true;
        console.log('[Segundo plano] Servicio de Android activo.', r);

        if (r && r.notificaciones === false) {
            showToast(
                'Activa las notificaciones para que la app siga escuchando con la pantalla apagada.',
                'warn', 7000);
        }
    } catch (err) {
        console.warn('[Segundo plano] No se pudo iniciar el servicio:', err.message);
    }
}

async function detenerServicioAndroid() {
    const plugin = pluginSegundoPlano();
    if (!plugin || !servicioAndroidActivo) return;

    try {
        await plugin.stop();
    } catch (err) {
        console.warn('[Segundo plano] No se pudo detener el servicio:', err.message);
    } finally {
        servicioAndroidActivo = false;
    }
}

async function mantenerActivo() {
    // 0. En Android, el servicio nativo es lo que de verdad mantiene la app viva.
    iniciarServicioAndroid();

    // 1. Evitar que la pantalla se apague.
    try {
        if ('wakeLock' in navigator && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
            console.log('[Segundo plano] Pantalla mantenida activa.');
        }
    } catch (err) {
        // Si el navegador lo deniega (o la pestana no esta visible) no pasa nada.
        console.warn('[Segundo plano] Wake Lock no disponible:', err.message);
    }

    // 2. Mantener viva la sesion de audio.
    try {
        if (!silencioContext && AudioContextClass) {
            silencioContext = new AudioContextClass();
            const fuente = silencioContext.createBufferSource();
            // Un buffer de silencio en bucle: consumo despreciable.
            fuente.buffer = silencioContext.createBuffer(1, silencioContext.sampleRate, silencioContext.sampleRate);
            fuente.loop = true;
            const volumen = silencioContext.createGain();
            volumen.gain.value = 0.0001;
            fuente.connect(volumen);
            volumen.connect(silencioContext.destination);
            fuente.start();
        }
        if (silencioContext?.state === 'suspended') await silencioContext.resume();
    } catch (err) {
        console.warn('[Segundo plano] No se pudo mantener la sesion de audio:', err.message);
    }
}

function dejarDeMantenerActivo() {
    detenerServicioAndroid();

    try { wakeLock?.release(); } catch (_) {}
    wakeLock = null;

    try { silencioContext?.close(); } catch (_) {}
    silencioContext = null;
}

// Al volver a primer plano hay que volver a pedir el Wake Lock: el sistema lo
// libera solo cuando la pagina deja de ser visible.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && socket?.connected) {
        mantenerActivo();
    }
});

// ========== Audio en directo a traves del servidor ==========
//
// La conexion directa (P2P) es la via preferida, pero no siempre se puede
// establecer: entre dos redes con NAT estricto hace falta un servidor TURN y no
// siempre hay uno disponible. Antes, en ese caso no habia voz en tiempo real: el
// mensaje solo llegaba al soltar el boton.
//
// Aqui el audio se manda troceado por el mismo WebSocket que ya usa la
// aplicacion, que funciona en cualquier red porque es el servidor al que ambos
// extremos ya estan conectados. Solo se envia a los contactos que no tengan
// conexion directa lista, para no duplicar el audio.

const RELAY_RATE = 16000;        // suficiente para voz
const RELAY_ENVIO_MS = 120;      // tamano de cada envio
const RELAY_RETARDO_MS = 180;    // colchon inicial contra el jitter
const RELAY_COLA_MAX_MS = 900;   // si se acumula mas, se recorta

let relayContext = null;
let relaySource = null;
let relayProcessor = null;
let relayMute = null;
let relayBuffer = [];
let relayMuestras = 0;
let relayTransmisionId = null;

/** Contactos seleccionados que NO tienen conexion directa lista. */
function destinatariosSinDirecto() {
    return Array.from(selectedContacts).filter((u) => {
        const pc = rtcPeers.get(u);
        const conectado = pc && pc.connectionState === 'connected';
        // Si conecto a mitad de la frase, sigue sin estar en servicio: se le
        // manda por el servidor hasta que se suelte el boton.
        return !conectado || peersEsperandoFinTx.has(u);
    });
}

function iniciarRelayEnDirecto(transmisionId) {
    if (!AudioContextClass || !currentStream) return;
    detenerRelayEnDirecto();

    try {
        relayContext = new AudioContextClass();
        if (relayContext.state === 'suspended') relayContext.resume().catch(() => {});

        relaySource = relayContext.createMediaStreamSource(currentStream);
        relayProcessor = relayContext.createScriptProcessor(2048, 1, 1);

        // Se conecta a un destino en silencio: sin esto, algunos navegadores no
        // llaman al procesador de forma constante.
        relayMute = relayContext.createGain();
        relayMute.gain.value = 0;

        relayBuffer = [];
        relayMuestras = 0;
        relayTransmisionId = transmisionId;

        const muestrasPorEnvio = Math.round(RELAY_RATE * (RELAY_ENVIO_MS / 1000));

        relayProcessor.onaudioprocess = (evento) => {
            if (!isRecording || !socket || !socket.connected) return;

            const destinos = destinatariosSinDirecto();
            if (destinos.length === 0) return;   // todos escuchan ya en directo

            const entrada = evento.inputBuffer.getChannelData(0);
            const reducido = reducirFrecuencia(entrada, relayContext.sampleRate, RELAY_RATE);
            if (!reducido.length) return;

            relayBuffer.push(aInt16(reducido));
            relayMuestras += reducido.length;
            if (relayMuestras < muestrasPorEnvio) return;

            const bloque = unirInt16(relayBuffer);
            relayBuffer = [];
            relayMuestras = 0;

            socket.compress(false).emit('audio-stream', {
                channel: currentChannel,
                targetUsers: destinos,
                audioData: bloque.buffer,
                mode: 'pcm-live',
                format: 'pcm16',
                sampleRate: RELAY_RATE,
                transmissionId: relayTransmisionId
            });
        };

        relaySource.connect(relayProcessor);
        relayProcessor.connect(relayMute);
        relayMute.connect(relayContext.destination);
    } catch (err) {
        console.error('[Relay] No se pudo iniciar el audio por servidor:', err);
        detenerRelayEnDirecto();
    }
}

function detenerRelayEnDirecto() {
    try {
        if (relayProcessor) {
            relayProcessor.onaudioprocess = null;
            relayProcessor.disconnect();
        }
        relaySource?.disconnect();
        relayMute?.disconnect();
        if (relayContext && relayContext.state !== 'closed') relayContext.close().catch(() => {});
    } catch (err) {
        console.warn('[Relay] Error al cerrar:', err);
    } finally {
        relayProcessor = null;
        relaySource = null;
        relayMute = null;
        relayContext = null;
        relayBuffer = [];
        relayMuestras = 0;
        relayTransmisionId = null;
    }
}

function reducirFrecuencia(datos, origen, destino) {
    if (!datos || destino >= origen) return datos ? Float32Array.from(datos) : new Float32Array(0);

    const proporcion = origen / destino;
    const salida = new Float32Array(Math.round(datos.length / proporcion));
    let iSalida = 0;
    let iEntrada = 0;

    while (iSalida < salida.length) {
        const siguiente = Math.round((iSalida + 1) * proporcion);
        let suma = 0;
        let cuenta = 0;
        for (let i = iEntrada; i < siguiente && i < datos.length; i++) {
            suma += datos[i];
            cuenta++;
        }
        salida[iSalida++] = cuenta ? suma / cuenta : 0;
        iEntrada = siguiente;
    }
    return salida;
}

function aInt16(datos) {
    const salida = new Int16Array(datos.length);
    for (let i = 0; i < datos.length; i++) {
        const v = Math.max(-1, Math.min(1, datos[i]));
        salida[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return salida;
}

function unirInt16(trozos) {
    const total = trozos.reduce((n, t) => n + t.length, 0);
    const salida = new Int16Array(total);
    let pos = 0;
    for (const t of trozos) { salida.set(t, pos); pos += t.length; }
    return salida;
}

// --- Reproducción de lo que llega por el servidor ---

let repContext = null;
let repSiguiente = 0;
let repTransmision = null;

// Para apagar el indicador de "hablando" cuando dejan de llegar trozos.
const relayFinTimers = new Map();

function aFloat32(int16) {
    const salida = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) salida[i] = int16[i] / 0x8000;
    return salida;
}

function aInt16DesdeCarga(carga) {
    if (!carga) return new Int16Array(0);
    if (typeof carga === 'string') {
        const binario = atob(carga);
        const bytes = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
        return new Int16Array(bytes.buffer);
    }
    if (carga instanceof ArrayBuffer) return new Int16Array(carga);
    if (ArrayBuffer.isView(carga)) {
        return new Int16Array(carga.buffer, carga.byteOffset, Math.floor(carga.byteLength / 2));
    }
    // Por si el servidor lo serializa como Buffer de Node.
    if (carga.type === 'Buffer' && Array.isArray(carga.data)) {
        return new Int16Array(new Uint8Array(carga.data).buffer);
    }
    return new Int16Array(0);
}

/**
 * Encola un trozo recibido. La clave para que no suene entrecortado es
 * programar cada trozo justo detrás del anterior en el reloj del AudioContext,
 * en vez de reproducirlos según llegan.
 */
function reproducirTrozo(carga, frecuencia, transmisionId) {
    if (!AudioContextClass) return;

    try {
        if (!repContext) repContext = new AudioContextClass();
        if (repContext.state === 'suspended') repContext.resume().catch(() => {});

        const pcm = aInt16DesdeCarga(carga);
        if (!pcm.length) return;

        // Transmisión nueva: se reinicia el colchón.
        if (transmisionId && transmisionId !== repTransmision) {
            repTransmision = transmisionId;
            repSiguiente = 0;
        }

        const datos = aFloat32(pcm);
        const buffer = repContext.createBuffer(1, datos.length, frecuencia || RELAY_RATE);
        buffer.copyToChannel(datos, 0, 0);

        const fuente = repContext.createBufferSource();
        fuente.buffer = buffer;
        fuente.connect(repContext.destination);

        const ahora = repContext.currentTime;
        const minimo = ahora + RELAY_RETARDO_MS / 1000;

        if (repSiguiente < minimo) repSiguiente = minimo;

        // Si se acumula demasiado retraso (red irregular), se recorta.
        if (repSiguiente - ahora > RELAY_COLA_MAX_MS / 1000) {
            repSiguiente = minimo;
        }

        fuente.start(repSiguiente);
        repSiguiente += buffer.duration;
    } catch (err) {
        console.error('[Relay] Error reproduciendo:', err);
    }
}

// ========== Entrada en servicio de una conexion ==========
//
// Una conexion P2P tarda entre uno y varios segundos en establecerse. Mientras
// tanto el mensaje se envia igual: al soltar el boton viaja el clip completo por
// el servidor (o por el canal de datos), asi que nadie se queda sin recibirlo.
//
// El problema esta en el momento exacto en que la conexion se completa: si eso
// ocurre a mitad de una transmision, el otro extremo empezaria a oir la frase
// por la mitad y ademas recibiria el clip entero al soltar. Por eso una
// conexion que termina de negociarse mientras estas hablando NO entra en
// servicio hasta que sueltas el boton.

/// Peers que han conectado durante una transmision y esperan a que termine.
const peersEsperandoFinTx = new Set();
/// Contactos cuya conexion se ha aplazado por estar transmitiendo.
const conexionesAplazadas = new Set();

function entrarEnServicio(targetUserId, pc) {
    if (!pc || pc.connectionState !== 'connected') return;

    if (isRecording) {
        // Conecto a media frase: se corta su envio hasta que termine.
        silenciarPeer(pc, true);
        peersEsperandoFinTx.add(targetUserId);
        console.log(`[WebRTC] ${targetUserId} conectado durante una transmision: entra en servicio al soltar.`);
        return;
    }

    silenciarPeer(pc, false);
    peersEsperandoFinTx.delete(targetUserId);
}

/// Corta o restablece el envio a un peer concreto sin renegociar la sesion.
/// (setMicEnabled afecta al track, que es comun a todas las conexiones.)
function silenciarPeer(pc, silenciar) {
    const sender = pc?._audioSender;
    if (!sender || typeof sender.replaceTrack !== 'function') return;

    try {
        if (silenciar) {
            sender.replaceTrack(null);
            return;
        }

        // Al restablecer, si no hay microfono disponible no se toca el sender:
        // ponerle null aqui lo dejaria mudo para siempre.
        const pista = currentStream?.getAudioTracks()[0];
        if (pista) sender.replaceTrack(pista);
    } catch (err) {
        console.warn('[WebRTC] No se pudo cambiar la pista del peer:', err);
    }
}

/**
 * Averigua por que via esta yendo el audio: directa entre los dos equipos o a
 * traves de un servidor TURN. Sirve para saber si el tiempo real funciona y,
 * cuando no, por que.
 */
async function describirConexion(userId) {
    const pc = rtcPeers.get(userId);
    if (!pc || typeof pc.getStats !== 'function') return null;

    try {
        const stats = await pc.getStats();
        let pareja = null;
        const candidatos = new Map();

        stats.forEach((r) => {
            if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidatos.set(r.id, r);
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pareja = r;
        });

        if (!pareja) return { estado: pc.connectionState, via: 'sin ruta' };

        const local = candidatos.get(pareja.localCandidateId);
        const remoto = candidatos.get(pareja.remoteCandidateId);
        const usaRelay = local?.candidateType === 'relay' || remoto?.candidateType === 'relay';

        return {
            estado: pc.connectionState,
            via: usaRelay ? 'TURN (retransmitido)' : 'directa',
            tipoLocal: local?.candidateType,
            tipoRemoto: remoto?.candidateType,
            rtt: pareja.currentRoundTripTime
        };
    } catch (err) {
        return { estado: pc.connectionState, via: 'desconocida', error: err.message };
    }
}

/** Diagnóstico completo, accesible desde la consola del navegador. */
window.diagnostico = async function () {
    const filas = [];
    for (const userId of selectedContacts) {
        const info = await describirConexion(userId);
        filas.push({
            contacto: userId,
            estado: info?.estado ?? 'sin conexión',
            via: info?.via ?? '-',
            'RTT(ms)': info?.rtt ? Math.round(info.rtt * 1000) : '-',
            'canal datos': isPeerDataChannelOpen(userId) ? 'abierto' : 'cerrado',
            cifrado: e2eSharedKeys.has(userId) ? 'sí' : 'no'
        });
    }
    console.table(filas);
    console.log('Servidores ICE en uso:', RTC_CONFIG.iceServers);
    return filas;
};

/// Al terminar de hablar: las conexiones que se completaron mientras tanto
/// entran en servicio, y se lanzan las que se habian aplazado.
function activarConexionesPendientes() {
    for (const userId of Array.from(peersEsperandoFinTx)) {
        const pc = rtcPeers.get(userId);
        peersEsperandoFinTx.delete(userId);
        if (!pc) continue;
        silenciarPeer(pc, false);
        console.log(`[WebRTC] ${userId} entra en servicio (transmision terminada).`);
    }

    for (const userId of Array.from(conexionesAplazadas)) {
        conexionesAplazadas.delete(userId);
        if (!selectedContacts.has(userId)) continue;
        connectWebRTC(userId).catch((e) => console.warn('[WebRTC] Conexion aplazada fallida:', e));
    }

    refreshConnLabels();
    updateAudioStats();
}

function createPeerConnection(targetUserId, isInitiator = false) {
    if (rtcPeers.has(targetUserId)) {
        closePeerConnection(targetUserId);
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    // Estado para "perfect negotiation" (manejo de glare).
    pc._polite = String(currentUser) < String(targetUserId);
    pc._makingOffer = false;
    pc._ignoreOffer = false;

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.connected) {
            socket.emit('ice-candidate', {
                targetUserId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream) return;

        let audioEl = rtcRemoteAudioEls.get(targetUserId);
        if (!audioEl) {
            audioEl = new Audio();
            audioEl.autoplay = true;
            rtcRemoteAudioEls.set(targetUserId, audioEl);
        }
        audioEl.srcObject = remoteStream;
        audioEl.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState || pc.iceConnectionState;
        console.log(`[WebRTC] ${targetUserId}: ${state}`);

        if (state === 'connected') entrarEnServicio(targetUserId, pc);

        updateAudioStats();
        refreshConnLabels();
        if (state === 'failed' || state === 'closed') {
            const stillSelected = selectedContacts.has(targetUserId);
            closePeerConnection(targetUserId);
            // Auto-reconectar si el contacto sigue seleccionado.
            if (stillSelected && socket && socket.connected) {
                console.log(`[WebRTC] Reintentando conexion con ${targetUserId}`);
                setTimeout(() => {
                    if (selectedContacts.has(targetUserId)) {
                        connectWebRTC(targetUserId).catch((e) => console.warn('[WebRTC] Retry fallido:', e));
                    }
                }, 500);
            }
        }
    };

    // Algunas implementaciones disparan iceConnectionState antes que connectionState.
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
            try {
                console.warn(`[WebRTC] ICE failed con ${targetUserId}, intentando restartIce.`);
                pc.restartIce && pc.restartIce();
            } catch (_) {}
        }
    };

    pc.ondatachannel = (event) => {
        if (event.channel && event.channel.label === 'clip') {
            attachDataChannel(targetUserId, event.channel);
        }
    };

    if (isInitiator) {
        try {
            const dc = pc.createDataChannel('clip', { ordered: true });
            attachDataChannel(targetUserId, dc);
        } catch (err) {
            console.warn('[WebRTC] No se pudo crear DataChannel:', err);
        }
    }

    rtcPeers.set(targetUserId, pc);
    return pc;
}

function closePeerConnection(userId) {
    const pc = rtcPeers.get(userId);
    if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.ondatachannel = null;
        pc.close();
        rtcPeers.delete(userId);
    }
    const dc = rtcDataChannels.get(userId);
    if (dc) {
        try { dc.close(); } catch (_) {}
        rtcDataChannels.delete(userId);
    }
    const audioEl = rtcRemoteAudioEls.get(userId);
    if (audioEl) {
        audioEl.srcObject = null;
        rtcRemoteAudioEls.delete(userId);
    }
    e2eSharedKeys.delete(userId);
    e2eKeyExchangeSent.delete(userId);
    e2ePendingClips.delete(userId);
    rtcPendingIce.delete(userId);
    peersEsperandoFinTx.delete(userId);
    conexionesAplazadas.delete(userId);
}

function closeAllPeerConnections() {
    for (const userId of Array.from(rtcPeers.keys())) {
        closePeerConnection(userId);
    }
}

async function ensureMicStream() {
    if (currentStream) {
        const tracks = currentStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === 'live') {
            return currentStream;
        }
    }
    currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });
    // Empieza muteado; PTT lo desmutea.
    currentStream.getAudioTracks().forEach(t => { t.enabled = false; });
    return currentStream;
}

function setMicEnabled(enabled) {
    if (!currentStream) return;
    currentStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
}

// ========== Perfiles de audio ==========
// El selector de la interfaz existia pero no hacia absolutamente nada desde que
// se paso a WebRTC. Ahora ajusta de verdad el codec Opus en el SDP.
const AUDIO_PROFILES = {
    stable: { bitrate: 16000, dtx: 1, fec: 1, ptime: 40, label: 'Red mala: 16 kbps, mas resistente a cortes' },
    balanced: { bitrate: 24000, dtx: 1, fec: 1, ptime: 20, label: 'Balanceado: 24 kbps' },
    'low-latency': { bitrate: 32000, dtx: 0, fec: 0, ptime: 10, label: 'Baja latencia: 32 kbps, paquetes mas cortos' }
};

let currentAudioProfile = 'balanced';

function getAudioProfile() {
    return AUDIO_PROFILES[currentAudioProfile] || AUDIO_PROFILES.balanced;
}

/**
 * Reescribe la linea fmtp de Opus del SDP con los parametros del perfil.
 * Es la forma estandar de limitar el bitrate sin tocar el resto de la sesion.
 */
function applyAudioProfileToSdp(sdp) {
    const profile = getAudioProfile();
    if (!sdp) return sdp;

    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
    if (!opusMatch) return sdp;

    const payload = opusMatch[1];
    const params = [
        `maxaveragebitrate=${profile.bitrate}`,
        `maxplaybackrate=48000`,
        `stereo=0`,
        `useinbandfec=${profile.fec}`,
        `usedtx=${profile.dtx}`
    ].join(';');

    const fmtpRegex = new RegExp(`a=fmtp:${payload} ([^\\r\\n]*)`);
    if (fmtpRegex.test(sdp)) {
        sdp = sdp.replace(fmtpRegex, `a=fmtp:${payload} $1;${params}`);
    } else {
        sdp = sdp.replace(
            new RegExp(`(a=rtpmap:${payload} opus/48000[^\\r\\n]*\\r?\\n)`),
            `$1a=fmtp:${payload} ${params}\r\n`
        );
    }

    if (profile.ptime) {
        sdp = sdp.replace(/a=ptime:\d+/g, `a=ptime:${profile.ptime}`);
        if (!/a=ptime:/.test(sdp)) {
            sdp = sdp.replace(
                new RegExp(`(a=rtpmap:${payload} opus/48000[^\\r\\n]*\\r?\\n)`),
                `$1a=ptime:${profile.ptime}\r\n`
            );
        }
    }

    return sdp;
}

/**
 * Aplica el bitrate tambien por RTCRtpSender, que es lo que respetan Chrome y
 * Edge aunque el SDP pida otra cosa.
 */
async function applyProfileToSenders(pc) {
    if (!pc || typeof pc.getSenders !== 'function') return;
    const profile = getAudioProfile();

    for (const sender of pc.getSenders()) {
        if (!sender.track || sender.track.kind !== 'audio') continue;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = profile.bitrate;
            await sender.setParameters(params);
        } catch (err) {
            console.warn('[WebRTC] No se pudo aplicar el bitrate al sender:', err);
        }
    }
}

async function applyProfileToAllPeers() {
    for (const pc of rtcPeers.values()) {
        await applyProfileToSenders(pc);
    }
}

async function connectWebRTC(targetUserId) {
    if (!socket || !socket.connected) return;

    // Re-usar la conexion existente salvo que este realmente rota.
    if (rtcPeers.has(targetUserId)) {
        const existing = rtcPeers.get(targetUserId);
        const state = existing.connectionState;
        if (state === 'failed' || state === 'closed') {
            closePeerConnection(targetUserId);
        } else {
            // 'new' | 'connecting' | 'connected' | 'disconnected': dejarla seguir.
            return;
        }
    }

    // Disparamos el intercambio E2E en paralelo (no bloquea el media path).
    sendPublicKeyTo(targetUserId).catch((e) => console.warn('[E2E] Error enviando clave:', e));

    // Si estamos hablando, la conexion se aplaza: negociar en mitad de una
    // transmision hace que el otro extremo entre a media frase.
    if (isRecording) {
        conexionesAplazadas.add(targetUserId);
        console.log(`[WebRTC] Conexion con ${targetUserId} aplazada hasta terminar de hablar.`);
        return;
    }

    const stream = await ensureMicStream();
    const pc = createPeerConnection(targetUserId, true);

    stream.getAudioTracks().forEach(track => {
        // Se guarda el sender para poder cortar el envio a este peer concreto.
        pc._audioSender = pc.addTrack(track, stream);
    });

    try {
        pc._makingOffer = true;
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        offer.sdp = applyAudioProfileToSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        await applyProfileToSenders(pc);
        socket.emit('p2p-offer', { targetUserId, offer: pc.localDescription });
        console.log(`[WebRTC] Offer sent to ${targetUserId} (polite=${pc._polite})`);
    } catch (err) {
        console.error('[WebRTC] Error creando offer:', err);
    } finally {
        pc._makingOffer = false;
    }
}

async function handleIncomingOffer(fromUserId, offer) {
    if (!socket || !socket.connected) return;

    // Aseguramos que tenemos la clave local lista para responder al key-exchange.
    sendPublicKeyTo(fromUserId).catch((e) => console.warn('[E2E] Error enviando clave:', e));

    let pc = rtcPeers.get(fromUserId);
    if (!pc) {
        pc = createPeerConnection(fromUserId, false);
        const stream = await ensureMicStream();
        stream.getAudioTracks().forEach(track => {
            pc._audioSender = pc.addTrack(track, stream);
        });

        // Nos llaman mientras hablamos: se acepta la conexion (para no perder la
        // negociacion) pero no se envia nada por ella hasta soltar el boton.
        if (isRecording) {
            silenciarPeer(pc, true);
            peersEsperandoFinTx.add(fromUserId);
        }
    }

    // Perfect negotiation: si llega offer cuando ya estamos negociando,
    // el "polite" hace rollback y acepta la oferta del par; el "impolite" la ignora.
    const offerCollision = pc._makingOffer || pc.signalingState !== 'stable';
    pc._ignoreOffer = !pc._polite && offerCollision;
    if (pc._ignoreOffer) {
        console.warn(`[WebRTC] Glare: ignorando offer de ${fromUserId} (impolite).`);
        return;
    }

    try {
        if (offerCollision && pc._polite) {
            console.warn(`[WebRTC] Glare: rollback local antes de aceptar offer de ${fromUserId} (polite).`);
            await Promise.all([
                pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
                pc.setRemoteDescription(new RTCSessionDescription(offer))
            ]);
        } else {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
        }
        const answer = await pc.createAnswer();
        answer.sdp = applyAudioProfileToSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        await applyProfileToSenders(pc);
        socket.emit('p2p-answer', { targetUserId: fromUserId, answer: pc.localDescription });
        console.log(`[WebRTC] Answer sent to ${fromUserId}`);
        await flushPendingIce(fromUserId);
    } catch (err) {
        console.error('[WebRTC] Error procesando offer:', err);
    }
}

async function handleIncomingAnswer(fromUserId, answer) {
    const pc = rtcPeers.get(fromUserId);
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') {
        console.warn(`[WebRTC] Answer de ${fromUserId} ignorado: signalingState=${pc.signalingState}`);
        return;
    }
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log(`[WebRTC] Answer received from ${fromUserId}`);
        await flushPendingIce(fromUserId);
    } catch (err) {
        console.error('[WebRTC] Error aplicando answer:', err);
    }
}

async function handleIceCandidate(fromUserId, candidate) {
    const pc = rtcPeers.get(fromUserId);
    if (!pc) {
        // Llego ICE antes que la oferta -> bufferear hasta crear el peer.
        bufferPendingIce(fromUserId, candidate);
        return;
    }
    // Sin remoteDescription todavia -> bufferear; si no, addIceCandidate falla.
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
        bufferPendingIce(fromUserId, candidate);
        return;
    }
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        if (!pc._ignoreOffer) {
            console.error('[WebRTC] Error con ICE candidate:', err);
        }
    }
}

function bufferPendingIce(userId, candidate) {
    if (!rtcPendingIce.has(userId)) rtcPendingIce.set(userId, []);
    rtcPendingIce.get(userId).push(candidate);
}

async function flushPendingIce(userId) {
    const queue = rtcPendingIce.get(userId);
    if (!queue || queue.length === 0) return;
    const pc = rtcPeers.get(userId);
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    rtcPendingIce.set(userId, []);
    for (const candidate of queue) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            if (!pc._ignoreOffer) {
                console.error('[WebRTC] Error aplicando ICE bufferizado:', err);
            }
        }
    }
}

// ========== Transporte de clips P2P (DataChannel) ==========
// Formato del mensaje JSON enviado por DataChannel:
//   { v:1, type:'clip', msgId, mimeType, dataB64 }
// El DataChannel viaja sobre SCTP/DTLS: cifrado hop-by-hop entre pares (E2E real, sin servidor).
const DATA_CHANNEL_CLIP_LIMIT = 200 * 1024; // tamano maximo razonable por mensaje

function isPeerDataChannelOpen(userId) {
    const dc = rtcDataChannels.get(userId);
    return !!dc && dc.readyState === 'open';
}

async function sendClipP2P(userId, arrayBuffer, mimeType) {
    if (!isPeerDataChannelOpen(userId)) return false;
    const dc = rtcDataChannels.get(userId);
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return false;
    if (arrayBuffer.byteLength > DATA_CHANNEL_CLIP_LIMIT) {
        console.warn(`[P2P] Clip muy grande (${arrayBuffer.byteLength}b) para DataChannel; usando relay E2E.`);
        return false;
    }
    try {
        const dataB64 = arrayBufferToBase64(arrayBuffer);
        const msg = JSON.stringify({
            v: 1,
            type: 'clip',
            msgId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            mimeType: mimeType || 'audio/webm',
            dataB64
        });
        dc.send(msg);
        console.log(`[P2P] Clip enviado por DataChannel a ${userId} (${arrayBuffer.byteLength}b)`);
        return true;
    } catch (err) {
        console.error('[P2P] Error enviando clip por DataChannel:', err);
        return false;
    }
}

function handleDataChannelMessage(fromUserId, data) {
    if (typeof data !== 'string') return;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (!msg || msg.v !== 1) return;

    if (msg.type === 'clip' && typeof msg.dataB64 === 'string') {
        try {
            // Llega ya descifrado (DTLS), basta con reconstruir y agregar al historial.
            const buf = base64ToArrayBuffer(msg.dataB64);
            if (!buf) return;
            const audioBase64 = arrayBufferToBase64(buf);
            addHistoryMessage('audio', {
                user: fromUserId,
                audioData: audioBase64,
                mimeType: msg.mimeType || 'audio/webm'
            });
        } catch (err) {
            console.error('[P2P] Error procesando clip por DataChannel:', err);
        }
    }
}

async function connectWebRTCToSelectedContacts() {
    for (const userId of selectedContacts) {
        try {
            await connectWebRTC(userId);
        } catch (err) {
            console.error(`[WebRTC] Error conectando con ${userId}:`, err);
        }
    }
}

function startPingHeartbeat() {
    stopPingHeartbeat();
    pingIntervalId = setInterval(() => {
        if (!socket || !socket.connected) return;
        pingSentAtMs = performance.now();
        socket.emit('ping');
    }, 5000);
}

function stopPingHeartbeat() {
    if (pingIntervalId) {
        clearInterval(pingIntervalId);
        pingIntervalId = null;
    }
}

// ========== FUNCIONES PRINCIPALES ==========

/**
 * Conectar al servidor Socket.IO
 */
function connectToServer() {
    const username = usernameInput.value.trim();
    const password = (passwordInput?.value || '').trim();

    if (!username || !password) {
        showToast('Ingresa usuario y clave.', 'warn');
        return;
    }

    if (!SERVER_URL) {
        showToast('Configura primero la dirección del servidor.', 'warn');
        serverUrlInput?.focus();
        return;
    }

    currentUser = username;
    currentPassword = password;

    try {
        socket = io(SERVER_URL, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        updateConnectionStatus('connecting');

        socket.on('connect', () => {
            console.log('Conectado al servidor');
            updateConnectionStatus('connected');
            startPingHeartbeat();
            pingSentAtMs = performance.now();
            socket.emit('ping');

            // Pre-genera el par ECDH local para no introducir latencia al primer key-exchange.
            ensureLocalKeyPair().catch((e) => console.warn('[E2E] No se pudo generar par ECDH:', e));

            socket.emit('join-channel', {
                userId: currentUser,
                password: currentPassword,
                channelName: currentChannel
            });
        });

        socket.on('disconnect', () => {
            console.log('Desconectado del servidor');
            updateConnectionStatus('disconnected');
            pttButton.disabled = true;
            lastRttMs = null;
            stopPingHeartbeat();
            closeAllPeerConnections();
            // Si estabamos transmitiendo, cortar de verdad y soltar el microfono.
            isRecording = false;
            pttButton.classList.remove('recording');
            releaseMicStream();
            dejarDeMantenerActivo();
            updateAudioStats();
        });

        socket.on('connect_error', (error) => {
            console.error('Error de conexion:', error);
            updateConnectionStatus('disconnected');
            showToast('No se pudo conectar al servidor. Comprueba que este encendido.', 'error', 6000);
        });

        socket.on('pong', () => {
            if (pingSentAtMs > 0) {
                lastRttMs = performance.now() - pingSentAtMs;
                pingSentAtMs = 0;
                updateAudioStats();
            }
        });

        socket.on('join-success', (data) => {
            if (data?.userId) currentUser = data.userId;
            if (data?.channel) {
                currentChannel = data.channel;
                channelSelect.value = data.channel;
            }

            authPanel.style.display = 'none';
            mainPanel.style.display = 'grid';
            pttButton.disabled = false;

            // A partir de aqui hay que seguir escuchando aunque la ventana
            // pase a segundo plano.
            mantenerActivo();
        });

        // El mismo usuario ha entrado desde otro dispositivo: el servidor cierra
        // esta sesion para que no queden dos conexiones con el mismo nombre.
        socket.on('session-replaced', (data) => {
            showToast(data?.message || 'Has iniciado sesion en otro dispositivo.', 'warn', 8000);
            authPanel.style.display = 'block';
            mainPanel.style.display = 'none';
            pttButton.disabled = true;
        });

        socket.on('auth-error', (data) => {
            showToast(data?.message || 'Credenciales invalidas', 'error');
            if (socket) socket.disconnect();
            authPanel.style.display = 'block';
            mainPanel.style.display = 'none';
            pttButton.disabled = true;
        });

        socket.on('channel-users', (users) => {
            usersInChannel = users;
            updateUsersList();
        });

        // Lista de canales compartida por el servidor.
        socket.on('channel-list', (canales) => {
            if (!Array.isArray(canales)) return;
            const actual = channelSelect.value;
            canales.forEach(anadirCanalALaLista);
            if (actual) channelSelect.value = actual;
        });

        socket.on('user-joined', (data) => {
            addHistoryMessage('system', `${data.userId} se unio al canal`);
        });

        socket.on('user-left', (data) => {
            addHistoryMessage('system', `${data.userId} abandono el canal`);
        });

        socket.on('voice-activity', (data) => {
            updateUserTalking(data.userId, data.isTalking);
        });

        // El audio en vivo va por WebRTC, no por audio-broadcast.
        // audio-broadcast solo se usa como fallback para clips de historial.
        // Si llega cifrado E2E (AES-GCM) lo desciframos con la clave compartida.
        socket.on('audio-broadcast', async (data) => {
            if (!data) return;

            // Voz en directo a través del servidor, para quien no tiene conexión
            // directa. Antes estos paquetes se descartaban y no había tiempo real.
            if (data.mode === 'pcm-live') {
                reproducirTrozo(data.audioData, data.sampleRate, data.transmissionId);
                updateUserTalking(data.userId, true);

                clearTimeout(relayFinTimers.get(data.userId));
                relayFinTimers.set(data.userId, setTimeout(() => {
                    updateUserTalking(data.userId, false);
                    relayFinTimers.delete(data.userId);
                }, 700));
                return;
            }

            if (data.mode !== 'full') return;
            try {
                if (data.encryption && data.encryption.algorithm === 'AES-GCM') {
                    const plain = await decryptFromPeer(data.userId, data.encryption.iv, data.audioData);
                    if (!plain) {
                        console.warn(`[E2E] No se pudo descifrar clip de ${data.userId} (sin clave compartida).`);
                        return;
                    }
                    const audioBase64 = arrayBufferToBase64(plain);
                    addHistoryMessage('audio', {
                        user: data.userId,
                        audioData: audioBase64,
                        mimeType: data.encryption.mimeType || data.mimeType || 'audio/webm'
                    });
                } else {
                    addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });
                }
            } catch (err) {
                console.error('[E2E] Error procesando audio-broadcast:', err);
            }
        });

        // Recibimos la clave publica del par y derivamos la clave AES-GCM compartida.
        socket.on('key-exchange', async (data) => {
            const { from, publicKey } = data || {};
            if (!from || !publicKey) return;
            try {
                await deriveSharedKeyFrom(from, publicKey);
            } catch (err) {
                console.error('[E2E] Error en key-exchange:', err);
            }
        });

        // Senalizacion WebRTC
        socket.on('p2p-offer', async (data) => {
            const { from, offer } = data || {};
            if (!from || !offer) return;
            try {
                await handleIncomingOffer(from, offer);
            } catch (err) {
                console.error('[WebRTC] Error procesando offer:', err);
            }
        });

        socket.on('p2p-answer', async (data) => {
            const { from, answer } = data || {};
            if (!from || !answer) return;
            try {
                await handleIncomingAnswer(from, answer);
            } catch (err) {
                console.error('[WebRTC] Error procesando answer:', err);
            }
        });

        socket.on('ice-candidate', async (data) => {
            const { from, candidate } = data || {};
            if (!from || !candidate) return;
            try {
                await handleIceCandidate(from, candidate);
            } catch (err) {
                console.error('[WebRTC] Error con ICE candidate:', err);
            }
        });

    } catch (error) {
        console.error('Error al conectar:', error);
        updateConnectionStatus('disconnected');
    }
}
function registerUser() {
    const username = usernameInput.value.trim();
    const password = (passwordInput?.value || '').trim();

    if (!username || !password) {
        showToast('Ingresa usuario y clave para registrarte.', 'warn');
        return;
    }

    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
        showToast('Usuario invalido. Usa 3-20 caracteres: letras, numeros, . _ -', 'warn', 5000);
        return;
    }

    if (password.length < 4) {
        showToast('La clave debe tener al menos 4 caracteres.', 'warn');
        return;
    }

    const inviteCode = (inviteCodeInput?.value || '').trim();

    const registerSocket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000
    });

    // Si el servidor no contesta, no dejar el socket colgando.
    const registerTimeout = setTimeout(() => {
        showToast('El servidor no respondio al registro.', 'error');
        cleanup();
    }, 8000);

    let resolved = false;
    const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(registerTimeout);
        registerSocket.disconnect();
    };

    registerSocket.on('connect', () => {
        registerSocket.emit('register-user', {
            userId: username,
            password,
            code: inviteCode
        });
    });

    registerSocket.on('register-success', (data) => {
        showToast(data?.message || 'Usuario creado.', 'ok');
        cleanup();
    });

    registerSocket.on('register-error', (data) => {
        showToast(data?.message || 'No se pudo registrar.', 'error');
        cleanup();
    });

    registerSocket.on('connect_error', () => {
        showToast('No se pudo conectar para registrar.', 'error');
        cleanup();
    });
}

/**
 * Actualizar estado de conexión en UI
 */
function updateConnectionStatus(status) {
    connectionIndicator.className = 'status-indicator';
    
    switch(status) {
        case 'connected':
            connectionIndicator.classList.add('connected');
            connectionText.textContent = 'Conectado';
            break;
        case 'disconnected':
            connectionIndicator.classList.add('disconnected');
            connectionText.textContent = 'Desconectado';
            break;
        case 'connecting':
            connectionIndicator.classList.add('connecting');
            connectionText.textContent = 'Conectando...';
            break;
    }
}

/**
 * Actualizar lista de usuarios
 */
// Devuelve 'idle' | 'connecting' | 'ready' | 'failed'
function getPeerReadiness(userId) {
    const pc = rtcPeers.get(userId);
    if (!pc) return 'idle';
    const state = pc.connectionState || pc.iceConnectionState;
    if (state === 'failed' || state === 'closed') return 'failed';
    if (state === 'connected') return 'ready';
    return 'connecting';
}

function applyConnLabelToItem(userItem, user) {
    if (!userItem) return;
    userItem.classList.remove('conn-connecting', 'conn-ready', 'conn-failed');
    let label = userItem.querySelector('.conn-label');
    let dot = userItem.querySelector('.conn-dot');
    if (!selectedContacts.has(user)) {
        if (label) label.textContent = '';
        return;
    }
    if (!dot) {
        dot = document.createElement('span');
        dot.className = 'conn-dot';
        userItem.insertBefore(dot, userItem.firstChild);
    }
    if (!label) {
        label = document.createElement('span');
        label.className = 'conn-label';
        userItem.appendChild(label);
    }
    const state = getPeerReadiness(user);
    if (state === 'ready' && peersEsperandoFinTx.has(user)) {
        // Conectó mientras hablabas: entra en servicio al soltar el botón.
        userItem.classList.add('conn-connecting');
        label.textContent = 'LISTO AL SOLTAR';
    } else if (state === 'ready') {
        userItem.classList.add('conn-ready');
        label.textContent = 'LISTO';
    } else if (state === 'failed') {
        userItem.classList.add('conn-failed');
        label.textContent = 'ERROR';
    } else {
        userItem.classList.add('conn-connecting');
        label.textContent = 'CONECTANDO...';
    }
}

function refreshConnLabels() {
    selectedContacts.forEach((user) => {
        const userItem = userItems.get(user);
        applyConnLabelToItem(userItem, user);
    });
    updatePttButtonState();
}

function updateUsersList() {
    userCount.textContent = usersInChannel.length;
    const availableUsers = new Set(usersInChannel);

    Array.from(selectedContacts).forEach((user) => {
        if (!availableUsers.has(user)) {
            selectedContacts.delete(user);
            // Se fue del canal: cerrar su conexion o quedaba una RTCPeerConnection
            // y un elemento <audio> vivos por cada persona que se desconectaba.
            closePeerConnection(user);
        }
    });

    // Se reconcilia la lista en vez de vaciarla y volver a crearla: al reconstruir
    // el DOM entero se perdia el indicador "HABLANDO" de quien estuviera hablando
    // justo en ese momento, y se recreaban todos los listeners.
    for (const [user, item] of Array.from(userItems.entries())) {
        if (!availableUsers.has(user)) {
            item.remove();
            userItems.delete(user);
            talkingUsers.delete(user);
        }
    }

    usersInChannel.forEach((user) => {
        let userItem = userItems.get(user);

        if (!userItem) {
            userItem = document.createElement('div');
            userItem.className = 'user-item';
            // El nombre va en dataset, no en el id: un id construido con texto de
            // otro usuario rompe los selectores y se serializa sin escapar.
            userItem.dataset.user = user;

            // textContent y no innerHTML: el nombre viene de otro usuario.
            const nameEl = document.createElement('span');
            nameEl.className = 'user-name';
            nameEl.textContent = user;

            const talkingEl = document.createElement('span');
            talkingEl.className = 'talking-indicator';
            talkingEl.textContent = '🔴 HABLANDO';
            talkingEl.style.display = 'none';

            const selectedEl = document.createElement('span');
            selectedEl.className = 'selected-indicator';
            selectedEl.textContent = '✓ SELECCIONADO';
            selectedEl.style.display = 'none';

            userItem.append(nameEl, talkingEl, selectedEl);

            if (user === currentUser) {
                userItem.classList.add('self');
            } else {
                userItem.style.cursor = 'pointer';
                userItem.addEventListener('click', () => selectContact(user, userItem));
            }

            userItems.set(user, userItem);
        }

        const isSelected = selectedContacts.has(user);
        userItem.classList.toggle('selected', isSelected);
        userItem.querySelector('.selected-indicator').style.display = isSelected ? 'inline' : 'none';

        const isTalking = talkingUsers.has(user);
        userItem.classList.toggle('talking', isTalking);
        userItem.querySelector('.talking-indicator').style.display = isTalking ? 'inline' : 'none';

        if (isSelected) applyConnLabelToItem(userItem, user);

        // append mueve el elemento si ya estaba: mantiene el orden del servidor.
        usersList.appendChild(userItem);
    });

    updatePttButtonState();
}

function anySelectedReady() {
    for (const user of selectedContacts) {
        if (getPeerReadiness(user) === 'ready') return true;
    }
    return false;
}

function updatePttButtonState() {
    if (!pttButton) return;

    if (selectedContacts.size === 0) {
        pttButton.disabled = true;
        if (pttHint) pttHint.textContent = 'Selecciona un contacto para hablar';
        return;
    }

    // El boton ya NO se bloquea cuando P2P no esta listo. Si la conexion directa
    // no llega a establecerse (firewall, NAT simetrico, redes distintas), el
    // mensaje se envia igualmente por el servidor al soltar el boton. Antes, en
    // esas redes el walkie se quedaba mudo sin posibilidad de hablar.
    pttButton.disabled = false;

    if (!pttHint) return;

    const contacts = Array.from(selectedContacts);
    const preview = contacts.slice(0, 3).join(', ');
    const extra = contacts.length > 3 ? ` +${contacts.length - 3}` : '';

    const listos = contacts.filter((u) => getPeerReadiness(u) === 'ready').length;

    pttHint.textContent = '';
    const quien = document.createElement('strong');
    quien.textContent = `${preview}${extra}`;
    pttHint.appendChild(quien);
    pttHint.appendChild(document.createElement('br'));

    const modo = document.createElement('span');
    if (listos === contacts.length) {
        modo.textContent = 'Mantener presionado para hablar (voz en directo)';
    } else if (listos > 0) {
        modo.style.color = '#f1bf48';
        modo.textContent = `En directo con ${listos} de ${contacts.length}; al resto le llegara al soltar`;
    } else {
        modo.style.color = '#f1bf48';
        modo.textContent = 'Conectando... mientras tanto, el mensaje se envia al soltar';
    }
    pttHint.appendChild(modo);
}

/**
 * Seleccionar contacto para envío privado de audio
 */
function selectContact(contactName, contactElement) {
    if (selectedContacts.has(contactName)) {
        selectedContacts.delete(contactName);
        contactElement.classList.remove('selected', 'conn-connecting', 'conn-ready', 'conn-failed');
        contactElement.querySelector('.selected-indicator').style.display = 'none';
        const lbl = contactElement.querySelector('.conn-label');
        if (lbl) lbl.textContent = '';
        closePeerConnection(contactName);
    } else {
        selectedContacts.add(contactName);
        contactElement.classList.add('selected');
        contactElement.querySelector('.selected-indicator').style.display = 'inline';
        // Pre-conectar WebRTC inmediatamente para que el PTT sea instantaneo.
        connectWebRTC(contactName).catch(err => {
            console.error(`[WebRTC] Error pre-conectando con ${contactName}:`, err);
        });
        // Pintar indicador "CONECTANDO..." de inmediato.
        applyConnLabelToItem(contactElement, contactName);
    }

    updatePttButtonState();
    console.log(`Contactos seleccionados: ${Array.from(selectedContacts).join(', ') || 'ninguno'}`);
}

/**
 * Actualizar indicador de quién está hablando
 */
function updateUserTalking(userId, isTalking) {
    // Se recuerda quien habla para poder repintarlo si la lista se rehace.
    if (isTalking) {
        talkingUsers.add(userId);
    } else {
        talkingUsers.delete(userId);
    }

    const userElement = userItems.get(userId);
    if (!userElement) return;

    const indicator = userElement.querySelector('.talking-indicator');
    userElement.classList.toggle('talking', !!isTalking);
    if (indicator) indicator.style.display = isTalking ? 'inline' : 'none';
}

/**
 * Agregar mensaje al historial
 */
function addHistoryMessage(type, content) {
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';

    const timestamp = new Date().toLocaleTimeString();

    const makeBadge = (text, extraClass) => {
        const badge = document.createElement('span');
        badge.className = `user-badge ${extraClass}`;
        badge.textContent = text;
        return badge;
    };

    const makeTime = () => {
        const time = document.createElement('span');
        time.className = 'timestamp';
        time.textContent = timestamp;
        return time;
    };

    if (type === 'system') {
        const text = document.createElement('span');
        text.textContent = content;
        historyItem.append(makeBadge('SISTEMA', 'user-badge-system'), text, makeTime());
    } else if (type === 'audio') {
        const label = document.createElement('span');
        label.textContent = '🎤 Mensaje de voz';

        // El audio se guarda en un Map, no en un atributo data-*: antes cada clip
        // metia su base64 completo en el HTML (varios MB con 20 mensajes) y ademas
        // quedaba duplicado en memoria.
        const clipId = `clip-${++historyClipCounter}`;
        historyClips.set(clipId, {
            audioData: content.audioData,
            mimeType: content.mimeType || 'audio/webm'
        });

        const playBtn = document.createElement('button');
        playBtn.className = 'btn-small play-btn';
        playBtn.textContent = 'PLAY';
        playBtn.dataset.clipId = clipId;
        playBtn.addEventListener('click', () => {
            const clip = historyClips.get(clipId);
            if (clip) playAudio(clip.audioData, clip.mimeType);
        });

        historyItem.append(
            makeBadge(content.user, 'user-badge-user'),
            label,
            playBtn,
            makeTime()
        );
        historyItem.dataset.clipId = clipId;
    }

    historyList.prepend(historyItem);

    // Limitar historial a 20 mensajes (y soltar el audio de los que salen).
    while (historyList.children.length > HISTORY_LIMIT) {
        const removed = historyList.lastChild;
        if (removed?.dataset?.clipId) historyClips.delete(removed.dataset.clipId);
        historyList.removeChild(removed);
    }
}

function clearHistory() {
    historyList.innerHTML = '';
    historyClips.clear();
}

// ========== FUNCIONES DE AUDIO ==========

/**
 * Iniciar grabación de audio
 */
async function startRecording() {
    if (isRecording) return;

    if (!socket || !socket.connected) {
        showToast('No estas conectado al servidor.', 'error');
        return;
    }

    try {
        await ensureMicStream();
        isRecording = true;

        // Desmutear el track de audio: el audio empieza a fluir por WebRTC al instante.
        setMicEnabled(true);

        // A quien no tenga conexion directa lista se le manda la voz por el
        // servidor, para que tambien la oiga en tiempo real.
        iniciarRelayEnDirecto(`tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

        // Iniciar MediaRecorder en paralelo solo para guardar historial al soltar.
        mediaRecorderChunks = [];
        const preferredTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg'
        ];
        mediaRecorderMimeType = 'audio/webm';
        for (const t of preferredTypes) {
            if (MediaRecorder.isTypeSupported(t)) {
                mediaRecorderMimeType = t;
                break;
            }
        }
        try {
            mediaRecorder = new MediaRecorder(currentStream, { mimeType: mediaRecorderMimeType });
            mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    mediaRecorderChunks.push(event.data);
                }
            };
            mediaRecorder.onstop = async () => {
                try {
                    if (mediaRecorderChunks.length === 0) return;
                    const blob = new Blob(mediaRecorderChunks, { type: mediaRecorderMimeType });
                    const arrayBuffer = await blob.arrayBuffer();
                    const base64Audio = arrayBufferToBase64(arrayBuffer);
                    addHistoryMessage('audio', { user: currentUser, audioData: base64Audio, mimeType: mediaRecorderMimeType });

                    const targetUsers = Array.from(selectedContacts);
                    if (!socket || !socket.connected || targetUsers.length === 0) return;

                    // Por cada destinatario:
                    //   1) Intentar DataChannel P2P (DTLS, no toca el servidor).
                    //   2) Fallback: relay via socket, pero cifrado E2E con AES-GCM.
                    //   3) Ultimo recurso: relay en claro (solo si no hay clave aun).
                    const relayPlain = [];
                    for (const target of targetUsers) {
                        const sentP2P = await sendClipP2P(target, arrayBuffer, mediaRecorderMimeType);
                        if (sentP2P) continue;

                        const encrypted = await encryptForPeer(target, arrayBuffer);
                        if (encrypted) {
                            socket.emit('audio-stream', {
                                channel: currentChannel,
                                targetUser: target,
                                audioData: encrypted.ciphertext,
                                mode: 'full',
                                mimeType: mediaRecorderMimeType,
                                encryption: {
                                    algorithm: 'AES-GCM',
                                    iv: encrypted.iv,
                                    mimeType: mediaRecorderMimeType
                                }
                            });
                            console.log(`[E2E] Clip enviado cifrado a ${target}`);
                        } else {
                            relayPlain.push(target);
                        }
                    }

                    if (relayPlain.length > 0) {
                        console.warn('[E2E] Sin clave compartida con:', relayPlain.join(', '), '- enviando en claro como ultimo recurso.');
                        socket.emit('audio-stream', {
                            channel: currentChannel,
                            targetUsers: relayPlain,
                            audioData: base64Audio,
                            mode: 'full',
                            mimeType: mediaRecorderMimeType
                        });
                    }
                } catch (err) {
                    console.error('Error generando historial:', err);
                } finally {
                    mediaRecorderChunks = [];
                }
            };
            mediaRecorder.start();
        } catch (recErr) {
            console.warn('MediaRecorder no disponible para historial:', recErr);
        }

        socket.emit('voice-activity', {
            channel: currentChannel,
            isTalking: true
        });
    } catch (error) {
        console.error('Error al acceder al microfono:', error);
        showToast('No se pudo acceder al microfono. Revisa los permisos del navegador.', 'error', 6000);
    }
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    // Mutear el track: corta el audio en WebRTC al instante.
    setMicEnabled(false);
    detenerRelayEnDirecto();

    // Las conexiones que se completaron mientras hablabas entran en servicio
    // ahora, y las que se aplazaron se lanzan.
    activarConexionesPendientes();

    // Parar MediaRecorder para generar el clip del historial.
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try {
            mediaRecorder.stop();
        } catch (err) {
            console.error('Error al detener MediaRecorder:', err);
        }
    }

    socket.emit('voice-activity', {
        channel: currentChannel,
        isTalking: false
    });
}

/**
 * Libera el microfono. Se llama al desconectar y tambien al perder la conexion:
 * antes solo se hacia con el boton "Desconectar", asi que si se caia el servidor
 * el indicador de microfono del navegador (o del movil) se quedaba encendido.
 */
function releaseMicStream() {
    if (!currentStream) return;
    currentStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
    });
    currentStream = null;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
}

/**
 * Reproducir un clip de audio base64 (sin crear historial).
 */
function playAudioClip(audioData, mimeType = 'audio/webm', onDone) {
    try {
        const audioBlob = new Blob(
            [Uint8Array.from(atob(audioData), c => c.charCodeAt(0))],
            { type: mimeType || 'audio/webm' }
        );
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        const finish = () => {
            URL.revokeObjectURL(audioUrl);
            if (typeof onDone === 'function') onDone();
        };

        audio.onended = finish;
        audio.onerror = finish;
        audio.play().catch((e) => {
            console.error('Error al reproducir:', e);
            finish();
        });
    } catch (error) {
        console.error('Error al reproducir audio:', error);
        if (typeof onDone === 'function') onDone();
    }
}


function base64ToArrayBuffer(base64) {
    let binary = '';
    try {
        binary = atob(base64);
    } catch (e) {
        return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}


/**
 * Reproducir audio desde historial
 */
function playAudio(audioData, mimeType) {
    playAudioClip(audioData, mimeType);
}

// ========== EVENT LISTENERS ==========

// Botón conectar
connectBtn.addEventListener('click', connectToServer);
if (registerBtn) {
    registerBtn.addEventListener('click', registerUser);
}
// Perfil de audio: ajusta el bitrate y el empaquetado de Opus en caliente.
if (audioProfileSelect) {
    currentAudioProfile = audioProfileSelect.value || 'balanced';
    if (audioProfileHelp) audioProfileHelp.textContent = getAudioProfile().label;

    audioProfileSelect.addEventListener('change', async () => {
        currentAudioProfile = audioProfileSelect.value;
        const profile = getAudioProfile();
        if (audioProfileHelp) audioProfileHelp.textContent = profile.label;

        // El bitrate se puede cambiar sin renegociar la sesion.
        await applyProfileToAllPeers();
        showToast(`Perfil de audio: ${profile.label}`, 'info', 2500);
        updateAudioStats();
    });
}

// Permitir Enter en el input
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') connectToServer();
});
if (passwordInput) {
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') connectToServer();
    });
}

// Botón desconectar
disconnectBtn.addEventListener('click', () => {
    closeAllPeerConnections();
    releaseMicStream();
    dejarDeMantenerActivo();
    if (socket) {
        socket.disconnect();
        authPanel.style.display = 'block';
        mainPanel.style.display = 'none';
        usersInChannel = [];
        selectedContacts.clear();
        userItems.forEach((item) => item.remove());
        userItems.clear();
        talkingUsers.clear();
        updatePttButtonState();
        clearHistory();
    }
    stopPingHeartbeat();
});

// Boton PTT - Pointer events (unifica mouse/touch y evita dobles eventos)
function beginPtt(e) {
    if (e) e.preventDefault();
    if (pttButton.disabled) return;
    
    // Verificar que hay un contacto seleccionado
    if (selectedContacts.size === 0) {
        showToast('Selecciona un contacto primero.', 'warn');
        return;
    }
    
    pttButton.classList.add('recording');
    startRecording();
}

function endPtt(e) {
    if (e) e.preventDefault();
    pttButton.classList.remove('recording');
    stopRecording();
}

pttButton.addEventListener('pointerdown', (e) => {
    // setPointerCapture puede lanzar (NotFoundError) segun el navegador y el tipo
    // de puntero. Si eso ocurriera aqui sin protegerlo, beginPtt no llegaria a
    // ejecutarse y el boton se quedaria pulsado sin transmitir.
    try {
        pttButton.setPointerCapture?.(e.pointerId);
    } catch (_) {}

    beginPtt(e);
});

pttButton.addEventListener('pointerup', endPtt);
pttButton.addEventListener('pointercancel', endPtt);
pttButton.addEventListener('lostpointercapture', () => {
    if (isRecording) {
        pttButton.classList.remove('recording');
        stopRecording();
    }
});
// Cambiar canal
channelSelect.addEventListener('change', () => {
    const newChannel = channelSelect.value;
    
    if (socket && socket.connected) {
        socket.emit('join-channel', {
            userId: currentUser,
            password: currentPassword,
            channelName: newChannel
        });
        currentChannel = newChannel;
    }
});

// Crear nuevo canal
//
// Antes se pedia el nombre con prompt(). Electron no lo implementa (Chromium lo
// quito), asi que en la aplicacion de escritorio el boton no hacia absolutamente
// nada. Ahora se usa un dialogo propio, que ademas funciona igual en movil.
createChannelBtn.addEventListener('click', async () => {
    const nombre = await pedirTexto({
        titulo: 'Nuevo canal',
        descripcion: 'Todos los que entren a este canal podrán hablar entre sí.',
        marcador: 'ventas, almacén, soporte...',
        aceptar: 'Crear canal'
    });

    if (!nombre) return;

    const limpio = nombre.trim().toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9._-]{1,30}$/.test(limpio)) {
        showToast('Nombre no válido. Usa letras, números, punto, guion o guion bajo.', 'warn', 5000);
        return;
    }

    if (!socket || !socket.connected) {
        showToast('No estás conectado al servidor.', 'error');
        return;
    }

    anadirCanalALaLista(limpio);
    channelSelect.value = limpio;
    currentChannel = limpio;

    socket.emit('join-channel', {
        userId: currentUser,
        password: currentPassword,
        channelName: limpio
    });
});

/** Añade un canal al desplegable si no estaba ya. */
function anadirCanalALaLista(nombre) {
    const existe = Array.from(channelSelect.options).some((o) => o.value === nombre);
    if (existe) return;

    const option = document.createElement('option');
    option.value = nombre;
    option.textContent = nombre;
    channelSelect.appendChild(option);
}

/**
 * Diálogo de texto propio. Sustituye a prompt(), que no existe en Electron y
 * queda feo en el móvil.
 */
function pedirTexto({ titulo, descripcion = '', marcador = '', aceptar = 'Aceptar', valor = '' }) {
    return new Promise((resolve) => {
        const fondo = document.createElement('div');
        fondo.className = 'modal-fondo';

        const caja = document.createElement('div');
        caja.className = 'modal-caja';

        const h = document.createElement('h3');
        h.textContent = titulo;

        const p = document.createElement('p');
        p.className = 'modal-descripcion';
        p.textContent = descripcion;

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = marcador;
        input.value = valor;
        input.maxLength = 30;

        const botones = document.createElement('div');
        botones.className = 'modal-botones';

        const btnCancelar = document.createElement('button');
        btnCancelar.className = 'btn-secondary';
        btnCancelar.textContent = 'Cancelar';

        const btnAceptar = document.createElement('button');
        btnAceptar.className = 'btn-primary';
        btnAceptar.textContent = aceptar;

        const cerrar = (resultado) => {
            document.removeEventListener('keydown', alPulsarTecla);
            fondo.remove();
            resolve(resultado);
        };

        const alPulsarTecla = (e) => {
            if (e.key === 'Escape') cerrar(null);
            if (e.key === 'Enter' && document.activeElement === input) cerrar(input.value);
        };

        btnCancelar.addEventListener('click', () => cerrar(null));
        btnAceptar.addEventListener('click', () => cerrar(input.value));
        fondo.addEventListener('click', (e) => { if (e.target === fondo) cerrar(null); });
        document.addEventListener('keydown', alPulsarTecla);

        botones.append(btnCancelar, btnAceptar);
        caja.append(h, p, input, botones);
        fondo.appendChild(caja);
        document.body.appendChild(fondo);

        input.focus();
    });
}

// Prevenir que el botón PTT pierda el foco
pttButton.addEventListener('contextmenu', (e) => e.preventDefault());

updateAudioStats();

// Carga la configuracion ICE antes de que haga falta la primera conexion.
loadIceConfig();

/**
 * Ajusta la pantalla de acceso a como este configurado el servidor:
 * oculta el boton de registro si esta cerrado y pide el codigo si hace falta.
 */
async function loadAppConfig() {
    if (!SERVER_URL) return;
    try {
        const res = await fetch(`${SERVER_URL}/app-config`, { cache: 'no-store' });
        if (!res.ok) return;
        const cfg = await res.json();

        if (registerBtn && cfg.allowRegistration === false) {
            registerBtn.style.display = 'none';
        }
        if (inviteGroup && cfg.requiresInviteCode) {
            inviteGroup.style.display = 'flex';
        }
    } catch (err) {
        console.warn('No se pudo leer /app-config:', err.message);
    }
}

/**
 * Campo de direccion del servidor. Se muestra siempre en la app empaquetada
 * (movil/escritorio) y tambien en la web si ya se habia guardado una direccion,
 * para poder cambiarla sin reinstalar nada.
 */
function setupServerField() {
    if (!serverGroup || !serverUrlInput) return;

    const saved = getSavedServerUrl();
    const necesitaServidor = isLocalPackage();

    if (necesitaServidor || saved) {
        serverGroup.style.display = 'block';
        serverUrlInput.value = saved || '';
    }

    if (serverHint) {
        serverHint.textContent = SERVER_URL
            ? `Conectando a ${SERVER_URL}`
            : 'Escribe la dirección del servidor para poder entrar.';
    }

    // Sin servidor no se puede ni intentar conectar.
    if (!SERVER_URL && connectBtn) connectBtn.disabled = true;

    const guardar = () => {
        const url = normalizeServerUrl(serverUrlInput.value);
        if (!url) {
            showToast('Escribe la dirección del servidor.', 'warn');
            return;
        }
        saveServerUrl(url);
        SERVER_URL = url;
        serverUrlInput.value = url;
        if (serverHint) serverHint.textContent = `Conectando a ${url}`;
        if (connectBtn) connectBtn.disabled = false;
        showToast('Servidor guardado.', 'ok');
        loadIceConfig();
        loadAppConfig();
    };

    saveServerBtn?.addEventListener('click', guardar);
    serverUrlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') guardar();
    });
}

setupServerField();
loadAppConfig();

console.log('App lista para usar (WebRTC)');
