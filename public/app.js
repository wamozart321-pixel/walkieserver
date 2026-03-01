// Configuracion
// Conectar al mismo origen desde el que se sirve la pagina (funciona en PC y movil)
const SERVER_URL = window.location.origin; // ejemplo: https://192.168.137.1:3000
let socket = null;
let currentStream = null;

let isRecording = false;
let currentTransmissionId = null;
let recordingPcmChunks = [];
let recordingSampleRate = 16000;
let currentUser = '';
let currentPassword = '';
let currentChannel = 'general';
let usersInChannel = [];
let historyMessages = [];
const selectedContacts = new Set(); // Para envio selectivo de audio (multi-contacto)
// Perfil optimizado: baja latencia en tiempo real
const IS_MOBILE_DEVICE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const LIVE_PCM_RATE = 16000;
const HISTORY_WAV_MAX_RATE = 24000;
const LIVE_PCM_BUFFER_SIZE = IS_MOBILE_DEVICE ? 4096 : 4096; // Móvil: chunks más estables, menos carga de CPU
const LIVE_PLAYBACK_LEAD_SECONDS = IS_MOBILE_DEVICE ? 0.22 : 0.14; // Jitter buffer inicial un poco más amplio
const CHUNK_FADE_SECONDS = 0.002; // Fade más corto
const MAX_PLAYBACK_QUEUE_SECONDS = IS_MOBILE_DEVICE ? 0.9 : 0.7; // Tope de cola antes de recortar
const PLAYBACK_QUEUE_TRIM_SECONDS = IS_MOBILE_DEVICE ? 0.08 : 0.05;
const ADAPTIVE_LEAD_MIN_SECONDS = IS_MOBILE_DEVICE ? 0.18 : 0.10;
const ADAPTIVE_LEAD_MAX_SECONDS = IS_MOBILE_DEVICE ? 0.35 : 0.25;
const ADAPTIVE_JITTER_GAIN = 1.8;
// En tiempo real no conviene saltar frames: evita huecos por descarte.
const SEND_THROTTLE_MS = 0;
let lastSendTime = 0;
const liveAudioQueue = [];
let isPlayingLiveAudio = false;
const liveTransmissionsReceived = new Set();
let captureAudioContext = null;
let captureSourceNode = null;
let captureProcessorNode = null;
let captureSilenceGainNode = null;
let playbackAudioContext = null;
let playbackNextTime = 0;
let playbackLastArrivalTime = 0;
let playbackInterArrivalJitter = 0;
let runtimePcmRate = LIVE_PCM_RATE;
let runtimeBaseLeadSeconds = LIVE_PLAYBACK_LEAD_SECONDS;
let runtimeMinLeadSeconds = ADAPTIVE_LEAD_MIN_SECONDS;
let runtimeMaxLeadSeconds = ADAPTIVE_LEAD_MAX_SECONDS;
let runtimeMaxQueueSeconds = MAX_PLAYBACK_QUEUE_SECONDS;
let runtimeQueueTrimSeconds = PLAYBACK_QUEUE_TRIM_SECONDS;
let currentAudioProfile = 'balanced';
let lastPlaybackQueueSeconds = 0;
let lastAdaptiveLeadSeconds = LIVE_PLAYBACK_LEAD_SECONDS;
let lastStatsUpdateMs = 0;
let pingSentAtMs = 0;
let lastRttMs = null;
let pingIntervalId = null;
// Control de la acumulación de audio en cola
let maxQueueSize = IS_MOBILE_DEVICE ? 8 : 12;
let currentTransmissionIdPlaying = null;

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
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

// Verificar compatibilidad con el navegador
if (!navigator.mediaDevices || !AudioContextClass) {
    alert('Tu navegador no soporta grabación de audio. Por favor usa Chrome, Edge o Firefox.');
}

