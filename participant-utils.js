export function normalizeParticipantName(name) {
  return String(name ?? '').trim();
}

export function setParticipantRole(data, name, role) {
  const participantName = normalizeParticipantName(name);
  const players = [...new Set((data?.players || []).map(normalizeParticipantName))]
    .filter(Boolean)
    .filter((value) => value !== participantName);
  const spectators = [...new Set((data?.spectators || []).map(normalizeParticipantName))]
    .filter(Boolean)
    .filter((value) => value !== participantName);
  if (!participantName) return { players, spectators };
  if (role === 'player') players.push(participantName);
  if (role === 'spectator') spectators.push(participantName);
  return { players, spectators };
}

export function hasParticipantRoleOverlap(data) {
  const spectators = new Set(data?.spectators || []);
  return (data?.players || []).filter((name) => spectators.has(name));
}

export function normalizeParticipantRoles(data) {
  const players = [...new Set((data?.players || []).map(normalizeParticipantName))].filter(Boolean);
  const playerSet = new Set(players);
  const spectators = [...new Set((data?.spectators || []).map(normalizeParticipantName))]
    .filter(Boolean)
    .filter((name) => !playerSet.has(name));
  return { players, spectators };
}

export function isValidParticipantName(name) {
  return normalizeParticipantName(name).length > 0;
}

// ラウンド中に、現在の親とは別のプレイヤーだけが親を引き継げる。
// 親が players から既に消えている状態は、ロビー側の自動親確定に任せるため対象外とする。
export function canClaimHost(data, name, isSpectator = false) {
  const participantName = normalizeParticipantName(name);
  const players = Array.isArray(data?.players) ? data.players.map(normalizeParticipantName).filter(Boolean) : [];
  const currentHost = normalizeParticipantName(data?.currentHost);
  return data?.status === 'playing'
    && !isSpectator
    && Boolean(participantName)
    && Boolean(currentHost)
    && players.includes(currentHost)
    && players.includes(participantName)
    && currentHost !== participantName;
}

// UID対応ルームでは個人データをUIDキーにし、旧形式ルームでは表示名キーを維持する。
export function getParticipantStorageKey(data, uid, name) {
  const participantUid = String(uid ?? '');
  if (participantUid && data?.participantUids?.[participantUid]) return participantUid;
  return normalizeParticipantName(name);
}

export function getParticipantNameByUid(data, uid) {
  const participantUid = String(uid ?? '');
  return normalizeParticipantName(data?.participantUids?.[participantUid]);
}

export function getParticipantUidByName(data, name) {
  const participantName = normalizeParticipantName(name);
  if (!participantName) return '';
  const entry = Object.entries(data?.participantUids || {})
    .find(([, mappedName]) => normalizeParticipantName(mappedName) === participantName);
  return entry?.[0] || '';
}

// 表示名キーの個人データをUIDキーへ移す。UID対応がない参加者のデータは保持する。
export function migrateParticipantMapToUids(data, map) {
  const source = map && typeof map === 'object' ? map : {};
  const migrated = { ...source };
  for (const [uid, name] of Object.entries(data?.participantUids || {})) {
    const participantName = normalizeParticipantName(name);
    if (!participantName || !(participantName in source) || uid in migrated) continue;
    migrated[uid] = source[participantName];
  }
  return migrated;
}
