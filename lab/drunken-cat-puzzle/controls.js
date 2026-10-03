// Keep Build 267's stage-one distance on every board, independent of column count.
export function dragThreshold(boardWidth) {
  const stageOneCellSize = boardWidth / 6;
  return Math.max(30, stageOneCellSize * 0.82);
}

export function createGesture({ pointerId, x, y, boardWidth }) {
  return {
    pointerId,
    start: { x, y },
    anchor: { x, y },
    threshold: dragThreshold(boardWidth),
    blocked: null,
    travelled: false,
    attempted: false,
  };
}

// Consume actual finger travel immediately. There is no timer, queued movement,
// or separate release sensitivity. A stopped finger cannot generate more moves.
export function moveGesture(gesture, { x, y }, attemptMove) {
  if (Math.hypot(x - gesture.start.x, y - gesture.start.y) > 10) {
    gesture.travelled = true;
  }
  if (gesture.blocked) {
    const { axis, sign } = gesture.blocked;
    const position = axis === "x" ? x : y;
    // Track even sub-threshold travel into a wall. Otherwise event batching
    // changes how far the finger must reverse before the hole moves back.
    if ((position - gesture.anchor[axis]) * sign > 0) {
      gesture.anchor[axis] = position;
    }
  }
  const dx = x - gesture.anchor.x;
  const dy = y - gesture.anchor.y;
  const axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
  const delta = axis === "x" ? dx : dy;
  const steps = Math.floor((Math.abs(delta) + 1e-7) / gesture.threshold);
  if (!steps) return 0;

  const sign = Math.sign(delta);
  const direction = axis === "x"
    ? (sign > 0 ? "right" : "left")
    : (sign > 0 ? "down" : "up");
  gesture.attempted = true;
  // Discard cross-axis wobble rather than turning it into a later surprise step.
  gesture.anchor[axis === "x" ? "y" : "x"] = axis === "x" ? y : x;
  let moved = 0;
  for (let step = 0; step < steps; step += 1) {
    if (!attemptMove(direction)) {
      // A wall consumes the blocked distance; reversing never releases a backlog.
      gesture.anchor = { x, y };
      gesture.blocked = { axis, sign };
      break;
    }
    gesture.blocked = null;
    gesture.anchor[axis] += sign * gesture.threshold;
    moved += 1;
  }
  return moved;
}

export function isTapGesture(gesture) {
  return !gesture.travelled && !gesture.attempted;
}
