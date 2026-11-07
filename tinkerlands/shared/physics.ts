// Character movement. The server's result is authoritative; the client runs the
// same code to predict its own player, then replays unacknowledged inputs on
// top of each server state.

import { B, isSolidBlock } from './blocks.ts';
import {
  AIR_ACCEL,
  BOUNCE_VELOCITY,
  COYOTE_TICKS,
  DT,
  GRAVITY,
  GROUND_ACCEL,
  ICE_ACCEL,
  JUMP_VELOCITY,
  PLAYER_HALF_WIDTH as HW,
  PLAYER_HEIGHT as HEIGHT,
  TERMINAL_VELOCITY,
  WALK_SPEED,
} from './constants.ts';

export interface BlockReader {
  readonly w: number;
  readonly h: number;
  readonly d: number;
  get(x: number, y: number, z: number): number;
}

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  coyote: number;
}

export interface MoveInput {
  /** -1 (back) to 1 (forward). */
  fwd: number;
  /** -1 (left) to 1 (right). */
  strafe: number;
  /** Camera yaw in radians; 0 looks toward -Z. */
  yaw: number;
  jump: boolean;
}

export const IDLE_INPUT: Readonly<MoveInput> = { fwd: 0, strafe: 0, yaw: 0, jump: false };

const EPS = 1e-4;
const MAX_SUBSTEP = 0.45;

export function createPlayerState(x: number, y: number, z: number): PlayerState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false, coyote: 0 };
}

export function copyPlayerState(from: PlayerState, to: PlayerState): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.vx = from.vx;
  to.vy = from.vy;
  to.vz = from.vz;
  to.grounded = from.grounded;
  to.coyote = from.coyote;
}

function collides(world: BlockReader, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - HW);
  const x1 = Math.floor(x + HW);
  const y0 = Math.floor(y);
  const y1 = Math.floor(y + HEIGHT);
  const z0 = Math.floor(z - HW);
  const z1 = Math.floor(z + HW);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (isSolidBlock(world.get(cx, cy, cz))) return true;
      }
    }
  }
  return false;
}

function floorHas(world: BlockReader, s: PlayerState, block: number): boolean {
  const y = Math.floor(s.y - 0.05);
  const x0 = Math.floor(s.x - HW);
  const x1 = Math.floor(s.x + HW);
  const z0 = Math.floor(s.z - HW);
  const z1 = Math.floor(s.z + HW);
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      if (world.get(x, y, z) === block) return true;
    }
  }
  return false;
}

function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  return Math.max(value - maxDelta, target);
}

/** Direction the character should face for an input, or null when not moving. */
export function headingForInput(input: MoveInput): number | null {
  if (input.fwd === 0 && input.strafe === 0) return null;
  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  const wx = -sin * input.fwd + cos * input.strafe;
  const wz = -cos * input.fwd - sin * input.strafe;
  return Math.atan2(wx, wz);
}

/** Advances a player by one fixed tick, mutating `s`. */
export function stepPlayer(s: PlayerState, input: MoveInput, world: BlockReader): void {
  // A block may have been placed on top of the player: lift them clear.
  if (collides(world, s.x, s.y, s.z)) {
    let y = Math.max(Math.floor(s.y) + 1, 0);
    while (y < world.h + 2 && collides(world, s.x, y + EPS, s.z)) y++;
    s.y = y + EPS;
    s.vy = 0;
  }

  const sin = Math.sin(input.yaw);
  const cos = Math.cos(input.yaw);
  let wishX = -sin * input.fwd + cos * input.strafe;
  let wishZ = -cos * input.fwd - sin * input.strafe;
  const wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1) {
    wishX /= wishLen;
    wishZ /= wishLen;
  }

  const onIce = s.grounded && floorHas(world, s, B.ICE);
  const accel = !s.grounded ? AIR_ACCEL : onIce ? ICE_ACCEL : GROUND_ACCEL;
  s.vx = approach(s.vx, wishX * WALK_SPEED, accel * DT);
  s.vz = approach(s.vz, wishZ * WALK_SPEED, accel * DT);

  if (input.jump && (s.grounded || s.coyote > 0)) {
    s.vy = JUMP_VELOCITY;
    s.coyote = 0;
    s.grounded = false;
  }

  s.vy = Math.max(s.vy - GRAVITY * DT, -TERMINAL_VELOCITY);

  const dx = s.vx * DT;
  const dy = s.vy * DT;
  const dz = s.vz * DT;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / MAX_SUBSTEP));

  let landed = false;
  for (let i = 0; i < steps; i++) {
    if (moveY(s, world, dy / steps)) landed = true;
    moveX(s, world, dx / steps);
    moveZ(s, world, dz / steps);
  }

  // Invisible walls at the world's edge.
  if (s.x < HW) {
    s.x = HW;
    s.vx = 0;
  } else if (s.x > world.w - HW) {
    s.x = world.w - HW;
    s.vx = 0;
  }
  if (s.z < HW) {
    s.z = HW;
    s.vz = 0;
  } else if (s.z > world.d - HW) {
    s.z = world.d - HW;
    s.vz = 0;
  }

  if (landed) {
    s.grounded = true;
    s.coyote = COYOTE_TICKS;
    if (floorHas(world, s, B.BOUNCE)) {
      s.vy = BOUNCE_VELOCITY;
      s.grounded = false;
      s.coyote = 0;
    }
  } else {
    s.grounded = false;
    if (s.coyote > 0) s.coyote--;
  }
}

