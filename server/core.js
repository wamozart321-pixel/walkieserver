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

function isValidAppUser(userId, password, authUser, authPass, runtimeAppUsers) {
  if (userId === authUser && password === authPass) return true;
  return runtimeAppUsers.has(userId) && runtimeAppUsers.get(userId) === password;
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
    sampleRate
  } = data || {};

  return {
    userId,
    audioData,
    mode: mode || 'full',
    transmissionId: transmissionId || null,
    mimeType: mimeType || 'audio/webm',
    format: mode === 'pcm-live' ? (format || 'pcm16') : (format || null),
    sampleRate: mode === 'pcm-live' ? (sampleRate || 16000) : (sampleRate || null)
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

module.exports = {
  buildAppUsers,
  isValidUserIdFormat,
  isValidPasswordFormat,
  isValidAppUser,
  resolveTargetUsers,
  buildAudioPayload,
  getUsersInChannel,
  moveSocketToChannel,
  removeSocketFromChannel,
  findSocketIdByUserId
};
