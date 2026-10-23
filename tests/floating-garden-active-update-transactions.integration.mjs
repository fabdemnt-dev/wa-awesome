// Explicit emulator-only entry; excluded from generic *.test.mjs collection.
// Both provider transports remain injected local fixtures. Only Firestore uses
// a real SDK against a verified loopback emulator and a demo-only project.
import { registerActiveUpdateEmulatorTests } from './floating-garden-active-update.test.mjs';
registerActiveUpdateEmulatorTests();
