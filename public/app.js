// Configuracion
const SERVER_URL = window.location.origin;
let socket = null;
let currentStream = null; // Stream del micro (se mantiene vivo entre PTT)

let isRecording = false;
let currentUser = '';
let currentPassword = '';
let currentChannel = 'general';
let usersInChannel = [];
const selectedContacts = new Set();

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
    ]
};
const rtcPeers = new Map();
const rtcRemoteAudioEls = new Map();

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
const audioProfileSelect = document.getElementById('audioProfileSelect');
const audioStats = document.getElementById('audioStats');
const audioProfileHelp = document.getElementById('audioProfileHelp');
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

if (!navigator.mediaDevices) {
    alert('Tu navegador no soporta grabacion de audio. Por favor usa Chrome, Edge o Firefox.');
}

function updateAudioStats() {
    if (!audioStats) return;
    const rtt = lastRttMs === null ? '--' : `${Math.round(lastRttMs)}ms`;
    const peers = rtcPeers.size;
    const connected = Array.from(rtcPeers.values())
        .filter(pc => pc.connectionState === 'connected').length;
    audioStats.textContent = `WebRTC | RTT: ${rtt} | Peers: ${connected}/${peers}`;
}

// ========== WEBRTC (AUDIO EN TIEMPO REAL) ==========

function createPeerConnection(targetUserId) {
    if (rtcPeers.has(targetUserId)) {
        closePeerConnection(targetUserId);
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);

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
        updateAudioStats();
        if (state === 'failed' || state === 'closed') {
            closePeerConnection(targetUserId);
        }
    };

    rtcPeers.set(targetUserId, pc);
    return pc;
}

function closePeerConnection(userId) {
    const pc = rtcPeers.get(userId);
    if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
        rtcPeers.delete(userId);
    }
    const audioEl = rtcRemoteAudioEls.get(userId);
    if (audioEl) {
        audioEl.srcObject = null;
        rtcRemoteAudioEls.delete(userId);
    }
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

async function connectWebRTC(targetUserId) {
    if (!socket || !socket.connected) return;
    if (rtcPeers.has(targetUserId)) {
        const existing = rtcPeers.get(targetUserId);
        if (existing.connectionState === 'connected' || existing.connectionState === 'connecting') {
            return;
        }
        closePeerConnection(targetUserId);
    }

    const stream = await ensureMicStream();
    const pc = createPeerConnection(targetUserId);

    stream.getAudioTracks().forEach(track => {
        pc.addTrack(track, stream);
    });

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket.emit('p2p-offer', { targetUserId, offer });
    console.log(`[WebRTC] Offer sent to ${targetUserId}`);
}

