import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_AVATAR, HATS, type Avatar } from '../shared/avatar.ts';
import { DAILY_COIN_CAP, STARTING_COINS } from '../shared/constants.ts';
import { newId } from './auth.ts';

export interface UserRow {
  id: string;
  username: string;
  is_guest: number;
  pw_hash: string | null;
  coins: number;
  avatar: string;
  owned_hats: string;
  coin_day: string | null;
  coin_day_earned: number;
  banned_until: number | null;
  ban_reason: string | null;
  created_at: number;
}

export interface WorldRow {
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  name: string;
  description: string;
  template: string;
  is_public: number;
  build_mode: 'owner' | 'everyone';
  width: number;
  height: number;
  depth: number;
  visits: number;
  likes: number;
  featured: number;
  created_at: number;
  updated_at: number;
}

export type WorldSort = 'popular' | 'new' | 'liked';

export class ConflictError extends Error {}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lc TEXT NOT NULL UNIQUE,
    is_guest INTEGER NOT NULL,
    pw_hash TEXT,
    coins INTEGER NOT NULL,
    avatar TEXT NOT NULL,
    owned_hats TEXT NOT NULL DEFAULT '[]',
    coin_day TEXT,
    coin_day_earned INTEGER NOT NULL DEFAULT 0,
    banned_until INTEGER,
    ban_reason TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE worlds (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    template TEXT NOT NULL,
    seed INTEGER NOT NULL,
    is_public INTEGER NOT NULL,
    build_mode TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    blocks BLOB NOT NULL,
    thumb BLOB,
    visits INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX worlds_owner ON worlds(owner_id);
  CREATE INDEX worlds_public_visits ON worlds(is_public, visits);
  CREATE INDEX worlds_public_created ON worlds(is_public, created_at);
  CREATE TABLE world_likes (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (world_id, user_id)
  );
  CREATE TABLE world_bans (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (world_id, user_id)
  );
  CREATE TABLE completions (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    best_ms INTEGER NOT NULL,
    count INTEGER NOT NULL,
    last_reward_day TEXT,
    achieved_at INTEGER NOT NULL,
    PRIMARY KEY (world_id, user_id)
  );
  CREATE INDEX completions_board ON completions(world_id, best_ms);
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id TEXT,
    world_id TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX reports_open ON reports(resolved_at, created_at);
  `,
];

const WORLD_COLUMNS = `w.id, w.owner_id, u.username AS owner_name, w.name, w.description, w.template,
  w.is_public, w.build_mode, w.width, w.height, w.depth, w.visits, w.likes, w.featured,
  w.created_at, w.updated_at`;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  // --- Users ---

  createUser(username: string, isGuest: boolean, pwHash: string | null, avatar: Avatar, now: number): UserRow {
    const id = newId();
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, username, username_lc, is_guest, pw_hash, coins, avatar, created_at, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, username, username.toLowerCase(), isGuest ? 1 : 0, pwHash, STARTING_COINS, JSON.stringify(avatar), now, now);
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new ConflictError('username taken');
      throw err;
    }
    return this.getUser(id)!;
  }

  /** Turns a guest into a full account, keeping coins, hats and worlds. */
  upgradeGuest(userId: string, username: string, pwHash: string): void {
    try {
      const res = this.db
        .prepare('UPDATE users SET username = ?, username_lc = ?, pw_hash = ?, is_guest = 0 WHERE id = ? AND is_guest = 1')
        .run(username, username.toLowerCase(), pwHash, userId);
      if (res.changes === 0) throw new ConflictError('not a guest account');
    } catch (err) {
      if (String(err).includes('UNIQUE')) throw new ConflictError('username taken');
      throw err;
    }
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username_lc = ?').get(username.toLowerCase()) as UserRow | undefined;
  }

  touchUser(id: string, now: number): void {
    this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, id);
  }

  setAvatar(id: string, avatar: Avatar): void {
    this.db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(JSON.stringify(avatar), id);
  }

  ownedHats(user: UserRow): string[] {
    return JSON.parse(user.owned_hats) as string[];
  }

  /** Atomic: the balance check and the deduction happen in one transaction. */
  buyHat(userId: string, hatId: string): { ok: true; coins: number } | { ok: false; code: string } {
    const hat = HATS.find((h) => h.id === hatId && h.id !== 'none');
    if (!hat) return { ok: false, code: 'unknown_item' };
    return this.tx(() => {
      const user = this.getUser(userId);
      if (!user) return { ok: false as const, code: 'unknown_user' };
      const owned = this.ownedHats(user);
      if (owned.includes(hatId)) return { ok: false as const, code: 'already_owned' };
      if (user.coins < hat.price) return { ok: false as const, code: 'not_enough_coins' };
      this.db
        .prepare('UPDATE users SET coins = coins - ?, owned_hats = ? WHERE id = ?')
        .run(hat.price, JSON.stringify([...owned, hatId]), userId);
      return { ok: true as const, coins: user.coins - hat.price };
    });
  }

  /**
   * Adds coins, limited by the daily cap so that no world (including one built
   * purely to farm coins) can mint more than the cap per player per day.
   */
  awardCoins(userId: string, amount: number, now: number): { granted: number; coins: number } {
    const day = utcDay(now);
    return this.tx(() => {
      const user = this.getUser(userId);
      if (!user) return { granted: 0, coins: 0 };
      const earned = user.coin_day === day ? user.coin_day_earned : 0;
      const granted = Math.max(0, Math.min(amount, DAILY_COIN_CAP - earned));
      this.db
        .prepare('UPDATE users SET coins = coins + ?, coin_day = ?, coin_day_earned = ? WHERE id = ?')
        .run(granted, day, earned + granted, userId);
      return { granted, coins: user.coins + granted };
    });
  }

  banUser(userId: string, until: number, reason: string): boolean {
    return this.tx(() => {
      const res = this.db.prepare('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?').run(until, reason, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return res.changes > 0;
    });
  }

  unbanUser(userId: string): boolean {
    return this.db.prepare('UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = ?').run(userId).changes > 0;
  }

  // --- Sessions ---

  createSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  }

  getSessionUser(tokenHash: string, now: number): UserRow | undefined {
    return this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as UserRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  /** Removes expired sessions and long-abandoned guests that created nothing. */
  cleanup(now: number, guestMaxIdleMs: number): { sessions: number; guests: number } {
    const sessions = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
    const guests = this.db
      .prepare(
        `DELETE FROM users WHERE is_guest = 1 AND last_seen < ?
         AND NOT EXISTS (SELECT 1 FROM worlds w WHERE w.owner_id = users.id)`,
      )
      .run(now - guestMaxIdleMs).changes;
    return { sessions: Number(sessions), guests: Number(guests) };
  }

  // --- Worlds ---

  createWorld(input: {
    id?: string;
    ownerId: string | null;
    name: string;
    description: string;
    template: string;
    seed: number;
    isPublic: boolean;
    buildMode: 'owner' | 'everyone';
    width: number;
    height: number;
    depth: number;
    blocks: Uint8Array;
    thumb: Uint8Array;
    featured?: boolean;
    now: number;
  }): string {
    const id = input.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO worlds (id, owner_id, name, description, template, seed, is_public, build_mode,
           width, height, depth, blocks, thumb, featured, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.ownerId, input.name, input.description, input.template, input.seed,
        input.isPublic ? 1 : 0, input.buildMode, input.width, input.height, input.depth,
        input.blocks, input.thumb, input.featured ? 1 : 0, input.now, input.now,
      );
    return id;
  }

  countWorlds(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM worlds').get() as { n: number }).n);
  }

  countOwnedWorlds(ownerId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM worlds WHERE owner_id = ?').get(ownerId) as { n: number }).n);
  }

  getWorld(id: string): WorldRow | undefined {
    return this.db
      .prepare(`SELECT ${WORLD_COLUMNS} FROM worlds w LEFT JOIN users u ON u.id = w.owner_id WHERE w.id = ?`)
      .get(id) as WorldRow | undefined;
  }

  listPublicWorlds(sort: WorldSort, query: string, limit: number, offset: number): WorldRow[] {
    const order =
      sort === 'new'
        ? 'w.created_at DESC'
        : sort === 'liked'
          ? 'w.likes DESC, w.visits DESC'
          : 'w.featured DESC, w.visits DESC, w.created_at DESC';
    const params: (string | number)[] = [];
    let filter = '';
    if (query) {
      filter = "AND (w.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')";
      const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like);
    }
    params.push(limit, offset);
    return this.db
      .prepare(
        `SELECT ${WORLD_COLUMNS} FROM worlds w LEFT JOIN users u ON u.id = w.owner_id
         WHERE w.is_public = 1 ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params) as unknown as WorldRow[];
  }

  listOwnedWorlds(ownerId: string): WorldRow[] {
    return this.db
      .prepare(
        `SELECT ${WORLD_COLUMNS} FROM worlds w LEFT JOIN users u ON u.id = w.owner_id
         WHERE w.owner_id = ? ORDER BY w.updated_at DESC`,
      )
      .all(ownerId) as unknown as WorldRow[];
  }

  updateWorldMeta(id: string, fields: { name?: string; description?: string; isPublic?: boolean; buildMode?: string }, now: number): void {
    const world = this.getWorld(id);
    if (!world) return;
    this.db
      .prepare('UPDATE worlds SET name = ?, description = ?, is_public = ?, build_mode = ?, updated_at = ? WHERE id = ?')
      .run(
        fields.name ?? world.name,
        fields.description ?? world.description,
        fields.isPublic === undefined ? world.is_public : fields.isPublic ? 1 : 0,
        fields.buildMode ?? world.build_mode,
        now,
        id,
      );
  }

  setWorldPublic(id: string, isPublic: boolean): boolean {
    return this.db.prepare('UPDATE worlds SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, id).changes > 0;
  }

  deleteWorld(id: string): boolean {
    return this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes > 0;
  }

  getWorldBlocks(id: string): Uint8Array | undefined {
    const row = this.db.prepare('SELECT blocks FROM worlds WHERE id = ?').get(id) as { blocks: Uint8Array } | undefined;
    return row?.blocks;
  }

  getWorldThumb(id: string): { thumb: Uint8Array | null; updated_at: number } | undefined {
    return this.db.prepare('SELECT thumb, updated_at FROM worlds WHERE id = ?').get(id) as
      | { thumb: Uint8Array | null; updated_at: number }
      | undefined;
  }

  saveWorldBlocks(id: string, blocks: Uint8Array, thumb: Uint8Array, now: number): void {
    this.db.prepare('UPDATE worlds SET blocks = ?, thumb = ?, updated_at = ? WHERE id = ?').run(blocks, thumb, now, id);
  }

  addVisit(id: string): void {
    this.db.prepare('UPDATE worlds SET visits = visits + 1 WHERE id = ?').run(id);
  }

  hasLiked(worldId: string, userId: string): boolean {
    return this.db.prepare('SELECT 1 FROM world_likes WHERE world_id = ? AND user_id = ?').get(worldId, userId) !== undefined;
  }

  toggleLike(worldId: string, userId: string): { liked: boolean; likes: number } {
    return this.tx(() => {
      const liked = this.hasLiked(worldId, userId);
      if (liked) {
        this.db.prepare('DELETE FROM world_likes WHERE world_id = ? AND user_id = ?').run(worldId, userId);
        this.db.prepare('UPDATE worlds SET likes = likes - 1 WHERE id = ?').run(worldId);
      } else {
        this.db.prepare('INSERT INTO world_likes (world_id, user_id) VALUES (?, ?)').run(worldId, userId);
        this.db.prepare('UPDATE worlds SET likes = likes + 1 WHERE id = ?').run(worldId);
      }
      return { liked: !liked, likes: this.getWorld(worldId)?.likes ?? 0 };
    });
  }

  banFromWorld(worldId: string, userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO world_bans (world_id, user_id) VALUES (?, ?)').run(worldId, userId);
  }

  isBannedFromWorld(worldId: string, userId: string): boolean {
    return this.db.prepare('SELECT 1 FROM world_bans WHERE world_id = ? AND user_id = ?').get(worldId, userId) !== undefined;
  }

  // --- Runs ---

  getBestTime(worldId: string, userId: string): number | null {
    const row = this.db.prepare('SELECT best_ms FROM completions WHERE world_id = ? AND user_id = ?').get(worldId, userId) as
      | { best_ms: number }
      | undefined;
    return row?.best_ms ?? null;
  }

  /** Records a finished run; `reward` is true only for the first finish of the UTC day. */
  recordCompletion(worldId: string, userId: string, ms: number, now: number): { best: number; isBest: boolean; reward: boolean } {
    const day = utcDay(now);
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT best_ms, count, last_reward_day FROM completions WHERE world_id = ? AND user_id = ?')
        .get(worldId, userId) as { best_ms: number; count: number; last_reward_day: string | null } | undefined;
      if (!row) {
        this.db
          .prepare(
            `INSERT INTO completions (world_id, user_id, best_ms, count, last_reward_day, achieved_at)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(worldId, userId, ms, day, now);
        return { best: ms, isBest: true, reward: true };
      }
      const isBest = ms < row.best_ms;
      const reward = row.last_reward_day !== day;
      this.db
        .prepare(
          `UPDATE completions SET best_ms = ?, count = count + 1, last_reward_day = ?, achieved_at = ?
           WHERE world_id = ? AND user_id = ?`,
        )
        .run(isBest ? ms : row.best_ms, day, now, worldId, userId);
      return { best: isBest ? ms : row.best_ms, isBest, reward };
    });
  }

  leaderboard(worldId: string, limit: number): { username: string; best_ms: number; count: number }[] {
    return this.db
      .prepare(
        `SELECT u.username, c.best_ms, c.count FROM completions c JOIN users u ON u.id = c.user_id
         WHERE c.world_id = ? AND (u.banned_until IS NULL OR u.banned_until < ?)
         ORDER BY c.best_ms ASC LIMIT ?`,
      )
      .all(worldId, Date.now(), limit) as unknown as { username: string; best_ms: number; count: number }[];
  }

  // --- Reports ---

  addReport(reporterId: string, targetUserId: string | null, worldId: string | null, reason: string, now: number): void {
    this.db
      .prepare('INSERT INTO reports (reporter_id, target_user_id, world_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reporterId, targetUserId, worldId, reason, now);
  }

  countRecentReports(reporterId: string, since: number): number {
    return Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?').get(reporterId, since) as { n: number }).n,
    );
  }

  listOpenReports(limit: number): unknown[] {
    return this.db
      .prepare(
        `SELECT r.id, r.reason, r.created_at, r.world_id, r.target_user_id,
                reporter.username AS reporter, target.username AS target
         FROM reports r
         JOIN users reporter ON reporter.id = r.reporter_id
         LEFT JOIN users target ON target.id = r.target_user_id
         WHERE r.resolved_at IS NULL ORDER BY r.created_at ASC LIMIT ?`,
      )
      .all(limit);
  }

  resolveReport(id: number, now: number): boolean {
    return this.db.prepare('UPDATE reports SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(now, id).changes > 0;
  }
}

export function parseAvatar(json: string): Avatar {
  try {
    return { ...DEFAULT_AVATAR, ...(JSON.parse(json) as Partial<Avatar>) };
  } catch {
    return { ...DEFAULT_AVATAR };
  }
}
