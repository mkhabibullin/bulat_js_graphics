import { WebSocket } from 'ws';
import type { Avatar } from '../shared/avatar.ts';
import { B, BLOCKS } from '../shared/blocks.ts';
import {
  BUILD_REACH,
  CLOSE,
  COIN_VALUE,
  FINISH_REWARD,
  KILL_Y,
  MAX_PLAYERS_PER_ROOM,
  PLAYER_EYE,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  SNAPSHOT_INTERVAL_TICKS,
  TICK_RATE,
  TNT_CHAIN_FUSE_MAX_TICKS,
  TNT_CHAIN_FUSE_MIN_TICKS,
  TNT_FUSE_TICKS,
  TNT_KILL_RADIUS,
  TNT_PUSH_RADIUS,
  TNT_PUSH_SPEED,
  TNT_RADIUS,
} from '../shared/constants.ts';
import {
  createPlayerState,
  findContacts,
  headingForInput,
  IDLE_INPUT,
  stepPlayer,
  type MoveInput,
  type PlayerState,
} from '../shared/physics.ts';
import type { ClientMessage, PlayerInfo, SelfState, ServerMessage } from '../shared/protocol.ts';
import { VoxelWorld } from '../shared/world.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { sanitizeText, type TextFilter } from './moderation.ts';
import { TokenBucket } from './ratelimit.ts';
import { parseAvatar, type Store, type UserRow, type WorldRow } from './store.ts';
import { packWorld, renderThumbnail, unpackWorld } from './worlddata.ts';

/** Inputs a client may run in one burst to recover from jitter. */
const INPUT_BUDGET_MAX = 6;
const INPUT_QUEUE_MAX = 30;
/** With no inputs for this long, simulate idle so a silent client can't hover. */
const IDLE_AFTER_MS = 250;
const MAX_BUFFERED_SNAPSHOT = 256 * 1024;
const MAX_BUFFERED_CLOSE = 4 * 1024 * 1024;
const EMOTE_TICKS = TICK_RATE * 3;
/** Network jitter can shrink the gap the server sees between mining start and break. */
const MINING_TIME_TOLERANCE = 0.75;
const MINING_JITTER_MS = 150;
/** Spreads a huge chain reaction over several ticks, keeping each one cheap. */
const MAX_EXPLOSIONS_PER_TICK = 3;

export interface RoomDeps {
  store: Store;
  log: Logger;
  metrics: Metrics;
  filter: TextFilter;
  now?: () => number;
}

export interface RoomPlayer {
  id: number;
  user: UserRow;
  name: string;
  avatar: Avatar;
  ws: WebSocket;
  state: PlayerState;
  heading: number;
  queue: { seq: number; input: MoveInput }[];
  budget: number;
  lastSeq: number;
  lastInputAt: number;
  spawn: { x: number; y: number; z: number };
  checkpoint: { x: number; y: number; z: number } | null;
  checkpointCount: number;
  seenCheckpoints: Set<number>;
  runStartTick: number;
  finished: boolean;
  collected: Set<number>;
  emote: number;
  emoteUntil: number;
  chat: TokenBucket;
  build: TokenBucket;
  mine: TokenBucket;
  ignite: TokenBucket;
  mining: { x: number; y: number; z: number; block: number; startedAt: number } | null;
  rejectedEdits: number;
}

export class Room {
  readonly worldId: string;
  meta: WorldRow;
  readonly world: VoxelWorld;
  readonly players = new Map<number, RoomPlayer>();
  emptySince: number;
  private readonly deps: RoomDeps;
  private readonly now: () => number;
  private tickCount = 0;
  private nextPlayerId = 1;
  private dirty = false;
  private packed: Buffer | null = null;
  private lastSave: number;
  private pendingEdits: number[] = [];
  private readonly spawns = new Set<number>();
  /** Lit TNT by world index. Fuses live only in memory, so a restart puts them out. */
  private readonly fuses = new Map<number, { x: number; y: number; z: number; tick: number }>();

  constructor(meta: WorldRow, blocks: Uint8Array, deps: RoomDeps) {
    this.worldId = meta.id;
    this.meta = meta;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.world = unpackWorld(blocks, meta.width, meta.height, meta.depth);
    this.emptySince = this.now();
    this.lastSave = this.now();
    for (let i = 0; i < this.world.data.length; i++) {
      if (this.world.data[i] === B.SPAWN) this.spawns.add(i);
    }
  }

