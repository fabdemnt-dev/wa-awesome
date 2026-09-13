export const state = {
  uid: null,
  roomId: null,
  snapshot: null,
  pendingRequestIds: new Map(),
};

export function requestIdFor(action) {
  if (!state.pendingRequestIds.has(action)) state.pendingRequestIds.set(action, crypto.randomUUID());
  return state.pendingRequestIds.get(action);
}

export function finishRequest(action) {
  state.pendingRequestIds.delete(action);
}
