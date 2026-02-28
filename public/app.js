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
let currentChannel = 'general';
let usersInChannel = [];
let historyMessages = [];
let selectedContact = null; // Para envío selectivo de audio
// Perfil optimizado: baja latencia en tiempo real
const IS_MOBILE_DEVICE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const LIVE_PCM_RATE = 16000;
const HISTORY_WAV_MAX_RATE = 24000;
const LIVE_PCM_BUFFER_SIZE = IS_MOBILE_DEVICE ? 4096 : 2048; // Móvil: chunks más estables, menos carga de CPU
const LIVE_PLAYBACK_LEAD_SECONDS = IS_MOBILE_DEVICE ? 0.22 : 0.14; // Jitter buffer inicial un poco más amplio
const CHUNK_FADE_SECONDS = 0.002; // Fade más corto
const MAX_PLAYBACK_QUEUE_SECONDS = IS_MOBILE_DEVICE ? 0.9 : 0.7; // Tope de cola antes de recortar
const PLAYBACK_QUEUE_TRIM_SECONDS = IS_MOBILE_DEVICE ? 0.08 : 0.05; // Recorte gradual, no salto brusco
// Throttle para PC: limitar velocidad de envío
const SEND_THROTTLE_MS = IS_MOBILE_DEVICE ? 0 : 15; // PC: envía cada 15ms para no saturar móvil
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
// Control de la acumulación de audio en cola
let maxQueueSize = IS_MOBILE_DEVICE ? 8 : 12;
let currentTransmissionIdPlaying = null;

