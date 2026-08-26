export const HOST_TIMEOUT_MS = 30_000;

export function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

export function isHostHeartbeatStale(data, now = Date.now(), missingSince = now) {
  const heartbeat = timestampMillis(data?.hostHeartbeatAt);
  if (!heartbeat) return now - missingSince > HOST_TIMEOUT_MS;
  return now - heartbeat > HOST_TIMEOUT_MS;
}