async function handleIncomingOffer(fromUserId, offer) {
    if (!socket || !socket.connected) return;

    const stream = await ensureMicStream();
    let pc = rtcPeers.get(fromUserId);
    if (!pc) {
        pc = createPeerConnection(fromUserId);
        stream.getAudioTracks().forEach(track => {
            pc.addTrack(track, stream);
        });
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('p2p-answer', { targetUserId: fromUserId, answer });
    console.log(`[WebRTC] Answer sent to ${fromUserId}`);
}

async function handleIncomingAnswer(fromUserId, answer) {
    const pc = rtcPeers.get(fromUserId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    console.log(`[WebRTC] Answer received from ${fromUserId}`);
}

async function handleIceCandidate(fromUserId, candidate) {
    const pc = rtcPeers.get(fromUserId);
    if (!pc) return;
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
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
        alert('Ingresa usuario y clave.');
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
            updateAudioStats();
        });

        socket.on('connect_error', (error) => {
            console.error('Error de conexion:', error);
            updateConnectionStatus('disconnected');
            alert('No se pudo conectar al servidor. Verifica que el servidor este corriendo.');
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
        });

        socket.on('auth-error', (data) => {
            alert(data?.message || 'Credenciales invalidas');
            if (socket) socket.disconnect();
            authPanel.style.display = 'block';
            mainPanel.style.display = 'none';
            pttButton.disabled = true;
        });

        socket.on('channel-users', (users) => {
            usersInChannel = users;
            updateUsersList();
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
        // audio-broadcast solo se usa para clips de historial (mode: 'full').
        socket.on('audio-broadcast', (data) => {
            if (data.mode === 'full') {
                addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });
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
        alert('Ingresa usuario y clave para registrarte.');
        return;
    }

    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
        alert('Usuario invalido. Usa 3-20 caracteres: letras, numeros, . _ -');
        return;
    }

    if (password.length < 4) {
        alert('La clave debe tener al menos 4 caracteres.');
        return;
    }

    const registerSocket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000
    });

    let resolved = false;
    const cleanup = () => {
        if (resolved) return;
        resolved = true;
        registerSocket.disconnect();
    };

    registerSocket.on('connect', () => {
        registerSocket.emit('register-user', {
            userId: username,
            password
        });
    });

    registerSocket.on('register-success', (data) => {
        alert(data?.message || 'Usuario creado.');
        cleanup();
    });

    registerSocket.on('register-error', (data) => {
        alert(data?.message || 'No se pudo registrar.');
        cleanup();
    });

    registerSocket.on('connect_error', () => {
        alert('No se pudo conectar para registrar.');
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
function updateUsersList() {
    usersList.innerHTML = '';
    userCount.textContent = usersInChannel.length;
    const availableUsers = new Set(usersInChannel);

    Array.from(selectedContacts).forEach((user) => {
        if (!availableUsers.has(user)) {
            selectedContacts.delete(user);
        }
    });

    usersInChannel.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = 'user-item';
        userItem.id = `user-${user}`;
        
        userItem.innerHTML = `
            <span class="user-name">${user}</span>
            <span class="talking-indicator" style="display: none;">🔴 HABLANDO</span>
            <span class="selected-indicator" style="display: none;">✓ SELECCIONADO</span>
        `;
        
        if (user === currentUser) {
            userItem.classList.add('self');
        }
        
        // Agregar click para seleccionar contacto
        if (user !== currentUser) {
            userItem.style.cursor = 'pointer';
            userItem.addEventListener('click', () => selectContact(user, userItem));
        }
        
        // Mostrar indicador si está seleccionado
        if (selectedContacts.has(user)) {
            userItem.classList.add('selected');
            userItem.querySelector('.selected-indicator').style.display = 'inline';
        }
        
        usersList.appendChild(userItem);
    });
    
    // Actualizar estado del botón PTT basado en si hay contacto seleccionado
    updatePttButtonState();
}

/**
 * Actualizar estado del botón PTT
 */
function updatePttButtonState() {
    if (!pttButton) return;

    if (selectedContacts.size > 0) {
        pttButton.disabled = false;
        if (pttHint) {
            const contacts = Array.from(selectedContacts);
            const preview = contacts.slice(0, 3).join(', ');
            const extra = contacts.length > 3 ? ` +${contacts.length - 3}` : '';
            pttHint.innerHTML = `<strong>${preview}${extra}</strong><br>Mantener presionado para hablar`;
        }
    } else {
        pttButton.disabled = true;
        if (pttHint) {
            pttHint.innerHTML = 'Selecciona un contacto para hablar';
        }
    }
}

/**
 * Seleccionar contacto para envío privado de audio
 */
function selectContact(contactName, contactElement) {
    if (selectedContacts.has(contactName)) {
        selectedContacts.delete(contactName);
        contactElement.classList.remove('selected');
        contactElement.querySelector('.selected-indicator').style.display = 'none';
        closePeerConnection(contactName);
    } else {
        selectedContacts.add(contactName);
        contactElement.classList.add('selected');
        contactElement.querySelector('.selected-indicator').style.display = 'inline';
        // Pre-conectar WebRTC inmediatamente para que el PTT sea instantaneo.
        connectWebRTC(contactName).catch(err => {
            console.error(`[WebRTC] Error pre-conectando con ${contactName}:`, err);
        });
    }

    updatePttButtonState();
    console.log(`Contactos seleccionados: ${Array.from(selectedContacts).join(', ') || 'ninguno'}`);
}