// Elementos del DOM
const authPanel = document.getElementById('authPanel');
const mainPanel = document.getElementById('mainPanel');
const connectionIndicator = document.getElementById('connectionIndicator');
const connectionText = document.getElementById('connectionText');
const usernameInput = document.getElementById('usernameInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const pttButton = document.getElementById('pttButton');
const pttHint = document.querySelector('.ptt-hint');
const channelSelect = document.getElementById('channelSelect');
const createChannelBtn = document.getElementById('createChannelBtn');
const userCount = document.getElementById('userCount');
const usersList = document.getElementById('usersList');
const historyList = document.getElementById('historyList');
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

// Verificar compatibilidad con el navegador
if (!navigator.mediaDevices || !AudioContextClass) {
    alert('Tu navegador no soporta grabación de audio. Por favor usa Chrome, Edge o Firefox.');
}

// ========== FUNCIONES PRINCIPALES ==========

/**
 * Conectar al servidor Socket.IO
 */
function connectToServer() {
    const username = usernameInput.value.trim() || `Anon_${Math.floor(Math.random() * 1000)}`;
    currentUser = username;

    try {
        socket = io(SERVER_URL, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });

        updateConnectionStatus('connecting');

        socket.on('connect', () => {
            console.log('✅ Conectado al servidor');
            updateConnectionStatus('connected');
            
            // Unirse al canal
            socket.emit('join-channel', {
                userId: currentUser,
                channelName: currentChannel
            });

            // Mostrar panel principal
            authPanel.style.display = 'none';
            mainPanel.style.display = 'block';
            pttButton.disabled = false;
        });

        socket.on('disconnect', () => {
            console.log('❌ Desconectado del servidor');
            updateConnectionStatus('disconnected');
            pttButton.disabled = true;
        });

        socket.on('connect_error', (error) => {
            console.error('Error de conexión:', error);
            updateConnectionStatus('disconnected');
            alert('No se pudo conectar al servidor. Verifica que el servidor esté corriendo.');
        });

        // Escuchar actualización de usuarios en el canal
        socket.on('channel-users', (users) => {
            usersInChannel = users;
            updateUsersList();
        });

        // Escuchar cuando un usuario se une
        socket.on('user-joined', (data) => {
            addHistoryMessage('system', `👋 ${data.userId} se unió al canal`);
        });

        // Escuchar cuando un usuario se va
        socket.on('user-left', (data) => {
            addHistoryMessage('system', `👋 ${data.userId} abandonó el canal`);
        });

        // Escuchar actividad de voz
        socket.on('voice-activity', (data) => {
            updateUserTalking(data.userId, data.isTalking);
        });

        // Escuchar audio entrante
        socket.on('audio-broadcast', (data) => {
            // Flujo recomendado: PCM en vivo para baja latencia.
            // Compatibilidad: si "format" no viene, asumimos pcm16.
            if (data.mode === 'pcm-live') {
                if (data.transmissionId) {
                    liveTransmissionsReceived.add(data.transmissionId);
                }
                playPcmChunk(data.audioData, data.sampleRate || LIVE_PCM_RATE, data.transmissionId);
                return;
            }

            // Flujo heredado: chunks codificados con MediaRecorder.
            if (data.mode === 'live') {
                if (data.transmissionId) {
                    liveTransmissionsReceived.add(data.transmissionId);
                }
                enqueueLiveAudio(data.audioData, data.mimeType);
                return;
            }

            if (data.mode === 'full') {
                addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });

                // Fallback: si no hubo audio live en esa transmisión, reproduce el full automáticamente.
                const hadLive = data.transmissionId && liveTransmissionsReceived.has(data.transmissionId);
                if (!hadLive) {
                    playAudioClip(data.audioData, data.mimeType);
                } else if (data.transmissionId) {
                    liveTransmissionsReceived.delete(data.transmissionId);
                }
                return;
            }

            // Compatibilidad con clientes antiguos
            enqueueLiveAudio(data.audioData, data.mimeType);
            addHistoryMessage('audio', { user: data.userId, audioData: data.audioData, mimeType: data.mimeType });
        });

    } catch (error) {
        console.error('Error al conectar:', error);
        updateConnectionStatus('disconnected');
    }
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
        if (user === selectedContact) {
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
    
    if (selectedContact) {
        pttButton.disabled = false;
        if (pttHint) {
            pttHint.innerHTML = `📞 <strong>${selectedContact}</strong><br>Mantener presionado para hablar`;
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
    // Deseleccionar anterior si existe
    if (selectedContact) {
        const prevElement = document.getElementById(`user-${selectedContact}`);
        if (prevElement) {
            prevElement.classList.remove('selected');
            prevElement.querySelector('.selected-indicator').style.display = 'none';
        }
    }
    
    // Seleccionar nuevo contacto
    selectedContact = contactName;
    contactElement.classList.add('selected');
    contactElement.querySelector('.selected-indicator').style.display = 'inline';
    
    // Actualizar estado del botón PTT
    updatePttButtonState();
    
    console.log(`📞 Contacto seleccionado: ${contactName}`);
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
                sampleRate: LIVE_PCM_RATE,
                // Mejor calidad para PTT; evita compresion/agresividad del micro.
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        recordingPcmChunks = [];
        recordingSampleRate = LIVE_PCM_RATE;
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

        if (socket && socket.connected && selectedContact) {
            socket.emit('audio-stream', {
                channel: currentChannel,
                targetUser: selectedContact, // Envío selectivo a contacto específico
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
            if (!selectedContact) return;

            const input = event.inputBuffer.getChannelData(0);
            recordingSampleRate = captureAudioContext.sampleRate || LIVE_PCM_RATE;
            recordingPcmChunks.push(float32ToInt16(input));

            const downsampled = downsampleBuffer(input, captureAudioContext.sampleRate, LIVE_PCM_RATE);
            if (!downsampled || downsampled.length === 0) return;

            // Throttle para PC: no enviar más rápido que cada X ms
            const now = Date.now();
            if (SEND_THROTTLE_MS > 0 && (now - lastSendTime) < SEND_THROTTLE_MS) {
                return; // Skip este frame, enviar en el próximo
            }
            lastSendTime = now;

            const pcm16 = float32ToInt16(downsampled);
            // Sin compresión para menor overhead; sin volatile para evitar recortes de paquetes.
            socket.compress(false).emit('audio-stream', {
                channel: currentChannel,
                targetUser: selectedContact, // Envío selectivo a un contacto específico
                audioData: pcm16.buffer,
                mode: 'pcm-live',
                format: 'pcm16',
                sampleRate: LIVE_PCM_RATE,
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
        const buffer = playbackAudioContext.createBuffer(1, pcmFloat.length, sampleRate || LIVE_PCM_RATE);
        buffer.copyToChannel(pcmFloat, 0, 0);

        const source = playbackAudioContext.createBufferSource();
        const gainNode = playbackAudioContext.createGain();
        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(playbackAudioContext.destination);

        const now = playbackAudioContext.currentTime;
        const minStart = now + LIVE_PLAYBACK_LEAD_SECONDS;
        if (playbackNextTime < minStart) {
            playbackNextTime = minStart;
        }

        const currentQueue = playbackNextTime - now;
        if (currentQueue > MAX_PLAYBACK_QUEUE_SECONDS) {
            // Evita "saltos" audibles: reduce cola en pasos cortos.
            playbackNextTime = Math.max(minStart, playbackNextTime - PLAYBACK_QUEUE_TRIM_SECONDS);
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

// Permitir Enter en el input
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') connectToServer();
});

// Botón desconectar
disconnectBtn.addEventListener('click', () => {
    if (socket) {
        socket.disconnect();
        authPanel.style.display = 'block';
        mainPanel.style.display = 'none';
        usersInChannel = [];
        historyList.innerHTML = '';
    }
});

// Boton PTT - Pointer events (unifica mouse/touch y evita dobles eventos)
function beginPtt(e) {
    if (e) e.preventDefault();
    if (pttButton.disabled) return;
    
    // Verificar que hay un contacto seleccionado
    if (!selectedContact) {
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
                channelName: newChannel.trim()
            });
            currentChannel = newChannel.trim();
        }
    }
});

// Prevenir que el botón PTT pierda el foco
pttButton.addEventListener('contextmenu', (e) => e.preventDefault());

console.log(' App lista para usar!');