  get isFull(): boolean {
    return this.players.size >= MAX_PLAYERS_PER_ROOM;
  }

  isOwner(user: UserRow): boolean {
    return this.meta.owner_id === user.id;
  }

  canBuild(user: UserRow): boolean {
    return this.isOwner(user) || this.meta.build_mode === 'everyone';
  }

  /** A free standing position, or the middle of the map if every spawn is blocked. */
  private pickSpawn(): { x: number; y: number; z: number } {
    const { w, d, h } = this.world;
    const list = [...this.spawns];
    // Prefer an unobstructed spawn block; random so that players don't stack.
    for (let attempt = 0; attempt < 8 && list.length > 0; attempt++) {
      const i = list[Math.floor(Math.random() * list.length)];
      const y = Math.floor(i / (w * d));
      const rest = i - y * w * d;
      const z = Math.floor(rest / w);
      const x = rest - z * w;
      if (this.world.isSolid(x, y + 1, z) || this.world.isSolid(x, y + 2, z)) continue;
      return { x: x + 0.5, y: y + 1.001, z: z + 0.5 };
    }
    const cx = w >> 1;
    const cz = d >> 1;
    return { x: cx + 0.5, y: Math.min(this.world.topSolid(cx, cz) + 1.001, h + 1), z: cz + 0.5 };
  }

  private selfState(p: RoomPlayer): SelfState {
    const s = p.state;
    return { s: p.lastSeq, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, g: s.grounded ? 1 : 0, c: s.coyote };
  }

  private info(p: RoomPlayer): PlayerInfo {
    return { id: p.id, uid: p.user.id, name: p.name, guest: p.user.is_guest === 1, avatar: p.avatar };
  }

