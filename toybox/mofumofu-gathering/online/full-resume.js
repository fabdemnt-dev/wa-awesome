export async function runMofumofuFullResume({
  auth,
  signInAnonymously,
  isCurrent,
  retirePresence,
  createConnectionId,
  authorizePresence,
  beginPresence,
  resumeRoom,
  applyResume,
}) {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  if (!isCurrent()) return false;

  await retirePresence();
  if (!isCurrent()) return false;

  const connectionId = createConnectionId();
  const admission = await authorizePresence(connectionId);
  if (!isCurrent()) return false;

  await beginPresence(admission.seatId, connectionId);
  if (!isCurrent()) return false;

  const value = await resumeRoom();
  if (!isCurrent()) return false;

  await applyResume(value, connectionId);
  return true;
}
