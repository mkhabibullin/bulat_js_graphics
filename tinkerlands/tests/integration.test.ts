// Runs the real server on a real port with real sockets and a temp database.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startApp, type App } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { unpackWorld } from '../server/worlddata.ts';
import { B } from '../shared/blocks.ts';
import { BUILD_REACH, CLOSE, PROTOCOL_VERSION, STARTING_COINS, TICK_RATE, WALK_SPEED } from '../shared/constants.ts';
import type { ServerMessage } from '../shared/protocol.ts';

const ADMIN = 'test-admin-token-0123456789abcdef';
const METRICS = 'test-metrics-token';

let app: App;
let base: string;
let tmp: string;
let dbPath: string;

function config(extra: Record<string, string> = {}): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    DB_PATH: dbPath,
    PUBLIC_DIR: path.join(tmp, 'missing'),
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: ADMIN,
    METRICS_TOKEN: METRICS,
    SAVE_INTERVAL_MS: '200',
    RATE_API_PER_MINUTE: '100000',
    RATE_AUTH_PER_MINUTE: '100000',
    RATE_GUESTS_PER_HOUR: '100000',
    MAX_CONNECTIONS_PER_IP: '1000',
    ...extra,
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinkerlands-'));
  dbPath = path.join(tmp, 'test.db');
  app = await startApp(config());
  base = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; data: any; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Not JSON: leave it as text.
  }
  return { status: res.status, data, headers: res.headers };
}

async function guest(): Promise<{ token: string; user: any }> {
  const res = await call('POST', '/api/auth/guest');
  assert.equal(res.status, 201);
  return res.data;
}

class Client {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[] = [];
  welcome: Extract<ServerMessage, { t: 'w' }> | null = null;
  closed: { code: number; reason: string } | null = null;
  seq = 0;

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      if (msg.t === 'w') this.welcome = msg;
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on('error', () => {});
  }

  static async join(token: string, worldId: string): Promise<Client> {
    const c = new Client();
    await c.opened();
    c.raw({ t: 'join', token, worldId, v: PROTOCOL_VERSION });
    await until(() => c.welcome !== null || c.closed !== null);
    return c;
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  raw(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  input(f: number, r: number, jump = false, yaw = 0): void {
    this.raw({ t: 'i', s: ++this.seq, f, r, y: yaw, j: jump ? 1 : 0 });
  }

  lastSnapshot(): Extract<ServerMessage, { t: 's' }> | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.t === 's') return m;
    }
    return undefined;
  }

  find<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.messages.find((m) => m.t === type) as Extract<ServerMessage, { t: T }> | undefined;
  }

  close(): void {
    this.ws.close();
  }
}

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function createWorld(token: string, template = 'plot', extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/api/worlds', { name: 'Test world', template, ...extra }, token);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.world.id;
}

