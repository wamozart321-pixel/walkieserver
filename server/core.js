const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;
const BCRYPT_PREFIXES = ['$2a$', '$2b$', '$2y$'];

function buildAppUsers(rawValue) {
  const appUsers = new Map();
  if (!rawValue || typeof rawValue !== 'string') return appUsers;

  for (const item of rawValue.split(',')) {
    const pair = item.trim();
    if (!pair) continue;

    const separatorIndex = pair.indexOf(':');
    if (separatorIndex <= 0) continue;

    const username = pair.slice(0, separatorIndex).trim();
    const password = pair.slice(separatorIndex + 1).trim();
    if (!username || !password) continue;

    appUsers.set(username, password);
  }

  return appUsers;
}

function isValidUserIdFormat(userId) {
  return /^[a-zA-Z0-9_.-]{3,20}$/.test(userId);
}

function isValidPasswordFormat(password) {
  return typeof password === 'string' && password.length >= 4 && password.length <= 80;
}

function isBcryptHash(value) {
  if (typeof value !== 'string' || value.length < 60) return false;
  return BCRYPT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

function verifyPassword(plain, storedValue) {
  if (typeof storedValue !== 'string' || !storedValue) return false;
  if (isBcryptHash(storedValue)) {
    try {
      return bcrypt.compareSync(String(plain), storedValue);
    } catch (_) {
      return false;
    }
  }
  return String(plain) === storedValue;
}

function isValidAppUser(userId, password, authUser, authPass, runtimeAppUsers) {
  if (userId === authUser && password === authPass) return true;
  if (!runtimeAppUsers.has(userId)) return false;
  return verifyPassword(password, runtimeAppUsers.get(userId));
}

function resolveTargetUsers(targetUsers, targetUser) {
  return Array.isArray(targetUsers)
    ? targetUsers.filter((u) => typeof u === 'string' && u.trim() !== '')
    : (targetUser ? [targetUser] : []);
}

function buildAudioPayload(data, userId) {
  const {
    audioData,
    mode,
    transmissionId,
    mimeType,
    format,
    sampleRate,
    encryption
  } = data || {};

  return {
    userId,
    audioData,
    mode: mode || 'full',
    transmissionId: transmissionId || null,
    mimeType: mimeType || 'audio/webm',
    format: mode === 'pcm-live' ? (format || 'pcm16') : (format || null),
    sampleRate: mode === 'pcm-live' ? (sampleRate || 16000) : (sampleRate || null),
    encryption: encryption && typeof encryption === 'object' ? encryption : null
  };
}

function getUsersInChannel(channels, users, channelName) {
  return Array.from(channels.get(channelName) || [])
    .map((id) => users.get(id)?.userId)
    .filter(Boolean);
}

function moveSocketToChannel(users, channels, socketId, userId, nextChannel) {
  const previous = users.get(socketId);
  const previousChannel = previous?.channel || null;

  if (previousChannel) {
    channels.get(previousChannel)?.delete(socketId);
    if (channels.get(previousChannel)?.size === 0) {
      channels.delete(previousChannel);
    }
  }

  users.set(socketId, { userId, channel: nextChannel });
  if (!channels.has(nextChannel)) {
    channels.set(nextChannel, new Set());
  }
  channels.get(nextChannel).add(socketId);

  return { previousChannel, currentChannel: nextChannel };
}

function removeSocketFromChannel(users, channels, socketId) {
  const user = users.get(socketId);
  if (!user) return null;

  const { userId, channel } = user;
  channels.get(channel)?.delete(socketId);
  if (channels.get(channel)?.size === 0) {
    channels.delete(channel);
  }
  users.delete(socketId);

  return { userId, channel };
}

function findSocketIdByUserId(users, targetUserId) {
  for (const [socketId, user] of users.entries()) {
    if (user.userId === targetUserId) return socketId;
  }
  return null;
}

function areUsersInSameChannel(users, fromSocketId, targetUserId) {
  const fromUser = users.get(fromSocketId);
  if (!fromUser || !targetUserId) return null;
  for (const [socketId, user] of users.entries()) {
    if (user.userId === targetUserId && user.channel === fromUser.channel) {
      return socketId;
    }
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidSdpPayload(sdp) {
  if (!isPlainObject(sdp)) return false;
  if (typeof sdp.type !== 'string') return false;
  if (!['offer', 'answer', 'pranswer', 'rollback'].includes(sdp.type)) return false;
  if (typeof sdp.sdp !== 'string' || sdp.sdp.length === 0 || sdp.sdp.length > 16000) return false;
  return true;
}

function isValidIceCandidate(candidate) {
  if (!isPlainObject(candidate)) return false;
  if (typeof candidate.candidate !== 'string') return false;
  if (candidate.candidate.length > 1000) return false;
  return true;
}

function isValidPublicKey(payload) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.publicKey !== 'string') return false;
  if (payload.publicKey.length < 16 || payload.publicKey.length > 4096) return false;
  if (payload.algorithm && typeof payload.algorithm !== 'string') return false;
  return true;
}

module.exports = {
  buildAppUsers,
  isValidUserIdFormat,
  isValidPasswordFormat,
  isBcryptHash,
  hashPassword,
  verifyPassword,
  isValidAppUser,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel,
  moveSocketToChannel,
  removeSocketFromChannel,
  findSocketIdByUserId,
  areUsersInSameChannel,
  isValidSdpPayload,
  isValidIceCandidate,
  isValidPublicKey
};
