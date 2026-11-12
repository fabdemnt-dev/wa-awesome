import { markerStore, mount } from './probe.mjs';
// Storage access is deferred until a button is pressed.
let store;
const getStore = () => store ??= markerStore(globalThis.localStorage, globalThis.indexedDB);
mount(document.querySelector('main'), {
  read: () => getStore().read(),
  write: seat => getStore().write(seat)
});