describe('http', () => {
  it('serves health checks and starter worlds', async () => {
    assert.equal((await call('GET', '/healthz')).status, 200);
    assert.equal((await call('GET', '/readyz')).status, 200);
    const list = await call('GET', '/api/worlds');
    assert.equal(list.status, 200);
    assert.ok(list.data.worlds.length >= 5);
    assert.ok(list.data.worlds.some((w: any) => w.id === 'skyline-sprint'));
  });

  it('sends security headers on every response', async () => {
    const { headers } = await call('GET', '/healthz');
    assert.match(headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
  });

  it('protects metrics and admin routes', async () => {
    assert.equal((await call('GET', '/metrics')).status, 401);
    assert.equal((await call('GET', '/metrics', undefined, 'wrong')).status, 401);
    const metrics = await call('GET', '/metrics', undefined, METRICS);
    assert.equal(metrics.status, 200);
    assert.match(metrics.data, /tinkerlands_players_online/);
    assert.equal((await call('GET', '/api/admin/reports')).status, 401);
    assert.equal((await call('GET', '/api/admin/reports', undefined, 'wrong')).status, 401);
    assert.equal((await call('GET', '/api/admin/reports', undefined, ADMIN)).status, 200);
  });

  it('handles bad requests without crashing', async () => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('DELETE', '/api/me')).status, 405);
    assert.equal((await call('GET', '/../../etc/passwd')).status, 404);
    const raw = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400);
    const wrongType = await fetch(`${base}/api/auth/login`, { method: 'POST', body: 'a=b' });
    assert.equal(wrongType.status, 415);
    const huge = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(100_000) }) });
    assert.equal(huge.status, 413);
  });

  it('runs the account lifecycle', async () => {
    const g = await guest();
    assert.equal(g.user.guest, true);
    assert.equal(g.user.coins, STARTING_COINS);

    const me = await call('GET', '/api/me', undefined, g.token);
    assert.equal(me.data.user.id, g.user.id);
    assert.equal((await call('GET', '/api/me')).status, 401);

    assert.equal((await call('POST', '/api/auth/register', { username: 'x', password: 'password1' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'okname', password: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'Guest_fake', password: 'password1' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'shit_lord', password: 'password1' })).status, 400);

    const name = `player_${Date.now() % 100000}`;
    const upgraded = await call('POST', '/api/auth/register', { username: name, password: 'password123' }, g.token);
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.data.user.id, g.user.id, 'upgrade keeps the same account');
    assert.equal(upgraded.data.user.guest, false);

    assert.equal((await call('POST', '/api/auth/register', { username: name.toUpperCase(), password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { username: name, password: 'nope-nope' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { username: 'no_such_user', password: 'nope-nope' })).status, 401);
    const login = await call('POST', '/api/auth/login', { username: name, password: 'password123' });
    assert.equal(login.status, 200);

    await call('POST', '/api/auth/logout', undefined, login.data.token);
    assert.equal((await call('GET', '/api/me', undefined, login.data.token)).status, 401);
    assert.equal((await call('GET', '/api/me', undefined, g.token)).status, 200, 'other sessions stay valid');
  });

  it('rate-limits auth attempts', async () => {
    const limited = await startApp(config({ DB_PATH: path.join(tmp, 'limited.db'), RATE_AUTH_PER_MINUTE: '3' }));
    const url = `http://127.0.0.1:${limited.port}/api/auth/login`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'a', password: 'b' }) });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    await limited.stop();
  });

  it('validates worlds, ownership and limits', async () => {
    const a = await guest();
    const b = await guest();
    assert.equal((await call('POST', '/api/worlds', { name: 'x', template: 'plot' }, a.token)).status, 400);
    assert.equal((await call('POST', '/api/worlds', { name: 'Fine name', template: 'hack' }, a.token)).status, 400);
    assert.equal((await call('POST', '/api/worlds', { name: 'shit world', template: 'plot' }, a.token)).status, 400);
    assert.equal((await call('POST', '/api/worlds', { name: 'Fine name', template: 'plot' })).status, 401);

    const id = await createWorld(a.token);
    assert.equal((await call('PATCH', `/api/worlds/${id}`, { name: 'Hijacked' }, b.token)).status, 404);
    assert.equal((await call('DELETE', `/api/worlds/${id}`, undefined, b.token)).status, 404);
    assert.equal((await call('PATCH', `/api/worlds/${id}`, { name: 'Renamed world' }, a.token)).data.world.name, 'Renamed world');

    await createWorld(a.token);
    const third = await call('POST', '/api/worlds', { name: 'Third one', template: 'plot' }, a.token);
    assert.equal(third.status, 409, 'guests are limited to two worlds');

    // Private worlds are hidden from everyone but the owner.
    assert.equal((await call('PATCH', `/api/worlds/${id}`, { isPublic: false }, a.token)).status, 200);
    assert.equal((await call('GET', `/api/worlds/${id}`, undefined, b.token)).status, 404);
    assert.equal((await call('GET', `/api/worlds/${id}`, undefined, a.token)).status, 200);
    const c = await Client.join(b.token, id);
    assert.equal(c.closed?.code, CLOSE.NOT_FOUND);

    assert.equal((await call('DELETE', `/api/worlds/${id}`, undefined, a.token)).status, 200);
    assert.equal((await call('GET', `/api/worlds/${id}`, undefined, a.token)).status, 404);
  });

  it('serves real PNG thumbnails with caching', async () => {
    const res = await fetch(`${base}/api/worlds/skyline-sprint/thumb.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const etag = res.headers.get('etag')!;
    assert.ok((await res.arrayBuffer()).byteLength > 500);
    const cached = await fetch(`${base}/api/worlds/skyline-sprint/thumb.png`, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
  });

  it('runs the shop and validates avatars', async () => {
    const g = await guest();
    assert.equal((await call('POST', '/api/shop/buy', { itemId: 'crown' }, g.token)).status, 402);
    const avatar = { ...g.user.avatar, hat: 'cap' };
    assert.equal((await call('PUT', '/api/me/avatar', { avatar }, g.token)).status, 400, 'can’t wear an unowned hat');
    const bought = await call('POST', '/api/shop/buy', { itemId: 'cap' }, g.token);
    assert.equal(bought.status, 200);
    assert.equal(bought.data.user.coins, STARTING_COINS - 25);
    assert.equal((await call('PUT', '/api/me/avatar', { avatar }, g.token)).status, 200);
  });

  it('takes likes and reports, and supports moderation', async () => {
    const a = await guest();
    const b = await guest();
    const liked = await call('POST', '/api/worlds/open-plots/like', undefined, a.token);
    assert.equal(liked.data.liked, true);
    const unliked = await call('POST', '/api/worlds/open-plots/like', undefined, a.token);
    assert.equal(unliked.data.liked, false);

    assert.equal((await call('POST', '/api/reports', { reason: 'x' }, a.token)).status, 400);
    assert.equal((await call('POST', '/api/reports', { reason: 'Being rude', targetUserId: b.user.id }, a.token)).status, 201);
    const reports = await call('GET', '/api/admin/reports', undefined, ADMIN);
    const report = reports.data.reports.find((r: any) => r.target_user_id === b.user.id);
    assert.ok(report);
    assert.equal((await call('POST', `/api/admin/reports/${report.id}/resolve`, undefined, ADMIN)).status, 200);

    const client = await Client.join(b.token, 'open-plots');
    assert.ok(client.welcome);
    assert.equal((await call('POST', `/api/admin/users/${b.user.id}/ban`, { reason: 'Repeated abuse', days: 1 }, ADMIN)).status, 200);
    await until(() => client.closed !== null);
    assert.equal(client.closed?.code, CLOSE.BANNED);
    assert.equal((await call('GET', '/api/me', undefined, b.token)).status, 401, 'bans end sessions');
    await call('POST', `/api/admin/users/${b.user.id}/unban`, undefined, ADMIN);
  });
});

describe('game sockets', () => {
  it('rejects bad joins', async () => {
    const g = await guest();
    const badToken = await Client.join('not-a-token', 'open-plots');
    assert.equal(badToken.closed?.code, CLOSE.AUTH);
    const badWorld = await Client.join(g.token, 'no-such-world');
    assert.equal(badWorld.closed?.code, CLOSE.NOT_FOUND);

    const oldClient = new Client();
    await oldClient.opened();
    oldClient.raw({ t: 'join', token: g.token, worldId: 'open-plots', v: PROTOCOL_VERSION + 1 });
    await until(() => oldClient.closed !== null);
    assert.equal(oldClient.closed?.code, CLOSE.PROTOCOL);
  });

  it('refuses browsers from other origins', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { Origin: 'https://evil.example' } });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    assert.equal(status, 403);
  });

  it('closes a connection that never joins, ignoring pre-join traffic', async () => {
    const c = new Client();
    await c.opened();
    c.raw({ t: 'c', m: 'hello?' });
    await sleep(100);
    assert.equal(c.messages.length, 0);
    c.close();
  });

  it('sends a world that decodes to the right size', async () => {
    const g = await guest();
    const c = await Client.join(g.token, 'skyline-sprint');
    const w = c.welcome!.world;
    const world = unpackWorld(Buffer.from(w.blocks, 'base64'), w.w, w.h, w.d);
    assert.ok(world.data.some((b) => b === B.GOAL));
    c.close();
  });

  it('simulates movement on the server and acknowledges inputs', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    const startX = c.welcome!.me.x;
    await sleep(300);
    for (let i = 0; i < 30; i++) {
      c.input(0, 1);
      await sleep(1000 / TICK_RATE);
    }
    await until(() => (c.lastSnapshot()?.me.s ?? 0) >= 25);
    const me = c.lastSnapshot()!.me;
    assert.ok(me.x > startX + 3, `moved from ${startX} to ${me.x}`);
    c.close();
  });

  it('stops speed hacks: flooding inputs does not move you faster', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(300);
    const startX = c.lastSnapshot()!.me.x;
    const started = Date.now();
    // A cheating client sends far more than one input per tick.
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 20; i++) c.input(0, 1);
      await sleep(100);
    }
    const seconds = (Date.now() - started) / 1000;
    await sleep(100);
    const moved = c.lastSnapshot()!.me.x - startX;
    const limit = WALK_SPEED * (seconds + 0.3) * 1.25;
    assert.ok(moved <= limit, `moved ${moved} in ${seconds}s (limit ${limit})`);
    c.close();
  });

  it('ignores replayed and out-of-order inputs', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(100);
    c.raw({ t: 'i', s: 100, f: 0, r: 0, y: 0, j: 0 });
    c.raw({ t: 'i', s: 50, f: 0, r: 1, y: 0, j: 0 });
    c.raw({ t: 'i', s: 100, f: 0, r: 1, y: 0, j: 0 });
    await until(() => (c.lastSnapshot()?.me.s ?? 0) === 100);
    const x = c.lastSnapshot()!.me.x;
    await sleep(100);
    assert.equal(c.lastSnapshot()!.me.s, 100);
    assert.ok(Math.abs(c.lastSnapshot()!.me.x - x) < 0.5);
    c.close();
  });

  it('applies gravity to clients that stop sending', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(200);
    const groundY = c.lastSnapshot()!.me.y;
    c.input(0, 0, true);
    await sleep(1200);
    const y = c.lastSnapshot()!.me.y;
    assert.ok(Math.abs(y - groundY) < 0.05, `y ${y} vs ground ${groundY}`);
    c.close();
  });

  it('closes abusive connections and survives garbage', async () => {
    const g = await guest();
    const c = await Client.join(g.token, 'open-plots');
    for (let i = 0; i < 100; i++) c.raw('{"t":"garbage"}');
    await until(() => c.closed !== null);
    assert.equal(c.closed?.code, CLOSE.ABUSE);
    assert.equal((await call('GET', '/healthz')).status, 200);

    // Oversized frames are dropped by the socket layer without harming the server.
    const big = await Client.join((await guest()).token, 'open-plots');
    big.raw('x'.repeat(5000));
    await until(() => big.closed !== null);
    assert.equal((await call('GET', '/healthz')).status, 200);
  });

  it('keeps one session per account', async () => {
    const g = await guest();
    const first = await Client.join(g.token, 'open-plots');
    const second = await Client.join(g.token, 'open-plots');
    assert.ok(second.welcome);
    await until(() => first.closed !== null);
    assert.equal(first.closed?.code, CLOSE.SUPERSEDED);
    second.close();
  });

  it('shows players to each other, with snapshots, chat and filtering', async () => {
    const a = await guest();
    const b = await guest();
    const id = await createWorld(a.token, 'plot', { buildMode: 'everyone' });
    const ca = await Client.join(a.token, id);
    const cb = await Client.join(b.token, id);
    assert.equal(cb.welcome!.players.length, 1);
    assert.equal(cb.welcome!.players[0].uid, a.user.id);
    await until(() => ca.find('pj') !== undefined);
    await until(() => (ca.lastSnapshot()?.p.length ?? 0) === 2);

    cb.raw({ t: 'c', m: 'hello there' });
    await until(() => ca.messages.some((m) => m.t === 'c' && m.m === 'hello there'));

    cb.raw({ t: 'c', m: 'oh shit ‮wow' });
    await until(() => ca.messages.some((m) => m.t === 'c' && m.m === 'oh **** wow'));

    // Chat is rate limited.
    for (let i = 0; i < 12; i++) cb.raw({ t: 'c', m: `spam ${i}` });
    await sleep(150);
    assert.ok(cb.messages.some((m) => m.t === 'sys' && m.m.includes('too quickly')));
    const spam = ca.messages.filter((m) => m.t === 'c' && m.m.startsWith('spam'));
    assert.ok(spam.length <= 6, `${spam.length} spam messages got through`);

    cb.close();
    await until(() => ca.find('pl') !== undefined);
    ca.close();
  });

  it('enforces build permissions, reach and overlap on the server', async () => {
    const owner = await guest();
    const visitor = await guest();
    const id = await createWorld(owner.token, 'plot', { buildMode: 'owner' });
    const co = await Client.join(owner.token, id);
    const cv = await Client.join(visitor.token, id);
    await sleep(100);
    const me = co.lastSnapshot()!.me;
    const x = Math.floor(me.x) + 3;
    const y = Math.floor(me.y);
    const z = Math.floor(me.z);

    // Visitors can't build in an owner-only world.
    cv.raw({ t: 'b', x, y, z, k: B.BRICK });
    await until(() => cv.find('br') !== undefined);
    assert.match(cv.find('br')!.why, /can’t build/);

    // Owners can, and everyone sees it.
    co.raw({ t: 'b', x, y, z, k: B.BRICK });
    await until(() => cv.messages.some((m) => m.t === 'b' && m.b.join() === [x, y, z, B.BRICK].join()));

    // Too far away.
    const farX = Math.floor(me.x) + BUILD_REACH + 10 < 96 ? Math.floor(me.x) + BUILD_REACH + 10 : Math.floor(me.x) - BUILD_REACH - 10;
    co.raw({ t: 'b', x: farX, y, z, k: B.BRICK });
    await until(() => co.messages.some((m) => m.t === 'br' && m.why === 'Too far away.'));

    // Not on top of anyone.
    co.raw({ t: 'b', x: Math.floor(me.x), y, z: Math.floor(me.z), k: B.BRICK });
    await until(() => co.messages.some((m) => m.t === 'br' && m.why.includes('standing there')));

    // Opening the world to everyone applies live, but gameplay blocks stay owner-only.
    await call('PATCH', `/api/worlds/${id}`, { buildMode: 'everyone' }, owner.token);
    await until(() => cv.messages.some((m) => m.t === 'perm' && m.canBuild));
    cv.raw({ t: 'b', x: x + 1, y, z, k: B.COIN });
    await until(() => cv.messages.some((m) => m.t === 'br' && m.why.includes('Only the world’s owner')));
    cv.raw({ t: 'b', x: x + 1, y, z, k: B.PLANKS });
    await until(() => co.messages.some((m) => m.t === 'b' && m.b.join() === [x + 1, y, z, B.PLANKS].join()));

    co.close();
    cv.close();
  });

  it('makes blocks take time to break, and shows mining to other players', async () => {
    const owner = await guest();
    const visitor = await guest();
    const id = await createWorld(owner.token, 'plot', { buildMode: 'everyone' });
    const cv = await Client.join(visitor.token, id);
    const co = await Client.join(owner.token, id);
    await sleep(100);
    const me = cv.lastSnapshot()!.me;
    const x = Math.floor(me.x) + 3;
    const y = Math.floor(me.y) + 1;
    const z = Math.floor(me.z);
    const rejected = (why: string): boolean => cv.messages.some((m) => m.t === 'br' && m.why === why);
    const clearRejections = (): void => {
      cv.messages.length = 0;
    };

    cv.raw({ t: 'b', x, y, z, k: B.STONE });
    await until(() => co.messages.some((m) => m.t === 'b' && m.b.join() === [x, y, z, B.STONE].join()));

    // No mining at all: refused, and told the true block so the client can undo it.
    clearRejections();
    cv.raw({ t: 'b', x, y, z, k: B.AIR });
    await until(() => rejected('That block isn’t broken yet.'));
    assert.equal(cv.find('br')!.k, B.STONE);

    // Mining but not for long enough (stone takes one second).
    clearRejections();
    cv.raw({ t: 'm', x, y, z });
    await until(() => co.messages.some((m) => m.t === 'mi' && m.c?.join() === [x, y, z].join() && m.ms === 1000));
    await sleep(150);
    cv.raw({ t: 'b', x, y, z, k: B.AIR });
    await until(() => rejected('That block isn’t broken yet.'));

    // Stopping loses the progress, and other players are told.
    cv.raw({ t: 'mx' });
    await until(() => co.messages.some((m) => m.t === 'mi' && m.c === null));
    await sleep(1100);
    clearRejections();
    cv.raw({ t: 'b', x, y, z, k: B.AIR });
    await until(() => rejected('That block isn’t broken yet.'));

    // Time spent on one block doesn't count toward another.
    clearRejections();
    cv.raw({ t: 'm', x, y, z });
    await sleep(1100);
    cv.raw({ t: 'b', x, y: y + 1, z, k: B.BRICK });
    await until(() => co.messages.some((m) => m.t === 'b' && m.b.join() === [x, y + 1, z, B.BRICK].join()));
    cv.raw({ t: 'b', x, y: y + 1, z, k: B.AIR });
    await until(() => rejected('That block isn’t broken yet.'));

    // Swapping a block for another can't dodge mining, for visitors.
    clearRejections();
    cv.raw({ t: 'b', x, y, z, k: B.LEAVES });
    await until(() => rejected('Break that block first.'));

    // Mining for the full time works, and only once per start.
    cv.raw({ t: 'b', x, y, z, k: B.AIR });
    await until(() => co.messages.some((m) => m.t === 'b' && m.b.join() === [x, y, z, B.AIR].join()));

    // Nobody can mine a gameplay block unless they own the world.
    const spawnX = Math.floor(me.x);
    const spawnZ = Math.floor(me.z);
    const spawnY = Math.floor(me.y) - 1;
    clearRejections();
    cv.raw({ t: 'm', x: spawnX, y: spawnY, z: spawnZ });
    await sleep(800);
    cv.raw({ t: 'b', x: spawnX, y: spawnY, z: spawnZ, k: B.AIR });
    await until(() => cv.messages.some((m) => m.t === 'br' && m.why.includes('Only the world’s owner')));

    co.close();
    cv.close();
  });

  it('explodes lit TNT: crater, protected blocks, chain reaction and thrown players', async () => {
    const owner = await guest();
    const id = await createWorld(owner.token);
    const c = await Client.join(owner.token, id);
    await sleep(100);
    const me = c.lastSnapshot()!.me;
    const world = app.rooms.get(id)!.world;
    const ground = Math.floor(me.y) - 1;
    const tx = Math.floor(me.x) + 6;
    const tz = Math.floor(me.z);

    // Far enough from the spawn pad and the player to tell the cases apart.
    c.raw({ t: 'b', x: tx, y: ground + 1, z: tz, k: B.TNT });
    // A second TNT in the blast, which the first one must set off.
    c.raw({ t: 'b', x: tx + 3, y: ground + 1, z: tz, k: B.TNT });
    // A gameplay block inside the blast, which must survive.
    c.raw({ t: 'b', x: tx, y: ground, z: tz + 1, k: B.CHECKPOINT });
    await until(() => world.get(tx, ground + 1, tz) === B.TNT && world.get(tx, ground, tz + 1) === B.CHECKPOINT);

    // Not lit: nothing happens by itself.
    await sleep(100);
    assert.equal(c.find('tl'), undefined);

    c.raw({ t: 'l', x: tx, y: ground, z: tz });
    await sleep(50);
    assert.equal(c.find('tl'), undefined, 'only TNT can be lit');

    const litAt = Date.now();
    c.raw({ t: 'l', x: tx, y: ground + 1, z: tz });
    await until(() => c.find('tl') !== undefined);
    assert.equal(c.find('tl')!.ms, 3000);
    await sleep(500);
    assert.equal(world.get(tx, ground, tz), B.GRASS, 'the fuse takes time');

    await until(() => c.find('boom') !== undefined, 5000);
    const fuse = Date.now() - litAt;
    assert.ok(fuse > 2500 && fuse < 3800, `fuse took ${fuse} ms`);
    assert.equal(world.get(tx, ground + 1, tz), B.AIR);
    assert.equal(world.get(tx, ground, tz), B.AIR, 'the ground is blown away');
    assert.equal(world.get(tx, ground - 2, tz), B.AIR, 'and it digs a crater');
    assert.equal(world.get(tx, ground, tz + 1), B.CHECKPOINT, 'gameplay blocks survive');

    // The player, standing about 6 blocks away, gets thrown away from the blast.
    await until(() => (c.lastSnapshot()?.me.y ?? 0) > me.y + 0.2);

    // The second TNT goes off shortly after, from the chain reaction.
    await until(() => c.messages.filter((m) => m.t === 'boom').length === 2);
    assert.equal(world.get(tx + 3, ground + 1, tz), B.AIR);
    c.close();
  });

  it('lets TNT be defused, sends close players back, and blocks visitors in owner-only worlds', async () => {
    const owner = await guest();
    const visitor = await guest();
    const id = await createWorld(owner.token);
    const co = await Client.join(owner.token, id);
    const cv = await Client.join(visitor.token, id);
    await sleep(100);
    const me = co.lastSnapshot()!.me;
    const world = app.rooms.get(id)!.world;
    const ground = Math.floor(me.y) - 1;
    const tx = Math.floor(me.x) + 5;
    const tz = Math.floor(me.z);

    co.raw({ t: 'b', x: tx, y: ground + 1, z: tz, k: B.TNT });
    await until(() => world.get(tx, ground + 1, tz) === B.TNT);

    // A visitor can't light TNT in a world they can't build in.
    cv.raw({ t: 'l', x: tx, y: ground + 1, z: tz });
    await sleep(100);
    assert.equal(co.find('tl'), undefined);

    // The owner lights it, then breaks it in time.
    co.raw({ t: 'l', x: tx, y: ground + 1, z: tz });
    await until(() => co.find('tl') !== undefined);
    co.raw({ t: 'm', x: tx, y: ground + 1, z: tz });
    await sleep(200);
    co.raw({ t: 'b', x: tx, y: ground + 1, z: tz, k: B.AIR });
    await until(() => world.get(tx, ground + 1, tz) === B.AIR);
    await sleep(3200);
    assert.equal(co.find('boom'), undefined, 'defused TNT must not explode');

    // Standing right beside it sends the player back to the spawn.
    const start = co.lastSnapshot()!.me;
    co.raw({ t: 'b', x: Math.floor(start.x) + 1, y: ground + 1, z: Math.floor(start.z), k: B.TNT });
    await sleep(60);
    co.raw({ t: 'l', x: Math.floor(start.x) + 1, y: ground + 1, z: Math.floor(start.z) });
    await until(() => co.find('died') !== undefined, 5000);
    co.close();
    cv.close();
  });

  it('rate-limits lighting TNT', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(100);
    const me = c.lastSnapshot()!.me;
    const y = Math.floor(me.y);
    const z = Math.floor(me.z) + 4;
    const x0 = Math.floor(me.x) - 4;
    const world = app.rooms.get(id)!.world;
    for (let i = 0; i < 9; i++) c.raw({ t: 'b', x: x0 + i, y, z, k: B.TNT });
    await until(() => world.get(x0 + 8, y, z) === B.TNT);
    for (let i = 0; i < 9; i++) c.raw({ t: 'l', x: x0 + i, y, z });
    await sleep(150);
    const lit = c.messages.filter((m) => m.t === 'tl').length;
    assert.ok(lit >= 5 && lit <= 6, `${lit} fuses started`);
    c.close();
  });

  it('rate-limits building', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(100);
    const me = c.lastSnapshot()!.me;
    for (let i = 0; i < 60; i++) {
      c.raw({ t: 'b', x: Math.floor(me.x) + 2 + (i % 5), y: Math.floor(me.y) + (i % 3) + 2, z: Math.floor(me.z) + (i % 7), k: i % 2 ? B.BRICK : B.PLANKS });
    }
    await until(() => c.messages.some((m) => m.t === 'br' && m.why === 'Building too fast.'));
    c.close();
  });

  it('owners can remove players, and they can’t come back', async () => {
    const owner = await guest();
    const visitor = await guest();
    const id = await createWorld(owner.token);
    const co = await Client.join(owner.token, id);
    const cv = await Client.join(visitor.token, id);
    await until(() => co.find('pj') !== undefined);
    const visitorId = cv.welcome!.you;

    // A visitor can't kick the owner.
    cv.raw({ t: 'kick', id: co.welcome!.you });
    await sleep(100);
    assert.equal(co.closed, null);

    co.raw({ t: 'kick', id: visitorId });
    await until(() => cv.closed !== null);
    assert.equal(cv.closed?.code, CLOSE.KICKED);
    const again = await Client.join(visitor.token, id);
    assert.equal(again.closed?.code, CLOSE.KICKED);
    co.close();
  });

  it('plays a full round: coin, checkpoint, lava, goal, rewards, leaderboard', async () => {
    const owner = await guest();
    const runner = await guest();
    const id = await createWorld(owner.token);
    const co = await Client.join(owner.token, id);
    await sleep(100);
    const spawn = co.lastSnapshot()!.me;
    const floorY = Math.floor(spawn.y) - 1;
    const sz = Math.floor(spawn.z);
    const sx = Math.floor(spawn.x);

    // Lay a strip beside the spawn, walking +X: coin, checkpoint, goal; lava at -X.
    const place = async (x: number, y: number, k: number): Promise<void> => {
      co.raw({ t: 'b', x, y, z: sz, k });
      await sleep(60);
    };
    await place(sx + 4, floorY + 1, B.COIN);
    await place(sx + 7, floorY, B.CHECKPOINT);
    await place(sx + 10, floorY, B.GOAL);
    co.close();
    await sleep(100);

    const c = await Client.join(runner.token, id);
    assert.ok(c.welcome);
    await sleep(100);
    const run = async (r: number, stop: () => boolean): Promise<void> => {
      const start = Date.now();
      while (!stop()) {
        if (Date.now() - start > 6000) throw new Error('run timed out');
        c.input(0, r);
        await sleep(1000 / TICK_RATE);
      }
    };

    // The owner's spawn was random within the 3×3 pad, so align this runner first.
    const target = sz + 0.5;
    const begin = Date.now();
    let settled = 0;
    while (settled < 8) {
      assert.ok(Date.now() - begin < 4000, 'could not line up with the strip');
      const dz = c.lastSnapshot()!.me.z - target;
      settled = Math.abs(dz) < 0.2 ? settled + 1 : 0;
      // Slow down on approach. At yaw 0, moving forward means going toward -Z.
      c.input(Math.max(-1, Math.min(1, dz * 0.8)), 0);
      await sleep(1000 / TICK_RATE);
    }

    await run(1, () => c.find('coin') !== undefined);
    const coin = c.find('coin')!;
    assert.equal(coin.granted, 1);
    assert.equal(coin.coins, STARTING_COINS + 1);

    await run(1, () => c.find('checkpoint') !== undefined);
    assert.equal(c.find('checkpoint')!.n, 1);

    await run(1, () => c.find('finish') !== undefined);
    const finish = c.find('finish')!;
    assert.ok(finish.ms > 200 && finish.ms < 10_000, `time ${finish.ms}`);
    assert.equal(finish.granted, 50);
    assert.equal(finish.isBest, true);

    const detail = await call('GET', `/api/worlds/${id}`);
    assert.equal(detail.data.leaderboard.length, 1);
    assert.equal(detail.data.leaderboard[0].ms, finish.ms);
    const me = await call('GET', '/api/me', undefined, runner.token);
    assert.equal(me.data.user.coins, STARTING_COINS + 51);

    // Restarting doesn't pay out again today, and doesn't reset collected coins.
    c.raw({ t: 'restart' });
    await until(() => c.find('restarted') !== undefined);
    c.close();
    const after = await call('GET', '/api/me', undefined, runner.token);
    assert.equal(after.data.user.coins, STARTING_COINS + 51);
  });

  it('sends players back when they touch lava or fall', async () => {
    const owner = await guest();
    const id = await createWorld(owner.token);
    const c = await Client.join(owner.token, id);
    await sleep(100);
    const spawn = c.lastSnapshot()!.me;
    const sx = Math.floor(spawn.x);
    const sz = Math.floor(spawn.z);
    const floorY = Math.floor(spawn.y) - 1;
    // Lava in a band across the player's path.
    for (let dz = -3; dz <= 3; dz++) {
      c.raw({ t: 'b', x: sx + 4, y: floorY, z: sz + dz, k: B.LAVA });
    }
    await sleep(60);
    const start = Date.now();
    while (!c.find('died')) {
      if (Date.now() - start > 4000) throw new Error('never died');
      c.input(0, 1);
      await sleep(1000 / TICK_RATE);
    }
    await sleep(120);
    assert.ok(Math.abs(c.lastSnapshot()!.me.x - spawn.x) < 3.5, 'returned to spawn');
    c.close();
  });

  it('gives owners no coins and no leaderboard entry for their own world', async () => {
    const owner = await guest();
    const id = await createWorld(owner.token);
    const c = await Client.join(owner.token, id);
    await sleep(100);
    const spawn = c.lastSnapshot()!.me;
    const y = Math.floor(spawn.y) - 1;
    c.raw({ t: 'b', x: Math.floor(spawn.x) + 3, y, z: Math.floor(spawn.z), k: B.GOAL });
    await sleep(60);
    const start = Date.now();
    while (!c.find('finish')) {
      if (Date.now() - start > 4000) throw new Error('never finished');
      c.input(0, 1);
      await sleep(1000 / TICK_RATE);
    }
    assert.equal(c.find('finish')!.granted, 0);
    assert.equal((await call('GET', `/api/worlds/${id}`)).data.leaderboard.length, 0);
    c.close();
  });
});

describe('persistence', () => {
  it('saves edits and restores them after a restart', async () => {
    const localDb = path.join(tmp, 'restart.db');
    const first = await startApp(config({ DB_PATH: localDb }));
    const url = `http://127.0.0.1:${first.port}`;
    const auth = await (await fetch(`${url}/api/auth/guest`, { method: 'POST' })).json() as { token: string };
    const created = await (await fetch(`${url}/api/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ name: 'Keep me', template: 'plot' }),
    })).json() as { world: { id: string } };

    const ws = new WebSocket(`ws://127.0.0.1:${first.port}/ws`);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'join', token: auth.token, worldId: created.world.id, v: PROTOCOL_VERSION }));
    await until(() => messages.some((m) => m.t === 's'));
    const me = (messages.find((m) => m.t === 's') as Extract<ServerMessage, { t: 's' }>).me;
    const edit = { x: Math.floor(me.x) + 2, y: Math.floor(me.y) + 1, z: Math.floor(me.z), k: B.BRICK };
    ws.send(JSON.stringify({ t: 'b', ...edit }));
    await until(() => messages.some((m) => m.t === 'b'));

    // Shut down while the player is still connected: the edit must not be lost.
    await first.stop();

    const second = await startApp(config({ DB_PATH: localDb }));
    const blocks = second.store.getWorldBlocks(created.world.id)!;
    const world = unpackWorld(blocks, 96, 48, 96);
    assert.equal(world.get(edit.x, edit.y, edit.z), B.BRICK);
    await second.stop();
  });

  it('autosaves on the interval while players are connected', async () => {
    const g = await guest();
    const id = await createWorld(g.token);
    const c = await Client.join(g.token, id);
    await sleep(100);
    const me = c.lastSnapshot()!.me;
    const edit = { x: Math.floor(me.x) + 2, y: Math.floor(me.y) + 1, z: Math.floor(me.z), k: B.METAL };
    c.raw({ t: 'b', ...edit });
    await until(() => c.messages.some((m) => m.t === 'b'));
    await until(() => {
      const saved = unpackWorld(app.store.getWorldBlocks(id)!, 96, 48, 96);
      return saved.get(edit.x, edit.y, edit.z) === B.METAL;
    }, 3000);
    c.close();
  });
});