  private send(p: RoomPlayer, msg: ServerMessage): void {
    if (p.ws.readyState !== WebSocket.OPEN) return;
    p.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except?: RoomPlayer): void {
    const json = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
    }
  }

  addPlayer(ws: WebSocket, user: UserRow): RoomPlayer {
    const spawn = this.pickSpawn();
    const now = this.now();
    const player: RoomPlayer = {
      id: this.nextPlayerId++,
      user,
      name: user.username,
      avatar: parseAvatar(user.avatar),
      ws,
      state: createPlayerState(spawn.x, spawn.y, spawn.z),
      heading: 0,
      queue: [],
      budget: INPUT_BUDGET_MAX,
      lastSeq: 0,
      lastInputAt: now,
      spawn,
      checkpoint: null,
      checkpointCount: 0,
      seenCheckpoints: new Set(),
      runStartTick: this.tickCount,
      finished: false,
      collected: new Set(),
      emote: 0,
      emoteUntil: 0,
      chat: new TokenBucket(1, 5, now),
      build: new TokenBucket(20, 30, now),
      mine: new TokenBucket(20, 30, now),
      ignite: new TokenBucket(2, 5, now),
      mining: null,
      rejectedEdits: 0,
    };

    this.packed ??= packWorld(this.world) as Buffer;
    this.send(player, {
      t: 'w',
      you: player.id,
      tick: this.tickCount,
      world: {
        id: this.meta.id,
        name: this.meta.name,
        ownerName: this.meta.owner_name,
        isOwner: this.isOwner(user),
        canBuild: this.canBuild(user),
        w: this.world.w,
        h: this.world.h,
        d: this.world.d,
        blocks: this.packed.toString('base64'),
      },
      players: [...this.players.values()].map((p) => this.info(p)),
      me: this.selfState(player),
      best: this.deps.store.getBestTime(this.meta.id, user.id),
      coins: user.coins,
      fuses: [...this.fuses.values()].flatMap((f) => [f.x, f.y, f.z, Math.round(((f.tick - this.tickCount) * 1000) / TICK_RATE)]),
    });

    this.players.set(player.id, player);
    this.broadcast({ t: 'pj', p: this.info(player) }, player);
    this.broadcast({ t: 'sys', m: `${player.name} joined` }, player);
    this.deps.store.addVisit(this.meta.id);
    return player;
  }

  removePlayer(player: RoomPlayer): void {
    if (!this.players.delete(player.id)) return;
    this.broadcast({ t: 'pl', id: player.id });
    this.broadcast({ t: 'sys', m: `${player.name} left` });
    if (this.players.size === 0) {
      this.emptySince = this.now();
      this.save();
    }
  }

  handleMessage(p: RoomPlayer, msg: ClientMessage): void {
    switch (msg.t) {
      case 'i':
        // Sequence numbers only move forward, so replayed inputs are ignored.
        if (msg.s <= p.lastSeq || (p.queue.length > 0 && msg.s <= p.queue[p.queue.length - 1].seq)) return;
        p.queue.push({ seq: msg.s, input: { fwd: msg.f, strafe: msg.r, yaw: msg.y, jump: msg.j === 1 } });
        if (p.queue.length > INPUT_QUEUE_MAX) p.queue.shift();
        p.lastInputAt = this.now();
        return;
      case 'b':
        this.handleEdit(p, msg.x, msg.y, msg.z, msg.k);
        return;
      case 'm':
        this.handleMineStart(p, msg.x, msg.y, msg.z);
        return;
      case 'mx':
        if (p.mining) {
          p.mining = null;
          this.broadcast({ t: 'mi', id: p.id, c: null, ms: 0 }, p);
        }
        return;
      case 'l':
        this.handleLight(p, msg.x, msg.y, msg.z);
        return;
      case 'c':
        this.handleChat(p, msg.m);
        return;
      case 'e':
        p.emote = msg.e + 1;
        p.emoteUntil = this.tickCount + EMOTE_TICKS;
        return;
      case 'restart':
        this.restartRun(p);
        return;
      case 'kick':
        this.handleKick(p, msg.id);
        return;
      case 'ping':
        this.send(p, { t: 'pong', ts: msg.ts });
        return;
      case 'join':
        return; // Already joined.
    }
  }

  private withinReach(p: RoomPlayer, x: number, y: number, z: number): boolean {
    const eyeY = p.state.y + PLAYER_EYE;
    return Math.hypot(x + 0.5 - p.state.x, y + 0.5 - eyeY, z + 0.5 - p.state.z) <= BUILD_REACH + 1.5;
  }

  /** Invalid requests are just ignored: without a timer, the later break is refused. */
  private handleMineStart(p: RoomPlayer, x: number, y: number, z: number): void {
    if (!this.canBuild(p.user) || !p.mine.take(this.now())) return;
    const block = this.world.get(x, y, z);
    if (block === B.AIR || (BLOCKS[block].ownerOnly && !this.isOwner(p.user))) return;
    if (!this.withinReach(p, x, y, z)) return;
    p.mining = { x, y, z, block, startedAt: this.now() };
    this.broadcast({ t: 'mi', id: p.id, c: [x, y, z], ms: Math.round(BLOCKS[block].breakTime * 1000) }, p);
  }

  private handleLight(p: RoomPlayer, x: number, y: number, z: number): void {
    if (!this.canBuild(p.user) || !p.ignite.take(this.now())) return;
    if (this.world.get(x, y, z) !== B.TNT || !this.withinReach(p, x, y, z)) return;
    this.startFuse(x, y, z, TNT_FUSE_TICKS);
    this.deps.log.debug('tnt lit', { world: this.meta.id, user: p.user.id, x, y, z });
  }

  private startFuse(x: number, y: number, z: number, ticks: number): void {
    const key = this.world.index(x, y, z);
    if (this.fuses.has(key)) return;
    this.fuses.set(key, { x, y, z, tick: this.tickCount + ticks });
    this.broadcast({ t: 'tl', x, y, z, ms: Math.round((ticks * 1000) / TICK_RATE) });
  }

  private updateFuses(): void {
    let explosions = 0;
    for (const [key, fuse] of this.fuses) {
      if (fuse.tick > this.tickCount) continue;
      if (explosions >= MAX_EXPLOSIONS_PER_TICK) break;
      this.fuses.delete(key);
      this.explode(fuse.x, fuse.y, fuse.z);
      explosions++;
    }
  }

  private explode(cx: number, cy: number, cz: number): void {
    this.applyEdit(cx, cy, cz, B.AIR);
    this.broadcast({ t: 'boom', x: cx, y: cy, z: cz });
    this.deps.metrics.inc('tnt_explosions_total');

    const r = TNT_RADIUS;
    for (let y = Math.max(cy - r, 1); y <= cy + r; y++) {
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          const block = this.world.get(x, y, z);
          if (block === B.AIR) continue;
          if (Math.hypot(x - cx, y - cy, z - cz) > r - Math.random() * 0.9) continue;
          if (block === B.TNT) {
            const span = TNT_CHAIN_FUSE_MAX_TICKS - TNT_CHAIN_FUSE_MIN_TICKS;
            this.startFuse(x, y, z, TNT_CHAIN_FUSE_MIN_TICKS + Math.floor(Math.random() * span));
          } else if (!BLOCKS[block].ownerOnly) {
            // Spawns, goals, lava and the like survive, so a blast can't ruin a
            // course. The bottom layer (skipped above) stops holes to the void.
            this.applyEdit(x, y, z, B.AIR);
          }
        }
      }
    }

    for (const p of this.players.values()) {
      const dx = p.state.x - (cx + 0.5);
      const dy = p.state.y + PLAYER_HEIGHT / 2 - (cy + 0.5);
      const dz = p.state.z - (cz + 0.5);
      const dist = Math.hypot(dx, dy, dz);
      if (dist < TNT_KILL_RADIUS) {
        this.send(p, { t: 'died' });
        this.respawn(p);
      } else if (dist < TNT_PUSH_RADIUS) {
        const strength = 1 - dist / TNT_PUSH_RADIUS;
        p.state.vx += (dx / dist) * TNT_PUSH_SPEED * strength;
        p.state.vz += (dz / dist) * TNT_PUSH_SPEED * strength;
        p.state.vy = Math.max(p.state.vy, 3 + 10 * strength);
        p.state.grounded = false;
        p.state.coyote = 0;
      }
    }
  }

  /** The client's own timer decides when it finishes; this catches ones that cheat. */
  private minedLongEnough(p: RoomPlayer, x: number, y: number, z: number, block: number): boolean {
    const m = p.mining;
    if (!m || m.x !== x || m.y !== y || m.z !== z || m.block !== block) return false;
    // Real time, not ticks: ticks get skipped when the server stalls, which
    // would make honest players look like they finished too early.
    const required = BLOCKS[block].breakTime * 1000 * MINING_TIME_TOLERANCE - MINING_JITTER_MS;
    return this.now() - m.startedAt >= required;
  }

  private rejectEdit(p: RoomPlayer, x: number, y: number, z: number, why: string, quiet = false): void {
    this.deps.metrics.inc('edits_rejected_total');
    this.send(p, { t: 'br', x, y, z, k: this.world.get(x, y, z), why, quiet });
  }

  private handleEdit(p: RoomPlayer, x: number, y: number, z: number, block: number): void {
    if (!this.canBuild(p.user)) return this.rejectEdit(p, x, y, z, 'You can’t build in this world.');
    if (!p.build.take(this.now())) return this.rejectEdit(p, x, y, z, 'Building too fast.');
    const owner = this.isOwner(p.user);
    if (BLOCKS[block].ownerOnly && !owner) {
      return this.rejectEdit(p, x, y, z, `Only the world’s owner can place ${BLOCKS[block].name.toLowerCase()}.`);
    }
    const existing = this.world.get(x, y, z);
    if (existing === block) return;
    if (BLOCKS[existing].ownerOnly && !owner) {
      return this.rejectEdit(p, x, y, z, 'Only the world’s owner can remove that block.');
    }
    if (!this.withinReach(p, x, y, z)) return this.rejectEdit(p, x, y, z, 'Too far away.');
    if (existing !== B.AIR) {
      if (block === B.AIR) {
        // Quiet because an honest player can land here on a very bad connection.
        // The block comes back, and holding the button simply carries on mining.
        if (!this.minedLongEnough(p, x, y, z, existing)) return this.rejectEdit(p, x, y, z, 'That block isn’t broken yet.', true);
        p.mining = null;
      } else if (!owner) {
        // Swapping one block for another would skip mining altogether.
        return this.rejectEdit(p, x, y, z, 'Break that block first.');
      }
    }
    if (BLOCKS[block].solid) {
      for (const other of this.players.values()) {
        if (this.overlapsCell(other.state, x, y, z)) return this.rejectEdit(p, x, y, z, 'Someone is standing there.');
      }
    }
    this.applyEdit(x, y, z, block);
  }

  private overlapsCell(s: PlayerState, x: number, y: number, z: number): boolean {
    return (
      s.x + PLAYER_HALF_WIDTH > x &&
      s.x - PLAYER_HALF_WIDTH < x + 1 &&
      s.z + PLAYER_HALF_WIDTH > z &&
      s.z - PLAYER_HALF_WIDTH < z + 1 &&
      s.y + PLAYER_HEIGHT > y &&
      s.y < y + 1
    );
  }

  private applyEdit(x: number, y: number, z: number, block: number): void {
    const index = this.world.index(x, y, z);
    if (this.world.data[index] === B.SPAWN) this.spawns.delete(index);
    if (block === B.SPAWN) this.spawns.add(index);
    // Breaking lit TNT defuses it.
    if (block !== B.TNT) this.fuses.delete(index);
    this.world.data[index] = block;
    this.dirty = true;
    this.packed = null;
    this.pendingEdits.push(x, y, z, block);
    this.deps.metrics.inc('edits_total');
  }

  private handleChat(p: RoomPlayer, raw: string): void {
    if (!p.chat.take(this.now())) {
      this.send(p, { t: 'sys', m: 'You’re sending messages too quickly.' });
      return;
    }
    const clean = this.deps.filter.clean(sanitizeText(raw));
    if (!clean) return;
    this.deps.metrics.inc('chat_messages_total');
    this.broadcast({ t: 'c', id: p.id, name: p.name, m: clean });
  }

  private handleKick(p: RoomPlayer, targetId: number): void {
    if (!this.isOwner(p.user)) return;
    const target = this.players.get(targetId);
    if (!target || target === p) return;
    this.deps.store.banFromWorld(this.meta.id, target.user.id);
    this.removePlayer(target);
    target.ws.close(CLOSE.KICKED, 'Removed by the world’s owner');
    this.deps.log.info('player kicked', { world: this.meta.id, user: target.user.id, by: p.user.id });
  }

  private respawn(p: RoomPlayer): void {
    const at = p.checkpoint ?? p.spawn;
    const fresh = createPlayerState(at.x, at.y, at.z);
    Object.assign(p.state, fresh);
    // Inputs still queued were aimed at the old position. Acknowledge them as
    // handled so that the client stops replaying them after the teleport.
    if (p.queue.length > 0) p.lastSeq = p.queue[p.queue.length - 1].seq;
    p.queue.length = 0;
  }

  private restartRun(p: RoomPlayer): void {
    p.checkpoint = null;
    p.checkpointCount = 0;
    p.seenCheckpoints.clear();
    p.finished = false;
    p.spawn = this.pickSpawn();
    p.runStartTick = this.tickCount;
    // Collected coins stay collected, or restarting would be a coin farm.
    this.respawn(p);
    this.send(p, { t: 'restarted' });
  }

  private handleContacts(p: RoomPlayer): void {
    const s = p.state;
    if (s.y < KILL_Y) {
      this.send(p, { t: 'died' });
      this.respawn(p);
      return;
    }
    const contacts = findContacts(s, this.world);
    if (contacts.hazard) {
      this.send(p, { t: 'died' });
      this.respawn(p);
      return;
    }
    const owner = this.isOwner(p.user);
    if (contacts.checkpoint) {
      const c = contacts.checkpoint;
      const key = this.world.index(c.x, c.y, c.z);
      if (!p.seenCheckpoints.has(key)) {
        p.seenCheckpoints.add(key);
        p.checkpoint = { x: c.x + 0.5, y: c.y + 1.001, z: c.z + 0.5 };
        p.checkpointCount++;
        this.send(p, { t: 'checkpoint', x: c.x, y: c.y, z: c.z, n: p.checkpointCount });
      }
    }
    for (const c of contacts.coins) {
      const key = this.world.index(c.x, c.y, c.z);
      if (p.collected.has(key)) continue;
      p.collected.add(key);
      // Owners get no coins, or building coin worlds would be free money.
      const award = owner ? { granted: 0, coins: p.user.coins } : this.deps.store.awardCoins(p.user.id, COIN_VALUE, this.now());
      p.user.coins = award.coins;
      this.send(p, { t: 'coin', x: c.x, y: c.y, z: c.z, coins: award.coins, granted: award.granted });
    }
    if (contacts.goal && !p.finished) this.finishRun(p, owner);
  }

  private finishRun(p: RoomPlayer, owner: boolean): void {
    p.finished = true;
    const ms = Math.round(((this.tickCount - p.runStartTick) * 1000) / TICK_RATE);
    let granted = 0;
    let best = ms;
    let isBest = false;
    if (!owner) {
      // The owner's own runs stay off the leaderboard.
      const result = this.deps.store.recordCompletion(this.meta.id, p.user.id, ms, this.now());
      best = result.best;
      isBest = result.isBest;
      if (result.reward) {
        const award = this.deps.store.awardCoins(p.user.id, FINISH_REWARD, this.now());
        granted = award.granted;
        p.user.coins = award.coins;
      }
    }
    this.send(p, { t: 'finish', ms, best, isBest, granted, coins: p.user.coins });
    this.broadcast({ t: 'sys', m: `${p.name} finished in ${(ms / 1000).toFixed(2)}s!` }, p);
    this.deps.metrics.inc('runs_finished_total');
  }

  tick(): void {
    this.tickCount++;
    const now = this.now();

    for (const p of this.players.values()) {
      p.budget = Math.min(p.budget + 1, INPUT_BUDGET_MAX);
      if (p.queue.length > 0) {
        while (p.queue.length > 0 && p.budget >= 1) {
          const next = p.queue.shift()!;
          p.budget--;
          p.lastSeq = next.seq;
          this.stepAndResolve(p, next.input);
        }
      } else if (now - p.lastInputAt > IDLE_AFTER_MS) {
        // Keep gravity and hazards running for clients that stop sending, so
        // going silent can't be used to hover in mid-air.
        p.state.vx *= 0.5;
        p.state.vz *= 0.5;
        this.stepAndResolve(p, IDLE_INPUT);
      }
      if (p.emote !== 0 && this.tickCount >= p.emoteUntil) p.emote = 0;
    }

    if (this.fuses.size > 0) this.updateFuses();

    if (this.pendingEdits.length > 0) {
      this.broadcast({ t: 'b', b: this.pendingEdits });
      this.pendingEdits = [];
    }

    if (this.tickCount % SNAPSHOT_INTERVAL_TICKS === 0 && this.players.size > 0) this.sendSnapshots();
  }

  private stepAndResolve(p: RoomPlayer, input: MoveInput): void {
    stepPlayer(p.state, input, this.world);
    const heading = headingForInput(input);
    if (heading !== null) p.heading = heading;
    this.handleContacts(p);
  }

  private sendSnapshots(): void {
    const round = (n: number): number => Math.round(n * 100) / 100;
    const list = [...this.players.values()].map((p) => [
      p.id,
      round(p.state.x),
      round(p.state.y),
      round(p.state.z),
      round(p.heading),
      p.state.grounded ? 1 : 0,
      p.emote,
    ]);
    const shared = JSON.stringify(list);
    for (const p of this.players.values()) {
      if (p.ws.readyState !== WebSocket.OPEN) continue;
      const buffered = p.ws.bufferedAmount;
      if (buffered > MAX_BUFFERED_CLOSE) {
        this.deps.log.warn('closing slow client', { user: p.user.id, buffered });
        p.ws.terminate();
        continue;
      }
      // A slow connection skips snapshots rather than building up a backlog.
      if (buffered > MAX_BUFFERED_SNAPSHOT) {
        this.deps.metrics.inc('snapshots_dropped_total');
        continue;
      }
      p.ws.send(`{"t":"s","k":${this.tickCount},"p":${shared},"me":${JSON.stringify(this.selfState(p))}}`);
    }
  }

  /** Called by the manager once a second. */
  maintenance(saveIntervalMs: number): void {
    if (this.dirty && this.now() - this.lastSave >= saveIntervalMs) this.save();
  }

  save(): void {
    if (!this.dirty) return;
    const start = performance.now();
    const packed = packWorld(this.world);
    const thumb = renderThumbnail(this.world);
    this.deps.store.saveWorldBlocks(this.meta.id, packed, thumb, this.now());
    this.dirty = false;
    this.lastSave = this.now();
    this.deps.metrics.inc('world_saves_total');
    this.deps.log.debug('world saved', { world: this.meta.id, bytes: packed.length, ms: performance.now() - start });
  }

  /** Applies a metadata change made over HTTP while the room is live. */
  refreshMeta(): void {
    const meta = this.deps.store.getWorld(this.meta.id);
    if (!meta) return;
    this.meta = meta;
    for (const p of this.players.values()) this.send(p, { t: 'perm', canBuild: this.canBuild(p.user) });
  }

  closeAll(code: number, reason: string): void {
    for (const p of this.players.values()) p.ws.close(code, reason);
  }
}