/**
 * Actualizar indicador de quién está hablando
 */
function updateUserTalking(userId, isTalking) {
    const userElement = document.getElementById(`user-${userId}`);
    if (userElement) {
        const indicator = userElement.querySelector('.talking-indicator');
        if (isTalking) {
            userElement.classList.add('talking');
            indicator.style.display = 'inline';
        } else {
            userElement.classList.remove('talking');
            indicator.style.display = 'none';
        }
    }
}

/**
 * Agregar mensaje al historial
 */
function addHistoryMessage(type, content) {
    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    
    const timestamp = new Date().toLocaleTimeString();
    
    if (type === 'system') {
        historyItem.innerHTML = `
            <span class="user-badge user-badge-system">SISTEMA</span>
            <span>${content}</span>
            <span class="timestamp">${timestamp}</span>
        `;
    } else if (type === 'audio') {
        historyItem.innerHTML = `
            <span class="user-badge user-badge-user">${content.user}</span>
            <span>🎤 Mensaje de voz</span>
            <button class="btn-small play-btn" data-audio="${content.audioData}" data-mime="${content.mimeType || 'audio/webm'}">PLAY</button>
            <span class="timestamp">${timestamp}</span>
        `;
        
        // Agregar evento al botón de reproducir
        const playBtn = historyItem.querySelector('.play-btn');
        playBtn.addEventListener('click', () => playAudio(content.audioData, content.mimeType));
    }
    
    historyList.prepend(historyItem);
    
    // Limitar historial a 20 mensajes
    if (historyList.children.length > 20) {
        historyList.removeChild(historyList.lastChild);
    }
}

// ========== FUNCIONES DE AUDIO ==========

/**
 * Iniciar grabación de audio
 */
