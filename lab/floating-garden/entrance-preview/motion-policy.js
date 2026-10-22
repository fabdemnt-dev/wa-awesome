// Pure policy. The entrance does not read game saves or initialize a game/backend.
export function mayAnimate({ enabled, visible, intersecting, pageActive, dialogOpen }) {
  return Boolean(enabled && visible && intersecting && pageActive && !dialogOpen);
}
export function startsAnimated({ reducedMotion = false, saveData = false }) {
  return !reducedMotion && !saveData;
}