const AUDIO_PROFILE_CONFIG = {
    stable: {
        pcmRate: 12000,
        baseLead: IS_MOBILE_DEVICE ? 0.28 : 0.20,
        minLead: IS_MOBILE_DEVICE ? 0.24 : 0.16,
        maxLead: IS_MOBILE_DEVICE ? 0.50 : 0.35,
        maxQueue: IS_MOBILE_DEVICE ? 1.10 : 0.85,
        queueTrim: IS_MOBILE_DEVICE ? 0.06 : 0.04
    },
    balanced: {
        pcmRate: 16000,
        baseLead: LIVE_PLAYBACK_LEAD_SECONDS,
        minLead: ADAPTIVE_LEAD_MIN_SECONDS,
        maxLead: ADAPTIVE_LEAD_MAX_SECONDS,
        maxQueue: MAX_PLAYBACK_QUEUE_SECONDS,
        queueTrim: PLAYBACK_QUEUE_TRIM_SECONDS
    },
    'low-latency': {
        pcmRate: 16000,
        baseLead: IS_MOBILE_DEVICE ? 0.18 : 0.10,
        minLead: IS_MOBILE_DEVICE ? 0.15 : 0.08,
        maxLead: IS_MOBILE_DEVICE ? 0.30 : 0.20,
        maxQueue: IS_MOBILE_DEVICE ? 0.70 : 0.50,
        queueTrim: IS_MOBILE_DEVICE ? 0.10 : 0.07
    }
};

function formatMetricMs(valueSeconds) {
    if (valueSeconds === null || valueSeconds === undefined || Number.isNaN(valueSeconds)) return '--';
    return `${Math.round(valueSeconds * 1000)}ms`;
}

function updateAudioStats(force = false) {
    if (!audioStats) return;
    const now = performance.now();
    if (!force && (now - lastStatsUpdateMs) < 500) return;
    lastStatsUpdateMs = now;

    const jitter = formatMetricMs(playbackInterArrivalJitter);
    const queue = formatMetricMs(lastPlaybackQueueSeconds);
    const lead = formatMetricMs(lastAdaptiveLeadSeconds);
    const rtt = lastRttMs === null ? '--' : `${Math.round(lastRttMs)}ms`;
    audioStats.textContent = `Perfil: ${currentAudioProfile} | RTT: ${rtt} | Jitter: ${jitter} | Cola: ${queue} | Lead: ${lead}`;
}

function applyAudioProfile(profileName) {
    const profile = AUDIO_PROFILE_CONFIG[profileName] || AUDIO_PROFILE_CONFIG.balanced;
    currentAudioProfile = AUDIO_PROFILE_CONFIG[profileName] ? profileName : 'balanced';

    runtimePcmRate = profile.pcmRate;
    runtimeBaseLeadSeconds = profile.baseLead;
    runtimeMinLeadSeconds = profile.minLead;
    runtimeMaxLeadSeconds = profile.maxLead;
    runtimeMaxQueueSeconds = profile.maxQueue;
    runtimeQueueTrimSeconds = profile.queueTrim;

    if (audioProfileSelect) {
        audioProfileSelect.value = currentAudioProfile;
    }
    localStorage.setItem('audio_profile', currentAudioProfile);
    updateAudioStats(true);
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
            playbackNextTime = 0;
            playbackLastArrivalTime = 0;
            playbackInterArrivalJitter = 0;
            lastPlaybackQueueSeconds = 0;
            lastAdaptiveLeadSeconds = runtimeBaseLeadSeconds;
            lastRttMs = null;
            stopPingHeartbeat();
            updateAudioStats(true);
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
            mainPanel.style.display = 'block';
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
            addHistoryMessage('system', `?? ${data.userId} se unio al canal`);
        });

        socket.on('user-left', (data) => {
            addHistoryMessage('system', `?? ${data.userId} abandono el canal`);
        });

        socket.on('voice-activity', (data) => {
            updateUserTalking(data.userId, data.isTalking);
        });

        socket.on('audio-broadcast', (data) => {
            if (data.mode === 'pcm-live') {
                if (data.transmissionId) {
                    liveTransmissionsReceived.add(data.transmissionId);
                }
                playPcmChunk(data.audioData, data.sampleRate || LIVE_PCM_RATE, data.transmissionId);
                return;
            }

            if (data.mode === 'live') {
                if (data.transmissionId) {
                    liveTransmissionsReceived.add(data.transmissionId);
                }
                enqueueLiveAudio(data.audioData, data.mimeType);
                return;
            }

            if (data.mode === 'full') {
                addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });
                const hadLive = data.transmissionId && liveTransmissionsReceived.has(data.transmissionId);
                if (!hadLive) {
                    playAudioClip(data.audioData, data.mimeType);
                } else if (data.transmissionId) {
                    liveTransmissionsReceived.delete(data.transmissionId);
                }
                return;
            }

            enqueueLiveAudio(data.audioData, data.mimeType);
            addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });
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
    } else {
        selectedContacts.add(contactName);
        contactElement.classList.add('selected');
        contactElement.querySelector('.selected-indicator').style.display = 'inline';
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
        currentStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: runtimePcmRate,
                // Mejor calidad para PTT; evita compresion/agresividad del micro.
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        recordingPcmChunks = [];
        recordingSampleRate = runtimePcmRate;
        currentTransmissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        isRecording = true;

        startPcmLiveCapture(currentStream, currentTransmissionId);

        // Notificar que estas hablando
        socket.emit('voice-activity', {
            channel: currentChannel,
            isTalking: true
        });
    } catch (error) {
        console.error('Error al acceder al microfono:', error);
        alert('No se pudo acceder al microfono. Verifica los permisos.');
    }
}

