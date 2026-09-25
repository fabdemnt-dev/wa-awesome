export async function completeInitialConnection({ auth, signInAnonymously, roomId, markConnected, resumeRoom }) {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  if (!roomId) {
    markConnected();
    return;
  }
  await resumeRoom();
}