async function startRecording() {
    if (isRecording) return;

    if (!socket || !socket.connected) {
        alert('No conectado al servidor');
        return;
    }

    try {
        await ensureMicStream();
        isRecording = true;

        // Desmutear el track de audio: el audio empieza a fluir por WebRTC al instante.
        setMicEnabled(true);

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
                    const base64Audio = await blobToBase64(blob);
                    addHistoryMessage('audio', { user: currentUser, audioData: base64Audio, mimeType: mediaRecorderMimeType });

                    // Enviar clip completo para historial del otro usuario.
                    const targetUsers = Array.from(selectedContacts);
                    if (socket && socket.connected && targetUsers.length > 0) {
                        socket.emit('audio-stream', {
                            channel: currentChannel,
                            targetUsers,
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
        alert('No se pudo acceder al microfono. Verifica los permisos.');
    }
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    // Mutear el track: corta el audio en WebRTC al instante.
    setMicEnabled(false);

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

// No cerramos el stream aqui; se mantiene vivo para WebRTC.
// Solo se cierra al desconectarse del servidor.
function closeCurrentStream() {
}

/**
 * Genera audio final WAV para historial
 */
function finalizeCurrentRecording(transmissionId) {
    // Mantener la firma por compatibilidad, pero el historial ahora se genera
    // desde MediaRecorder.onstop usando blobs (ver startRecording).
}
/**
 * Inicia captura PCM en vivo para baja latencia.
 */
function startPcmLiveCapture(stream, transmissionId) {
    if (!AudioContextClass || !stream) return;

    stopPcmLiveCapture();

    try {
        captureAudioContext = new AudioContextClass();
        if (captureAudioContext.state === 'suspended') {
            captureAudioContext.resume().catch(() => {});
        }

        captureSourceNode = captureAudioContext.createMediaStreamSource(stream);
        captureProcessorNode = captureAudioContext.createScriptProcessor(LIVE_PCM_BUFFER_SIZE, 1, 1);
        captureSilenceGainNode = captureAudioContext.createGain();
        captureSilenceGainNode.gain.value = 0;

        captureProcessorNode.onaudioprocess = (event) => {
            if (!isRecording || !socket || !socket.connected) return;
            
            // No enviar audio si no hay contacto seleccionado
            if (selectedContacts.size === 0) return;

            const input = event.inputBuffer.getChannelData(0);
            recordingSampleRate = captureAudioContext.sampleRate || LIVE_PCM_RATE;
            recordingPcmChunks.push(float32ToInt16(input));

            // Si el modo PCM en vivo esta desactivado, solo acumulamos para historial.
            if (!ENABLE_PCM_LIVE_STREAMING) {
                return;
            }

            const downsampled = downsampleBuffer(input, captureAudioContext.sampleRate, runtimePcmRate);
            if (!downsampled || downsampled.length === 0) return;

            const pcm16 = float32ToInt16(downsampled);
            // Agrupar varios bloques para reducir overhead y ser menos sensible al jitter.
            pcmSendBuffer.push(pcm16);
            pcmSendBufferSamples += pcm16.length;
            const targetSamples = Math.round(runtimePcmRate * (PCM_TARGET_PACKET_MS / 1000));
            if (pcmSendBufferSamples < targetSamples) {
                return;
            }

            // En tiempo real no conviene saltar frames: evita huecos por descarte.
            const now = Date.now();
            if (SEND_THROTTLE_MS > 0 && (now - lastSendTime) < SEND_THROTTLE_MS) {
                // Dejamos acumulado el buffer y enviaremos en el siguiente callback.
                return;
            }
            lastSendTime = now;

            const combined = concatInt16Chunks(pcmSendBuffer);
            pcmSendBuffer = [];
            pcmSendBufferSamples = 0;

            // Sin compresión para menor overhead; sin volatile para evitar recortes de paquetes.
            const targetUsers = Array.from(selectedContacts);
            socket.compress(false).emit('audio-stream', {
                channel: currentChannel,
                targetUsers,
                audioData: combined.buffer,
                mode: 'pcm-live',
                format: 'pcm16',
                sampleRate: runtimePcmRate,
                transmissionId
            });
        };

        // Conectar al destino en silencio para asegurar callbacks estables en todos los navegadores.
        captureSourceNode.connect(captureProcessorNode);
        captureProcessorNode.connect(captureSilenceGainNode);
        captureSilenceGainNode.connect(captureAudioContext.destination);
    } catch (err) {
        console.error('Error iniciando audio en vivo PCM:', err);
        stopPcmLiveCapture();
    }
}

function stopPcmLiveCapture() {
    try {
        if (captureProcessorNode) {
            captureProcessorNode.onaudioprocess = null;
            captureProcessorNode.disconnect();
        }
        if (captureSourceNode) {
            captureSourceNode.disconnect();
        }
        if (captureSilenceGainNode) {
            captureSilenceGainNode.disconnect();
        }
        if (captureAudioContext && captureAudioContext.state !== 'closed') {
            captureAudioContext.close().catch(() => {});
        }
    } catch (err) {
        console.error('Error cerrando captura PCM:', err);
    } finally {
        captureProcessorNode = null;
        captureSourceNode = null;
        captureSilenceGainNode = null;
        captureAudioContext = null;
        pcmSendBuffer = [];
        pcmSendBufferSamples = 0;
    }
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
    if (!buffer || outputSampleRate >= inputSampleRate) {
        return buffer ? buffer.slice(0) : new Float32Array(0);
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
        let accum = 0;
        let count = 0;

        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
            accum += buffer[i];
            count++;
        }

        result[offsetResult] = count > 0 ? accum / count : 0;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
    }

    return result;
}

function float32ToInt16(floatBuffer) {
    const int16 = new Int16Array(floatBuffer.length);
    for (let i = 0; i < floatBuffer.length; i++) {
        const s = Math.max(-1, Math.min(1, floatBuffer[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
}
function concatInt16Chunks(chunks) {
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Int16Array(totalLength);
    let offset = 0;

    chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.length;
    });

    return result;
}

function downsampleInt16Buffer(int16Buffer, inputSampleRate, outputSampleRate) {
    if (!int16Buffer || outputSampleRate >= inputSampleRate) {
        return int16Buffer;
    }

    const floatInput = int16ToFloat32(int16Buffer);
    const floatDownsampled = downsampleBuffer(floatInput, inputSampleRate, outputSampleRate);
    return float32ToInt16(floatDownsampled);
}

function pcm16ToWavBuffer(pcm16, sampleRate) {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcm16.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < pcm16.length; i++, offset += 2) {
        view.setInt16(offset, pcm16[i], true);
    }

    return buffer;
}

function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
    }
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

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const result = reader.result;
            if (typeof result === 'string') {
                const commaIndex = result.indexOf(',');
                resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            } else {
                resolve('');
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function base64ToInt16(base64Data) {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Int16Array(bytes.buffer);
}

function payloadToInt16(payload) {
    if (!payload) return new Int16Array(0);

    if (typeof payload === 'string') {
        return base64ToInt16(payload);
    }

    if (payload instanceof ArrayBuffer) {
        return new Int16Array(payload);
    }

    if (ArrayBuffer.isView(payload)) {
        return new Int16Array(payload.buffer, payload.byteOffset, Math.floor(payload.byteLength / 2));
    }

    // Compatibilidad si llega serializado como Buffer de Node.
    if (payload.type === 'Buffer' && Array.isArray(payload.data)) {
        return new Int16Array(new Uint8Array(payload.data).buffer);
    }

    return new Int16Array(0);
}

function int16ToFloat32(int16Buffer) {
    const float32 = new Float32Array(int16Buffer.length);
    for (let i = 0; i < int16Buffer.length; i++) {
        float32[i] = int16Buffer[i] / 0x8000;
    }
    return float32;
}


function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getAdaptivePlaybackLead(now, chunkDuration) {
    if (playbackLastArrivalTime > 0) {
        const interArrival = now - playbackLastArrivalTime;
        const expected = Math.max(0.001, chunkDuration || 0.04);
        const delta = Math.abs(interArrival - expected);
        playbackInterArrivalJitter = (playbackInterArrivalJitter * 0.95) + (delta * 0.05);
    }
    playbackLastArrivalTime = now;

    const adaptiveLead = runtimeBaseLeadSeconds + (playbackInterArrivalJitter * ADAPTIVE_JITTER_GAIN);
    return clampNumber(adaptiveLead, runtimeMinLeadSeconds, runtimeMaxLeadSeconds);
}
function playPcmChunk(base64Pcm, sampleRate, transmissionId) {
    if (!AudioContextClass) return;

    try {
        if (!playbackAudioContext) {
            playbackAudioContext = new AudioContextClass();
        }

        if (playbackAudioContext.state === 'suspended') {
            playbackAudioContext.resume().catch(() => {});
        }

        const pcm16 = payloadToInt16(base64Pcm);
        if (!pcm16 || pcm16.length === 0) return;

        const pcmFloat = int16ToFloat32(pcm16);
        const buffer = playbackAudioContext.createBuffer(1, pcmFloat.length, sampleRate || runtimePcmRate);
        buffer.copyToChannel(pcmFloat, 0, 0);

        const source = playbackAudioContext.createBufferSource();
        const gainNode = playbackAudioContext.createGain();
        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(playbackAudioContext.destination);

        const now = playbackAudioContext.currentTime;
        const adaptiveLead = getAdaptivePlaybackLead(now, buffer.duration);
        lastAdaptiveLeadSeconds = adaptiveLead;
        const minStart = now + adaptiveLead;
        if (playbackNextTime < minStart) {
            playbackNextTime = minStart;
        }

        const currentQueue = playbackNextTime - now;
        lastPlaybackQueueSeconds = currentQueue;
        if (currentQueue > runtimeMaxQueueSeconds) {
            // Evita saltos bruscos: recorta de forma gradual y proporcional el exceso de cola.
            const excess = currentQueue - runtimeMaxQueueSeconds;
            const trimAmount = Math.min(excess * 0.5, runtimeQueueTrimSeconds);
            playbackNextTime = Math.max(minStart, playbackNextTime - trimAmount);
        }

        const startAt = playbackNextTime;
        const endAt = startAt + buffer.duration;
        const fadeTime = Math.min(CHUNK_FADE_SECONDS, buffer.duration / 2);

        // Rampa corta para evitar clics entre chunks.
        gainNode.gain.setValueAtTime(0, startAt);
        gainNode.gain.linearRampToValueAtTime(1, startAt + fadeTime);
        gainNode.gain.setValueAtTime(1, Math.max(startAt + fadeTime, endAt - fadeTime));
        gainNode.gain.linearRampToValueAtTime(0, endAt);

        source.start(startAt);
        playbackNextTime = startAt + buffer.duration;
        updateAudioStats();
        // Diagnostico ligero en consola cada cierto numero de chunks.
        debugPcmChunkCounter++;
        if (debugPcmChunkCounter % 25 === 0) {
            console.debug(
                '[AudioLive] jitter=%sms, cola=%sms, lead=%sms',
                Math.round((playbackInterArrivalJitter || 0) * 1000),
                Math.round((lastPlaybackQueueSeconds || 0) * 1000),
                Math.round((lastAdaptiveLeadSeconds || 0) * 1000)
            );
        }
    } catch (err) {
        console.error('Error reproduciendo chunk PCM:', err);
    }
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

/**
 * Cola de reproducción para chunks en vivo (usado por modo 'full' legacy).
 */
function enqueueLiveAudio(audioData, mimeType = 'audio/webm') {
    liveAudioQueue.push({ audioData, mimeType });
    if (!isPlayingLiveAudio) {
        playNextLiveAudio();
    }
}

function playNextLiveAudio() {
    if (liveAudioQueue.length === 0) {
        isPlayingLiveAudio = false;
        return;
    }

    isPlayingLiveAudio = true;
    const nextChunk = liveAudioQueue.shift();
    playAudioClip(nextChunk.audioData, nextChunk.mimeType, playNextLiveAudio);
}

/**
 * MediaSource Extensions: reproduce WebM en vivo mientras llegan chunks.
 * Los fragmentos de MediaRecorder no son archivos independientes; hay que
 * concatenarlos en un stream y reproducir con MSE.
 */
function appendLiveChunkMSE(base64Audio, mimeType, transmissionId) {
    if (!window.MediaSource) {
        enqueueLiveAudio(base64Audio, mimeType);
        return;
    }
    if (!base64Audio || typeof base64Audio !== 'string') return;

    const mime = mimeType || 'audio/webm';
    const buffer = base64ToArrayBuffer(base64Audio);
    if (!buffer || buffer.byteLength === 0) return;

    const isNewTransmission = transmissionId && transmissionId !== liveTransmissionId;
    const needReinit = !liveMediaSource || liveMediaSource.readyState === 'ended' || isNewTransmission;

    if (needReinit && liveMediaSource) {
        clearLiveMSE();
    }

    liveTransmissionId = transmissionId || liveTransmissionId;
    liveMSEChunkQueue.push(buffer);

    const tryAppendQueued = () => {
        if (liveMSEChunkQueue.length === 0 || !liveSourceBuffer || liveSourceBuffer.updating) return;
        const buf = liveMSEChunkQueue.shift();
        try {
            liveSourceBuffer.appendBuffer(buf);
        } catch (e) {
            console.error('Error appendBuffer:', e);
        }
    };

    if (!liveMediaSource) {
        liveMediaSource = new MediaSource();
        liveAudioEl = document.createElement('audio');
        liveAudioEl.autoplay = true;
        document.body.appendChild(liveAudioEl);

        liveMediaSource.addEventListener('sourceopen', () => {
            try {
                liveSourceBuffer = liveMediaSource.addSourceBuffer(mime);
                liveSourceBuffer.addEventListener('updateend', tryAppendQueued);
                tryAppendQueued();
            } catch (e) {
                console.error('Error creando SourceBuffer:', e);
            }
        });

        liveAudioEl.src = URL.createObjectURL(liveMediaSource);
        liveAudioEl.play().catch((e) => console.warn('Live audio play:', e));
    } else if (liveSourceBuffer && !liveSourceBuffer.updating) {
        tryAppendQueued();
    }

    if (liveMSEEndTimeout) clearTimeout(liveMSEEndTimeout);
    liveMSEEndTimeout = setTimeout(() => {
        if (liveMediaSource && liveMediaSource.readyState === 'open') {
            try {
                liveMediaSource.endOfStream();
            } catch (e) {}
        }
        liveMSEEndTimeout = null;
    }, 600);
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

function clearLiveMSE() {
    if (liveMSEEndTimeout) {
        clearTimeout(liveMSEEndTimeout);
        liveMSEEndTimeout = null;
    }
    liveMSEChunkQueue = [];
    if (liveAudioEl && liveAudioEl.src) {
        URL.revokeObjectURL(liveAudioEl.src);
        liveAudioEl.src = '';
        liveAudioEl.remove();
    }
    liveAudioEl = null;
    liveSourceBuffer = null;
    if (liveMediaSource) {
        try {
            if (liveMediaSource.readyState === 'open') liveMediaSource.endOfStream();
        } catch (e) {}
        liveMediaSource = null;
    }
    liveTransmissionId = null;
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
// Perfiles de audio ya no aplican (WebRTC maneja su propio codec).

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
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
    if (socket) {
        socket.disconnect();
        authPanel.style.display = 'block';
        mainPanel.style.display = 'none';
        usersInChannel = [];
        selectedContacts.clear();
        updatePttButtonState();
        historyList.innerHTML = '';
    }
    stopPingHeartbeat();
});

// Boton PTT - Pointer events (unifica mouse/touch y evita dobles eventos)
function beginPtt(e) {
    if (e) e.preventDefault();
    if (pttButton.disabled) return;
    
    // Verificar que hay un contacto seleccionado
    if (selectedContacts.size === 0) {
        alert('⚠️ Selecciona un contacto primero');
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
    if (typeof pttButton.setPointerCapture === 'function') {
        pttButton.setPointerCapture(e.pointerId);
    }
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
createChannelBtn.addEventListener('click', () => {
    const newChannel = prompt('Nombre del nuevo canal:');
    if (newChannel && newChannel.trim()) {
        const option = document.createElement('option');
        option.value = newChannel.trim();
        option.textContent = `📢 ${newChannel.trim()}`;
        channelSelect.appendChild(option);
        channelSelect.value = newChannel.trim();
        
        // Cambiar al nuevo canal
        if (socket && socket.connected) {
            socket.emit('join-channel', {
                userId: currentUser,
                password: currentPassword,
                channelName: newChannel.trim()
            });
            currentChannel = newChannel.trim();
        }
    }
});

// Prevenir que el botón PTT pierda el foco
pttButton.addEventListener('contextmenu', (e) => e.preventDefault());

updateAudioStats();

console.log('App lista para usar (WebRTC)');
















