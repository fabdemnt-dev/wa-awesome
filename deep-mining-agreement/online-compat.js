export function roomCountPayload(humanPlayerCount) {
  return { humanPlayerCount, playerCount: humanPlayerCount };
}

export function lobbyCapacity(room) {
  return Number(room.humanPlayerCount ?? room.playerCount);
}