/**
 * Detener grabacion
 */
function stopRecording() {
    if (!isRecording) return;

    const transmissionId = currentTransmissionId;
    isRecording = false;
    currentTransmissionId = null;

    stopPcmLiveCapture();
    finalizeCurrentRecording(transmissionId);
    closeCurrentStream();

    // Notificar que dejaste de hablar
    socket.emit('voice-activity', {
        channel: currentChannel,
        isTalking: false
    });
}

/**
 * Cierra stream de captura actual
 */
function closeCurrentStream() {
    if (!currentStream) return;
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
}

/**
 * Genera audio final WAV para historial
 */
function finalizeCurrentRecording(transmissionId) {
    const chunks = recordingPcmChunks.slice();
    recordingPcmChunks = [];
    if (chunks.length === 0) return;

    try {
        let pcm16 = concatInt16Chunks(chunks);
        let wavRate = recordingSampleRate || LIVE_PCM_RATE;

        if (wavRate > HISTORY_WAV_MAX_RATE) {
            pcm16 = downsampleInt16Buffer(pcm16, wavRate, HISTORY_WAV_MAX_RATE);
            wavRate = HISTORY_WAV_MAX_RATE;
        }

        const wavBuffer = pcm16ToWavBuffer(pcm16, wavRate);
        const base64Audio = arrayBufferToBase64(wavBuffer);
        const mimeType = 'audio/wav';

        const targetUsers = Array.from(selectedContacts);
        if (socket && socket.connected && targetUsers.length > 0) {
            socket.emit('audio-stream', {
                channel: currentChannel,
                targetUsers,
                audioData: base64Audio,
                mode: 'full',
                transmissionId,
                mimeType
            });
        }

        addHistoryMessage('audio', { user: currentUser, audioData: base64Audio, mimeType });
    } catch (err) {
        console.error('Error al procesar audio final:', err);
    }
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

            const downsampled = downsampleBuffer(input, captureAudioContext.sampleRate, runtimePcmRate);
            if (!downsampled || downsampled.length === 0) return;

            // En tiempo real no conviene saltar frames: evita huecos por descarte.
            const now = Date.now();
            if (SEND_THROTTLE_MS > 0 && (now - lastSendTime) < SEND_THROTTLE_MS) {
                return; // Skip este frame, enviar en el próximo
            }
            lastSendTime = now;

            const pcm16 = float32ToInt16(downsampled);
            // Sin compresión para menor overhead; sin volatile para evitar recortes de paquetes.
            const targetUsers = Array.from(selectedContacts);
            socket.compress(false).emit('audio-stream', {
                channel: currentChannel,
                targetUsers,
                audioData: pcm16.buffer,
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
        playbackInterArrivalJitter = (playbackInterArrivalJitter * 0.9) + (delta * 0.1);
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
            // Evita saltos bruscos: recorta de forma gradual el exceso de cola.
            playbackNextTime = Math.max(minStart, playbackNextTime - runtimeQueueTrimSeconds);
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
 * Cola de reproducción para chunks en vivo.
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
if (audioProfileSelect) {
    audioProfileSelect.addEventListener('change', () => {
        applyAudioProfile(audioProfileSelect.value);
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

applyAudioProfile(localStorage.getItem('audio_profile') || 'balanced');
updateAudioStats(true);

console.log(' App lista para usar!');
















