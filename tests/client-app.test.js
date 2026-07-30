// Carga index.html + app.js en un DOM simulado (jsdom) y comprueba el
// comportamiento del cliente: historial, lista de usuarios, avisos, perfiles de
// audio y estado del boton PTT.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// app.js declara su estado con const/let, que no queda colgado de window.
// Este epilogo expone lo justo para poder montar los escenarios de prueba.
const PUENTE = `
;window.__t = {
  get contacts() { return selectedContacts; },
  get talking() { return talkingUsers; },
  setUsers(u) { usersInChannel = u; },
  setProfile(p) { currentAudioProfile = p; }
};`;

function crearApp() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

  const errores = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errores.push(e.message));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost:3000/',
    virtualConsole
  });

  const { window } = dom;

  window.io = () => ({ on() {}, emit() {}, disconnect() {}, connected: false, compress() { return this; } });
  window.RTCPeerConnection = function () { return { addTrack() {}, close() {}, getSenders: () => [] }; };
  window.RTCSessionDescription = function (x) { return x; };
  window.RTCIceCandidate = function (x) { return x; };
  window.MediaRecorder = function () {};
  window.MediaRecorder.isTypeSupported = () => true;
  window.navigator.mediaDevices = { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) };
  window.fetch = async () => ({ ok: false, json: async () => ({}) });
  window.AudioContext = function () {};
  window.alert = (m) => { throw new Error('Se ha usado alert(): ' + m); };

  window.eval(appJs + PUENTE);

  return { window, doc: window.document, t: window.__t, errores };
}

describe('cliente web', () => {
  it('arranca sin errores', () => {
    const { errores } = crearApp();
    expect(errores).toEqual([]);
  });

  describe('historial', () => {
    it('no guarda el audio dentro del HTML', () => {
      const { window, doc } = crearApp();
      const audio = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(50);

      window.addHistoryMessage('audio', { user: 'ana', audioData: audio, mimeType: 'audio/webm' });

      const item = doc.querySelector('#historyList .history-item');
      expect(item).toBeTruthy();
      expect(item.innerHTML.includes(audio.slice(0, 60))).toBe(false);
      expect(item.querySelector('.play-btn').dataset.clipId).toBeTruthy();
    });

    it('descarta los clips antiguos al pasar del limite', () => {
      const { window, doc } = crearApp();
      for (let i = 0; i < 25; i++) {
        window.addHistoryMessage('audio', { user: 'ana', audioData: 'QUJD', mimeType: 'audio/webm' });
      }
      expect(doc.querySelectorAll('#historyList .history-item').length).toBe(20);
    });
  });

  describe('lista de usuarios', () => {
    it('no inyecta HTML con nombres maliciosos', () => {
      const { window, doc, t } = crearApp();
      t.setUsers(['<img src=x onerror=alert(1)>', 'ana']);
      window.updateUsersList();

      const lista = doc.getElementById('usersList');
      expect(lista.querySelectorAll('img, script').length).toBe(0);

      const nombres = Array.from(lista.querySelectorAll('.user-name')).map((el) => el.textContent);
      expect(nombres).toContain('<img src=x onerror=alert(1)>');
    });

    it('conserva el indicador de "hablando" al actualizarse', () => {
      const { window, doc, t } = crearApp();
      t.setUsers(['ana', 'luis']);
      window.updateUsersList();

      window.updateUserTalking('ana', true);
      // Llega una actualizacion del servidor: antes se rehacia el DOM entero
      // y se perdia el indicador.
      window.updateUsersList();

      expect(doc.querySelector('[data-user="ana"]').classList.contains('talking')).toBe(true);
    });

    it('deselecciona a quien abandona el canal', () => {
      const { window, t } = crearApp();
      t.setUsers(['ana', 'luis']);
      window.updateUsersList();
      t.contacts.add('luis');

      t.setUsers(['ana']);
      window.updateUsersList();

      expect(t.contacts.has('luis')).toBe(false);
    });
  });

  describe('avisos', () => {
    it('se muestran sin usar alert()', () => {
      const { window, doc } = crearApp();
      window.showToast('probando', 'ok');
      expect(doc.querySelector('.toast').textContent).toBe('probando');
    });
  });

  describe('perfiles de audio', () => {
    const SDP = 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=ptime:20\r\n';

    it('el perfil de red mala baja el bitrate y alarga los paquetes', () => {
      const { window, t } = crearApp();
      t.setProfile('stable');
      const sdp = window.applyAudioProfileToSdp(SDP);
      expect(sdp).toContain('maxaveragebitrate=16000');
      expect(sdp).toContain('a=ptime:40');
      expect(sdp).toContain('usedtx=1');
    });

    it('el perfil de baja latencia sube el bitrate y acorta los paquetes', () => {
      const { window, t } = crearApp();
      t.setProfile('low-latency');
      const sdp = window.applyAudioProfileToSdp(SDP);
      expect(sdp).toContain('maxaveragebitrate=32000');
      expect(sdp).toContain('a=ptime:10');
    });

    it('no toca el SDP si no hay Opus', () => {
      const { window } = crearApp();
      const sdp = 'v=0\r\na=rtpmap:8 PCMA/8000\r\n';
      expect(window.applyAudioProfileToSdp(sdp)).toBe(sdp);
    });
  });

  describe('boton de hablar', () => {
    it('sigue disponible aunque la conexion directa no este lista', () => {
      const { window, doc, t } = crearApp();
      t.setUsers(['ana']);
      window.updateUsersList();
      t.contacts.add('ana');
      window.updatePttButtonState();

      expect(doc.getElementById('pttButton').disabled).toBe(false);
      expect(doc.querySelector('.ptt-hint').textContent).toContain('al soltar');
    });

    it('se bloquea si no hay nadie seleccionado', () => {
      const { window, doc, t } = crearApp();
      t.contacts.clear();
      window.updatePttButtonState();
      expect(doc.getElementById('pttButton').disabled).toBe(true);
    });
  });

  describe('direccion del servidor', () => {
    it('completa el esquema y quita la barra final', () => {
      const { window } = crearApp();
      expect(window.normalizeServerUrl('192.168.0.10:3000/')).toBe('http://192.168.0.10:3000');
      expect(window.normalizeServerUrl('https://mi.servidor.com')).toBe('https://mi.servidor.com');
      expect(window.normalizeServerUrl('  ')).toBe('');
    });
  });
});