function moveY(s: PlayerState, world: BlockReader, delta: number): boolean {
  const next = s.y + delta;
  if (!collides(world, s.x, next, s.z)) {
    s.y = next;
    return false;
  }
  if (delta > 0) {
    s.y = Math.floor(next + HEIGHT) - HEIGHT - EPS;
    s.vy = 0;
    return false;
  }
  s.y = Math.floor(next) + 1 + EPS;
  s.vy = 0;
  return true;
}

function moveX(s: PlayerState, world: BlockReader, delta: number): void {
  if (delta === 0) return;
  const next = s.x + delta;
  if (!collides(world, next, s.y, s.z)) {
    s.x = next;
  } else {
    s.x = delta > 0 ? Math.floor(next + HW) - HW - EPS : Math.floor(next - HW) + 1 + HW + EPS;
    s.vx = 0;
  }
}

function moveZ(s: PlayerState, world: BlockReader, delta: number): void {
  if (delta === 0) return;
  const next = s.z + delta;
  if (!collides(world, s.x, s.y, next)) {
    s.z = next;
  } else {
    s.z = delta > 0 ? Math.floor(next + HW) - HW - EPS : Math.floor(next - HW) + 1 + HW + EPS;
    s.vz = 0;
  }
}

export interface Contacts {
  hazard: boolean;
  goal: boolean;
  /** Checkpoint block the player stands on, as a world index, or -1. */
  checkpoint: { x: number; y: number; z: number } | null;
  /** World coordinates of coin blocks the player overlaps. */
  coins: { x: number; y: number; z: number }[];
}

/** Gameplay contacts for the player's current position. Server only. */
export function findContacts(s: PlayerState, world: BlockReader): Contacts {
  const out: Contacts = { hazard: false, goal: false, checkpoint: null, coins: [] };
  const margin = 0.05;
  const x0 = Math.floor(s.x - HW - margin);
  const x1 = Math.floor(s.x + HW + margin);
  const y0 = Math.floor(s.y - margin);
  const y1 = Math.floor(s.y + HEIGHT + margin);
  const z0 = Math.floor(s.z - HW - margin);
  const z1 = Math.floor(s.z + HW + margin);
  const floorY = Math.floor(s.y - margin);

  // Footprint and body without the margin. A block only counts when the margin
  // is needed on a single axis, or standing beside lava would count as touching
  // it through the diagonal corner of the enlarged box.
  const fx0 = Math.floor(s.x - HW);
  const fx1 = Math.floor(s.x + HW);
  const fz0 = Math.floor(s.z - HW);
  const fz1 = Math.floor(s.z + HW);
  const by0 = Math.floor(s.y);
  const by1 = Math.floor(s.y + HEIGHT);

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const block = world.get(x, y, z);
        if (block === B.AIR) continue;
        const inX = x >= fx0 && x <= fx1;
        const inZ = z >= fz0 && z <= fz1;
        const inY = y >= by0 && y <= by1;
        const axesInside = Number(inX) + Number(inY) + Number(inZ);
        if (block === B.LAVA) {
          if (axesInside >= 2) out.hazard = true;
        } else if (block === B.COIN) {
          if (axesInside === 3) out.coins.push({ x, y, z });
        } else if (s.grounded && y === floorY && inX && inZ) {
          if (block === B.GOAL) out.goal = true;
          else if (block === B.CHECKPOINT) out.checkpoint = { x, y, z };
        }
      }
    }
  }
  return out;
}
