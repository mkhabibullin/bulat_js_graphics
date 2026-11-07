// WebSocket messages. Every client message is untrusted and goes through
// parseClientMessage before the server looks at it.

import type { Avatar } from './avatar.ts';
import { isValidBlockId } from './blocks.ts';
import { MAX_CHAT_LENGTH, WORLD_D, WORLD_H, WORLD_W } from './constants.ts';

export const EMOTES = ['wave', 'dance', 'cheer'] as const;

export type ClientMessage =
  | { t: 'join'; token: string; worldId: string; v: number }
  | { t: 'i'; s: number; f: number; r: number; y: number; j: 0 | 1 }
  | { t: 'b'; x: number; y: number; z: number; k: number }
  /** Started mining a block. Breaking it (`b` with air) needs this first. */
  | { t: 'm'; x: number; y: number; z: number }
  /** Stopped mining without finishing. */
  | { t: 'mx' }
  /** Light the TNT at this position. */
  | { t: 'l'; x: number; y: number; z: number }
  | { t: 'c'; m: string }
  | { t: 'e'; e: number }
  | { t: 'restart' }
  | { t: 'kick'; id: number }
  | { t: 'ping'; ts: number };

export interface PlayerInfo {
  /** Room-local network id. */
  id: number;
  uid: string;
  name: string;
  guest: boolean;
  avatar: Avatar;
}

export interface SelfState {
  s: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: 0 | 1;
  c: number;
}

/** [id, x, y, z, heading, grounded, emote] */
export type PlayerSnapshot = [number, number, number, number, number, 0 | 1, number];

export interface WelcomeWorld {
  id: string;
  name: string;
  ownerName: string | null;
  isOwner: boolean;
  canBuild: boolean;
  w: number;
  h: number;
  d: number;
  /** Base64 of the deflated, run-length-encoded block data. */
  blocks: string;
}

export type ServerMessage =
  | {
      t: 'w';
      you: number;
      tick: number;
      world: WelcomeWorld;
      players: PlayerInfo[];
      me: SelfState;
      best: number | null;
      coins: number;
      /** TNT already burning: flat list of x, y, z, milliseconds left. */
      fuses: number[];
    }
  | { t: 's'; k: number; p: PlayerSnapshot[]; me: SelfState }
  /** Flat list of x, y, z, block quadruples. */
  | { t: 'b'; b: number[] }
  /** Sent to a client whose edit was rejected, with the true block value. */
  | { t: 'br'; x: number; y: number; z: number; k: number; why: string; quiet: boolean }
  /** Another player started mining the block `c`, or stopped if it's null. */
  | { t: 'mi'; id: number; c: [number, number, number] | null; ms: number }
  /** TNT was lit and will explode in `ms`. */
  | { t: 'tl'; x: number; y: number; z: number; ms: number }
  /** An explosion. The destroyed blocks follow as a normal `b` message. */
  | { t: 'boom'; x: number; y: number; z: number }
  | { t: 'pj'; p: PlayerInfo }
  | { t: 'pl'; id: number }
  | { t: 'c'; id: number; name: string; m: string }
  | { t: 'sys'; m: string }
  | { t: 'perm'; canBuild: boolean }
  | { t: 'died' }
  | { t: 'checkpoint'; x: number; y: number; z: number; n: number }
  | { t: 'coin'; x: number; y: number; z: number; coins: number; granted: number }
  | { t: 'finish'; ms: number; best: number; isBest: boolean; granted: number; coins: number }
  | { t: 'restarted' }
  | { t: 'pong'; ts: number };

function isFiniteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isIntIn(v: unknown, min: number, max: number): v is number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
}

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'i':
      if (
        !isIntIn(o.s, 0, Number.MAX_SAFE_INTEGER) ||
        !isFiniteIn(o.f, -1, 1) ||
        !isFiniteIn(o.r, -1, 1) ||
        !isFiniteIn(o.y, -1e4, 1e4) ||
        (o.j !== 0 && o.j !== 1)
      ) {
        return null;
      }
      return { t: 'i', s: o.s, f: o.f, r: o.r, y: o.y, j: o.j };
    case 'b':
      if (
        !isIntIn(o.x, 0, WORLD_W - 1) ||
        !isIntIn(o.y, 0, WORLD_H - 1) ||
        !isIntIn(o.z, 0, WORLD_D - 1) ||
        typeof o.k !== 'number' ||
        !isValidBlockId(o.k)
      ) {
        return null;
      }
      return { t: 'b', x: o.x, y: o.y, z: o.z, k: o.k };
    case 'm':
    case 'l':
      if (!isIntIn(o.x, 0, WORLD_W - 1) || !isIntIn(o.y, 0, WORLD_H - 1) || !isIntIn(o.z, 0, WORLD_D - 1)) return null;
      return { t: o.t, x: o.x, y: o.y, z: o.z };
    case 'mx':
      return { t: 'mx' };
    case 'join':
      if (
        typeof o.token !== 'string' ||
        o.token.length > 128 ||
        typeof o.worldId !== 'string' ||
        !ID_RE.test(o.worldId) ||
        !isIntIn(o.v, 0, 1e6)
      ) {
        return null;
      }
      return { t: 'join', token: o.token, worldId: o.worldId, v: o.v };
    case 'c':
      if (typeof o.m !== 'string' || o.m.length === 0 || o.m.length > MAX_CHAT_LENGTH) return null;
      return { t: 'c', m: o.m };
    case 'e':
      if (!isIntIn(o.e, 0, EMOTES.length - 1)) return null;
      return { t: 'e', e: o.e };
    case 'restart':
      return { t: 'restart' };
    case 'kick':
      if (!isIntIn(o.id, 0, 1e9)) return null;
      return { t: 'kick', id: o.id };
    case 'ping':
      if (!isFiniteIn(o.ts, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { t: 'ping', ts: o.ts };
    default:
      return null;
  }
}
