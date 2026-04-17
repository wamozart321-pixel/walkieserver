const {
  buildAppUsers,
  isValidUserIdFormat,
  isValidPasswordFormat,
  isValidAppUser,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel,
  isBcryptHash,
  hashPassword,
  verifyPassword,
  isValidSdpPayload,
  isValidIceCandidate,
  isValidPublicKey
} = require('../server/core');

describe('server/core', () => {
  describe('buildAppUsers', () => {
    it('parsea pares validos usuario:clave', () => {
      const users = buildAppUsers('ana:1234,luis:abcd,maria:clave');
      expect(users.size).toBe(3);
      expect(users.get('ana')).toBe('1234');
      expect(users.get('luis')).toBe('abcd');
      expect(users.get('maria')).toBe('clave');
    });

    it('ignora entradas invalidas y vacias', () => {
      const users = buildAppUsers('ana:1234, :x,soloUsuario, ,p::q');
      expect(users.size).toBe(2);
      expect(users.get('ana')).toBe('1234');
      expect(users.get('p')).toBe(':q');
    });
  });

  describe('formatos de credenciales', () => {
    it('valida userId con patron permitido', () => {
      expect(isValidUserIdFormat('abc')).toBe(true);
      expect(isValidUserIdFormat('ana_01.test-xx')).toBe(true);
      expect(isValidUserIdFormat('ab')).toBe(false);
      expect(isValidUserIdFormat('usuario con espacio')).toBe(false);
    });

    it('valida longitud de password', () => {
      expect(isValidPasswordFormat('1234')).toBe(true);
      expect(isValidPasswordFormat('x'.repeat(80))).toBe(true);
      expect(isValidPasswordFormat('123')).toBe(false);
      expect(isValidPasswordFormat('x'.repeat(81))).toBe(false);
    });
  });

  describe('bcrypt helpers', () => {
    it('hashPassword genera un hash bcrypt verificable', () => {
      const hash = hashPassword('secreto-1234');
      expect(isBcryptHash(hash)).toBe(true);
      expect(hash.length).toBeGreaterThanOrEqual(60);
      expect(verifyPassword('secreto-1234', hash)).toBe(true);
      expect(verifyPassword('otro', hash)).toBe(false);
    });

    it('verifyPassword acepta texto plano legacy y rechaza con hash invalido', () => {
      expect(verifyPassword('1234', '1234')).toBe(true);
      expect(verifyPassword('1234', 'no-es-hash')).toBe(false);
      expect(verifyPassword('1234', '$2b$10$malformedhash')).toBe(false);
    });

    it('isBcryptHash detecta prefijos $2a/$2b/$2y de longitud 60', () => {
      const hash = hashPassword('algo');
      expect(isBcryptHash(hash)).toBe(true);
      expect(isBcryptHash('$2b$' + 'x'.repeat(60))).toBe(true);
      expect(isBcryptHash('plain')).toBe(false);
      expect(isBcryptHash(null)).toBe(false);
    });
  });

  describe('isValidAppUser con bcrypt', () => {
    const runtimeUsers = new Map([
      ['ana', hashPassword('1234')],
      ['luis', 'abcd'] // legacy en texto plano
    ]);

    it('acepta admin de respaldo', () => {
      expect(isValidAppUser('admin', 'secreto', 'admin', 'secreto', runtimeUsers)).toBe(true);
    });

    it('verifica usuarios runtime con hash bcrypt', () => {
      expect(isValidAppUser('ana', '1234', 'admin', 'secreto', runtimeUsers)).toBe(true);
      expect(isValidAppUser('ana', 'mala', 'admin', 'secreto', runtimeUsers)).toBe(false);
    });

    it('mantiene compatibilidad con texto plano legacy', () => {
      expect(isValidAppUser('luis', 'abcd', 'admin', 'secreto', runtimeUsers)).toBe(true);
      expect(isValidAppUser('luis', 'mala', 'admin', 'secreto', runtimeUsers)).toBe(false);
    });

    it('rechaza usuarios inexistentes', () => {
      expect(isValidAppUser('nadie', 'x', 'admin', 'secreto', runtimeUsers)).toBe(false);
    });
  });

  describe('resolveTargetUsers', () => {
    it('prioriza targetUsers validos', () => {
      const targets = resolveTargetUsers(['ana', '', '   ', 'luis'], 'maria');
      expect(targets).toEqual(['ana', 'luis']);
    });

    it('usa targetUser si no hay targetUsers array', () => {
      expect(resolveTargetUsers(undefined, 'ana')).toEqual(['ana']);
      expect(resolveTargetUsers(undefined, undefined)).toEqual([]);
    });
  });

  describe('buildAudioPayload', () => {
    it('asigna defaults para modo full', () => {
      const payload = buildAudioPayload({ audioData: 'abc' }, 'ana');
      expect(payload).toMatchObject({
        userId: 'ana',
        audioData: 'abc',
        mode: 'full',
        mimeType: 'audio/webm',
        transmissionId: null,
        format: null,
        sampleRate: null,
        encryption: null
      });
    });

    it('preserva metadatos de cifrado E2E', () => {
      const payload = buildAudioPayload(
        { audioData: 'cipher', encryption: { algorithm: 'AES-GCM', iv: 'abcd' } },
        'ana'
      );
      expect(payload.encryption).toEqual({ algorithm: 'AES-GCM', iv: 'abcd' });
    });

    it('setea formato y sampleRate en modo pcm-live', () => {
      const payload = buildAudioPayload(
        { audioData: 'abc', mode: 'pcm-live', format: 'pcm16', sampleRate: 24000 },
        'ana'
      );
      expect(payload.format).toBe('pcm16');
      expect(payload.sampleRate).toBe(24000);
    });
  });

  describe('getUsersInChannel', () => {
    it('devuelve userIds filtrando socketIds inexistentes', () => {
      const channels = new Map([['general', new Set(['s1', 's2', 's3'])]]);
      const users = new Map([
        ['s1', { userId: 'ana', channel: 'general' }],
        ['s2', { userId: 'luis', channel: 'general' }]
      ]);

      expect(getUsersInChannel(channels, users, 'general')).toEqual(['ana', 'luis']);
      expect(getUsersInChannel(channels, users, 'otro')).toEqual([]);
    });
  });

  describe('validacion de senalizacion P2P', () => {
    it('isValidSdpPayload acepta offer/answer bien formados', () => {
      expect(isValidSdpPayload({ type: 'offer', sdp: 'v=0\r\no=- ...' })).toBe(true);
      expect(isValidSdpPayload({ type: 'answer', sdp: 'v=0\r\no=- ...' })).toBe(true);
    });

    it('isValidSdpPayload rechaza tipos o tamanos invalidos', () => {
      expect(isValidSdpPayload(null)).toBe(false);
      expect(isValidSdpPayload({ type: 'hack', sdp: 'x' })).toBe(false);
      expect(isValidSdpPayload({ type: 'offer', sdp: '' })).toBe(false);
      expect(isValidSdpPayload({ type: 'offer', sdp: 'x'.repeat(20000) })).toBe(false);
    });

    it('isValidIceCandidate acepta candidatos validos y rechaza basura', () => {
      expect(isValidIceCandidate({ candidate: 'candidate:842163049 1 udp 1677729535 ...' })).toBe(true);
      expect(isValidIceCandidate({})).toBe(false);
      expect(isValidIceCandidate({ candidate: 'x'.repeat(2000) })).toBe(false);
    });

    it('isValidPublicKey valida payload de intercambio E2E', () => {
      expect(isValidPublicKey({ publicKey: 'a'.repeat(50), algorithm: 'ECDH-P256-AESGCM' })).toBe(true);
      expect(isValidPublicKey({ publicKey: 'short' })).toBe(false);
      expect(isValidPublicKey({ publicKey: 123 })).toBe(false);
      expect(isValidPublicKey(null)).toBe(false);
    });
  });
});
