import { TICK_RATE } from '../shared/constants.ts';
import { Room, type RoomDeps } from './room.ts';

const TICK_MS = 1000 / TICK_RATE;
/** After a long stall, skip ahead instead of running a burst of catch-up ticks. */
const MAX_CATCH_UP_TICKS = 5;

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly deps: RoomDeps;
  private readonly saveIntervalMs: number;
  private readonly roomIdleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private nextTick = 0;
  private lastMaintenance = 0;

  constructor(deps: RoomDeps, saveIntervalMs: number, roomIdleMs: number) {
    this.deps = deps;
    this.saveIntervalMs = saveIntervalMs;
    this.roomIdleMs = roomIdleMs;
    deps.metrics.gauge('rooms_active', () => this.rooms.size);
    deps.metrics.gauge('players_online', () => {
      let n = 0;
      for (const room of this.rooms.values()) n += room.players.size;
      return n;
    });
  }

  start(): void {
    this.nextTick = performance.now() + TICK_MS;
    this.schedule();
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.loop(), Math.max(0, this.nextTick - performance.now()));
  }

  private loop(): void {
    let now = performance.now();
    let ticks = 0;
    while (now >= this.nextTick && ticks < MAX_CATCH_UP_TICKS) {
      this.tickAll();
      this.nextTick += TICK_MS;
      ticks++;
      now = performance.now();
    }
    if (now >= this.nextTick + TICK_MS) {
      const skipped = Math.floor((now - this.nextTick) / TICK_MS);
      this.nextTick += skipped * TICK_MS;
      this.deps.metrics.inc('ticks_skipped_total', skipped);
    }
    if (now - this.lastMaintenance >= 1000) {
      this.lastMaintenance = now;
      this.maintenance();
    }
    this.schedule();
  }

  private tickAll(): void {
    const start = performance.now();
    for (const room of this.rooms.values()) {
      try {
        room.tick();
      } catch (err) {
        // One bad room must not take the others down with it.
        this.deps.metrics.inc('room_errors_total');
        this.deps.log.error('room tick failed', { world: room.worldId, err });
      }
    }
    this.deps.metrics.observeTick(performance.now() - start);
  }

  private maintenance(): void {
    const now = (this.deps.now ?? Date.now)();
    for (const room of this.rooms.values()) {
      try {
        room.maintenance(this.saveIntervalMs);
        if (room.players.size === 0 && now - room.emptySince >= this.roomIdleMs) {
          room.save();
          this.rooms.delete(room.worldId);
          this.deps.log.debug('room unloaded', { world: room.worldId });
        }
      } catch (err) {
        this.deps.metrics.inc('room_errors_total');
        this.deps.log.error('room maintenance failed', { world: room.worldId, err });
      }
    }
  }

  /** Returns the live room, loading the world on first use. */
  getOrLoad(worldId: string): Room | null {
    const live = this.rooms.get(worldId);
    if (live) return live;
    const meta = this.deps.store.getWorld(worldId);
    if (!meta) return null;
    const blocks = this.deps.store.getWorldBlocks(worldId);
    if (!blocks) return null;
    const room = new Room(meta, blocks, this.deps);
    this.rooms.set(worldId, room);
    this.deps.log.debug('room loaded', { world: worldId });
    return room;
  }

  get(worldId: string): Room | undefined {
    return this.rooms.get(worldId);
  }

  playerCount(worldId: string): number {
    return this.rooms.get(worldId)?.players.size ?? 0;
  }

  /** Drops a live room without saving it, for deleted worlds. */
  discard(worldId: string, code: number, reason: string): void {
    const room = this.rooms.get(worldId);
    if (!room) return;
    this.rooms.delete(worldId);
    room.closeAll(code, reason);
  }

  /** Stops ticking and saves everything. Safe to call more than once. */
  shutdown(code: number, reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const room of this.rooms.values()) {
      try {
        room.save();
      } catch (err) {
        this.deps.log.error('failed to save world on shutdown', { world: room.worldId, err });
      }
      room.closeAll(code, reason);
    }
    this.rooms.clear();
  }
}
