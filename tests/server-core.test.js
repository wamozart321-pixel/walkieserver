const {
  buildAppUsers,
  isValidUserIdFormat,
  isValidPasswordFormat,
  isValidAppUser,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel
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

  describe('isValidAppUser', () => {
    const runtimeUsers = new Map([
      ['ana', '1234'],
      ['luis', 'abcd']
    ]);

    it('acepta admin de respaldo', () => {
      expect(isValidAppUser('admin', 'secreto', 'admin', 'secreto', runtimeUsers)).toBe(true);
    });

    it('acepta y rechaza usuarios runtime', () => {
      expect(isValidAppUser('ana', '1234', 'admin', 'secreto', runtimeUsers)).toBe(true);
      expect(isValidAppUser('ana', 'mala', 'admin', 'secreto', runtimeUsers)).toBe(false);
      expect(isValidAppUser('nadie', '1234', 'admin', 'secreto', runtimeUsers)).toBe(false);
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
        sampleRate: null
      });
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
});
