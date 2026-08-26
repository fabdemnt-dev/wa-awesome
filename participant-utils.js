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
