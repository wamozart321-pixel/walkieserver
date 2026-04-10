const {
  moveSocketToChannel,
  removeSocketFromChannel,
  findSocketIdByUserId,
  getUsersInChannel
} = require('../server/core');

describe('server/core flow state', () => {
  it('moveSocketToChannel agrega usuario a canal nuevo', () => {
    const users = new Map();
    const channels = new Map();

    const movement = moveSocketToChannel(users, channels, 's1', 'ana', 'general');

    expect(movement).toEqual({ previousChannel: null, currentChannel: 'general' });
    expect(users.get('s1')).toEqual({ userId: 'ana', channel: 'general' });
    expect(Array.from(channels.get('general'))).toEqual(['s1']);
  });

  it('moveSocketToChannel mueve de canal anterior y limpia canal vacio', () => {
    const users = new Map([
      ['s1', { userId: 'ana', channel: 'general' }],
      ['s2', { userId: 'luis', channel: 'soporte' }]
    ]);
    const channels = new Map([
      ['general', new Set(['s1'])],
      ['soporte', new Set(['s2'])]
    ]);

    const movement = moveSocketToChannel(users, channels, 's1', 'ana', 'soporte');

    expect(movement.previousChannel).toBe('general');
    expect(users.get('s1').channel).toBe('soporte');
    expect(channels.has('general')).toBe(false);
    expect(Array.from(channels.get('soporte')).sort()).toEqual(['s1', 's2']);
  });

  it('removeSocketFromChannel elimina usuario y canal vacio', () => {
    const users = new Map([['s1', { userId: 'ana', channel: 'general' }]]);
    const channels = new Map([['general', new Set(['s1'])]]);

    const removed = removeSocketFromChannel(users, channels, 's1');

    expect(removed).toEqual({ userId: 'ana', channel: 'general' });
    expect(users.has('s1')).toBe(false);
    expect(channels.has('general')).toBe(false);
  });

  it('removeSocketFromChannel no falla si socket no existe', () => {
    const users = new Map();
    const channels = new Map();

    const removed = removeSocketFromChannel(users, channels, 'missing');
    expect(removed).toBe(null);
  });

  it('findSocketIdByUserId encuentra socket correcto', () => {
    const users = new Map([
      ['s1', { userId: 'ana', channel: 'general' }],
      ['s2', { userId: 'luis', channel: 'general' }]
    ]);
    expect(findSocketIdByUserId(users, 'luis')).toBe('s2');
    expect(findSocketIdByUserId(users, 'maria')).toBe(null);
  });

  it('getUsersInChannel refleja estado tras movimiento y desconexion', () => {
    const users = new Map([
      ['s1', { userId: 'ana', channel: 'general' }],
      ['s2', { userId: 'luis', channel: 'general' }]
    ]);
    const channels = new Map([['general', new Set(['s1', 's2'])]]);

    moveSocketToChannel(users, channels, 's2', 'luis', 'soporte');
    expect(getUsersInChannel(channels, users, 'general')).toEqual(['ana']);
    expect(getUsersInChannel(channels, users, 'soporte')).toEqual(['luis']);

    removeSocketFromChannel(users, channels, 's1');
    expect(getUsersInChannel(channels, users, 'general')).toEqual([]);
  });
});
