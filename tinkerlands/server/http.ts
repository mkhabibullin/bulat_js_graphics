import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { randomAvatar, HATS, validateAvatar, type Avatar } from '../shared/avatar.ts';
import { CLOSE, WORLD_D, WORLD_H, WORLD_W } from '../shared/constants.ts';
import { generateWorld, TEMPLATES, type TemplateId } from '../shared/templates.ts';
import { dummyPasswordHash, hashPassword, hashToken, newSessionToken, safeEqual, verifyPassword } from './auth.ts';
import type { Config } from './config.ts';
import { clientIp, type Gateway } from './gateway.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { sanitizeText, type TextFilter } from './moderation.ts';
import { KeyedRateLimiter } from './ratelimit.ts';
import type { RoomManager } from './rooms.ts';
import { ConflictError, parseAvatar, type Store, type UserRow, type WorldRow, type WorldSort } from './store.ts';
import { packWorld, renderThumbnail } from './worlddata.ts';

const SESSION_MS = 90 * 24 * 3600 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_WORLDS_GUEST = 2;
const MAX_WORLDS_USER = 20;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const REPORTS_PER_DAY = 20;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  url: URL;
  ip: string;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface StaticFile {
  type: string;
  cache: string;
  identity: Buffer;
  br?: Buffer;
  gz?: Buffer;
  etag: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Three.js and the HUD set element.style, which CSP treats as allowed CSSOM.
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface HttpDeps {
  config: Config;
  store: Store;
  rooms: RoomManager;
  gateway: () => Gateway | null;
  log: Logger;
  metrics: Metrics;
  filter: TextFilter;
  isDraining: () => boolean;
}

export function createHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, store, rooms, log, metrics, filter } = deps;
  const apiLimiter = new KeyedRateLimiter(config.rate.apiPerMinute, 60_000);
  const authLimiter = new KeyedRateLimiter(config.rate.authPerMinute, 60_000);
  const guestLimiter = new KeyedRateLimiter(config.rate.guestsPerHour, 3_600_000);
  const staticFiles = loadStatic(config.publicDir, log);

  function json(ctx: Ctx, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    ctx.res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    ctx.res.end(text);
  }

  async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
    const type = ctx.req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json')) {
      throw new HttpError(415, 'unsupported_media_type', 'Send JSON.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of ctx.req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request is too large.');
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body isn’t valid JSON.');
    }
  }

  function bearer(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    return header.slice(7);
  }

  function requireUser(ctx: Ctx): UserRow {
    const token = bearer(ctx.req);
    const user = token ? store.getSessionUser(hashToken(token), Date.now()) : undefined;
    if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    if (user.banned_until !== null && user.banned_until > Date.now()) {
      throw new HttpError(403, 'banned', 'This account is banned.');
    }
    return user;
  }

  function optionalUser(ctx: Ctx): UserRow | undefined {
    const token = bearer(ctx.req);
    return token ? store.getSessionUser(hashToken(token), Date.now()) : undefined;
  }

  function requireAdmin(ctx: Ctx): void {
    const token = bearer(ctx.req);
    if (!config.adminToken || !token || !safeEqual(token, config.adminToken)) {
      throw new HttpError(401, 'unauthorized', 'Admin token required.');
    }
  }

  function startSession(userId: string): string {
    const token = newSessionToken();
    store.createSession(hashToken(token), userId, Date.now() + SESSION_MS);
    return token;
  }

  function publicUser(u: UserRow): Record<string, unknown> {
    return {
      id: u.id,
      username: u.username,
      guest: u.is_guest === 1,
      coins: u.coins,
      avatar: parseAvatar(u.avatar),
      ownedHats: store.ownedHats(u),
    };
  }

  function publicWorld(w: WorldRow): Record<string, unknown> {
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      template: w.template,
      ownerId: w.owner_id,
      ownerName: w.owner_name,
      isPublic: w.is_public === 1,
      buildMode: w.build_mode,
      visits: w.visits,
      likes: w.likes,
      featured: w.featured === 1,
      online: rooms.playerCount(w.id),
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    };
  }

  function validUsername(value: unknown): string {
    if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
      throw new HttpError(400, 'invalid_username', 'Usernames are 3–20 letters, numbers or underscores.');
    }
    if (!filter.isClean(value) || /^guest_/i.test(value)) {
      throw new HttpError(400, 'username_not_allowed', 'That username isn’t allowed.');
    }
    return value;
  }

  function validPassword(value: unknown): string {
    if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
      throw new HttpError(400, 'invalid_password', 'Passwords must be at least 8 characters.');
    }
    return value;
  }

  function validTitle(value: unknown, field: string, min: number, max: number): string {
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_field', `${field} is required.`);
    const text = sanitizeText(value);
    if (text.length < min || text.length > max) {
      throw new HttpError(400, 'invalid_field', `${field} must be ${min}–${max} characters.`);
    }
    if (!filter.isClean(text)) throw new HttpError(400, 'not_allowed', `${field} contains a word that isn’t allowed.`);
    return text;
  }

  function limitAuth(ctx: Ctx): void {
    if (!authLimiter.allow(ctx.ip)) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a minute.');
  }

  function ownedWorld(ctx: Ctx, user: UserRow): WorldRow {
    const world = store.getWorld(ctx.params[0]);
    if (!world || world.owner_id !== user.id) throw new HttpError(404, 'not_found', 'World not found.');
    return world;
  }

  function visibleWorld(id: string, user: UserRow | undefined): WorldRow {
    const world = store.getWorld(id);
    if (!world || (!world.is_public && world.owner_id !== user?.id)) {
      throw new HttpError(404, 'not_found', 'World not found.');
    }
    return world;
  }

  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, pattern: string, handler: Handler): void => {
    const regex = new RegExp('^' + pattern.replace(/:[a-z]+/g, '([A-Za-z0-9_-]{1,32})') + '$');
    routes.push([method, regex, handler]);
  };

  route('GET', '/healthz', (ctx) => json(ctx, 200, { status: 'ok' }));

  route('GET', '/readyz', (ctx) => {
    let ready = !deps.isDraining();
    try {
      ready &&= store.ping();
    } catch {
      ready = false;
    }
    json(ctx, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' });
  });

  route('GET', '/metrics', (ctx) => {
    // Disabled unless a token is configured, as the numbers aren't public.
    const token = bearer(ctx.req);
    if (!config.metricsToken || !token || !safeEqual(token, config.metricsToken)) {
      throw new HttpError(401, 'unauthorized', 'Metrics token required.');
    }
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
    ctx.res.end(metrics.render());
  });

  route('POST', '/api/auth/guest', (ctx) => {
    if (!guestLimiter.allow(ctx.ip)) throw new HttpError(429, 'rate_limited', 'Too many new players from this network. Try again later.');
    let user: UserRow | undefined;
    for (let i = 0; i < 5 && !user; i++) {
      try {
        const name = `Guest_${randomBytes(3).toString('hex')}`;
        user = store.createUser(name, true, null, randomAvatar(), Date.now());
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
    }
    if (!user) throw new HttpError(503, 'try_again', 'Please try again.');
    metrics.inc('users_created_total');
    json(ctx, 201, { token: startSession(user.id), user: publicUser(user) });
  });

  route('POST', '/api/auth/register', async (ctx) => {
    limitAuth(ctx);
    const body = await readJson(ctx);
    const username = validUsername(body.username);
    const password = validPassword(body.password);
    const hash = await hashPassword(password);
    const current = optionalUser(ctx);
    try {
      if (current?.is_guest === 1) {
        store.upgradeGuest(current.id, username, hash);
        const user = store.getUser(current.id)!;
        json(ctx, 200, { token: bearer(ctx.req), user: publicUser(user) });
        return;
      }
      const user = store.createUser(username, false, hash, randomAvatar(), Date.now());
      metrics.inc('users_created_total');
      json(ctx, 201, { token: startSession(user.id), user: publicUser(user) });
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, 'username_taken', 'That username is taken.');
      throw err;
    }
  });

  route('POST', '/api/auth/login', async (ctx) => {
    limitAuth(ctx);
    const body = await readJson(ctx);
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const user = store.getUserByName(username);
    const valid = await verifyPassword(password, user?.pw_hash ?? (await dummyPasswordHash));
    if (!user || !user.pw_hash || !valid) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong username or password.');
    }
    if (user.banned_until !== null && user.banned_until > Date.now()) {
      throw new HttpError(403, 'banned', 'This account is banned.');
    }
    store.touchUser(user.id, Date.now());
    json(ctx, 200, { token: startSession(user.id), user: publicUser(user) });
  });

  route('POST', '/api/auth/logout', (ctx) => {
    const token = bearer(ctx.req);
    if (token) store.deleteSession(hashToken(token));
    json(ctx, 200, { ok: true });
  });

  route('GET', '/api/me', (ctx) => json(ctx, 200, { user: publicUser(requireUser(ctx)) }));

  route('PUT', '/api/me/avatar', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    const avatar: Avatar | null = validateAvatar(body.avatar, store.ownedHats(user));
    if (!avatar) throw new HttpError(400, 'invalid_avatar', 'That avatar isn’t valid.');
    store.setAvatar(user.id, avatar);
    json(ctx, 200, { user: publicUser(store.getUser(user.id)!) });
  });

  route('GET', '/api/shop', (ctx) => json(ctx, 200, { hats: HATS }));

  route('POST', '/api/shop/buy', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    if (typeof body.itemId !== 'string') throw new HttpError(400, 'invalid_item', 'Unknown item.');
    const result = store.buyHat(user.id, body.itemId);
    if (!result.ok) {
      const messages: Record<string, [number, string]> = {
        unknown_item: [404, 'Unknown item.'],
        already_owned: [409, 'You already own this.'],
        not_enough_coins: [402, 'Not enough coins yet.'],
        unknown_user: [401, 'Please sign in.'],
      };
      const [status, message] = messages[result.code];
      throw new HttpError(status, result.code, message);
    }
    metrics.inc('shop_purchases_total');
    json(ctx, 200, { user: publicUser(store.getUser(user.id)!) });
  });

  route('GET', '/api/worlds', (ctx) => {
    const params = ctx.url.searchParams;
    const sortParam = params.get('sort') ?? 'popular';
    const sort: WorldSort = sortParam === 'new' || sortParam === 'liked' ? sortParam : 'popular';
    const query = (params.get('q') ?? '').slice(0, 40);
    const limit = Math.min(Math.max(Number(params.get('limit')) || 24, 1), 48);
    const offset = Math.max(Number(params.get('offset')) || 0, 0);
    const worlds = store.listPublicWorlds(sort, query, limit, offset);
    json(ctx, 200, { worlds: worlds.map(publicWorld) });
  });

  route('GET', '/api/worlds/mine', (ctx) => {
    const user = requireUser(ctx);
    json(ctx, 200, { worlds: store.listOwnedWorlds(user.id).map(publicWorld) });
  });

  route('POST', '/api/worlds', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    const limit = user.is_guest ? MAX_WORLDS_GUEST : MAX_WORLDS_USER;
    if (store.countOwnedWorlds(user.id) >= limit) {
      const hint = user.is_guest ? ' Create an account to make more.' : '';
      throw new HttpError(409, 'world_limit', `You’ve reached the limit of ${limit} worlds.${hint}`);
    }
    const name = validTitle(body.name, 'Name', 3, 40);
    const description = body.description === undefined ? '' : validTitle(body.description, 'Description', 0, 280);
    const template = body.template;
    if (typeof template !== 'string' || !TEMPLATES.includes(template as TemplateId)) {
      throw new HttpError(400, 'invalid_template', 'Pick a template.');
    }
    const seed = randomBytes(4).readUInt32LE(0);
    const { world } = generateWorld(template as TemplateId, seed);
    const buildMode = body.buildMode === 'everyone' ? 'everyone' : 'owner';
    const id = store.createWorld({
      ownerId: user.id,
      name,
      description,
      template,
      seed,
      isPublic: body.isPublic !== false,
      buildMode,
      width: WORLD_W,
      height: WORLD_H,
      depth: WORLD_D,
      blocks: packWorld(world),
      thumb: renderThumbnail(world),
      now: Date.now(),
    });
    metrics.inc('worlds_created_total');
    json(ctx, 201, { world: publicWorld(store.getWorld(id)!) });
  });

  route('GET', '/api/worlds/:id', (ctx) => {
    const user = optionalUser(ctx);
    const world = visibleWorld(ctx.params[0], user);
    json(ctx, 200, {
      world: publicWorld(world),
      liked: user ? store.hasLiked(world.id, user.id) : false,
      leaderboard: store.leaderboard(world.id, 10).map((r) => ({ username: r.username, ms: r.best_ms, runs: r.count })),
    });
  });

  route('GET', '/api/worlds/:id/thumb.png', (ctx) => {
    const data = store.getWorldThumb(ctx.params[0]);
    if (!data?.thumb) throw new HttpError(404, 'not_found', 'No thumbnail.');
    const etag = `"${data.updated_at}"`;
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, { ETag: etag });
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': data.thumb.length,
      'Cache-Control': 'public, max-age=60',
      ETag: etag,
    });
    ctx.res.end(data.thumb);
  });

  route('PATCH', '/api/worlds/:id', async (ctx) => {
    const user = requireUser(ctx);
    const world = ownedWorld(ctx, user);
    const body = await readJson(ctx);
    const fields: { name?: string; description?: string; isPublic?: boolean; buildMode?: string } = {};
    if (body.name !== undefined) fields.name = validTitle(body.name, 'Name', 3, 40);
    if (body.description !== undefined) fields.description = validTitle(body.description, 'Description', 0, 280);
    if (typeof body.isPublic === 'boolean') fields.isPublic = body.isPublic;
    if (body.buildMode === 'owner' || body.buildMode === 'everyone') fields.buildMode = body.buildMode;
    store.updateWorldMeta(world.id, fields, Date.now());
    rooms.get(world.id)?.refreshMeta();
    json(ctx, 200, { world: publicWorld(store.getWorld(world.id)!) });
  });

  route('DELETE', '/api/worlds/:id', (ctx) => {
    const user = requireUser(ctx);
    const world = ownedWorld(ctx, user);
    rooms.discard(world.id, CLOSE.CLOSED, 'This world was deleted.');
    store.deleteWorld(world.id);
    metrics.inc('worlds_deleted_total');
    json(ctx, 200, { ok: true });
  });

  route('POST', '/api/worlds/:id/like', (ctx) => {
    const user = requireUser(ctx);
    const world = visibleWorld(ctx.params[0], user);
    json(ctx, 200, store.toggleLike(world.id, user.id));
  });

  route('POST', '/api/reports', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx);
    const reason = validReason(body.reason);
    const worldId = typeof body.worldId === 'string' ? body.worldId.slice(0, 32) : null;
    const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId.slice(0, 32) : null;
    if (!worldId && !targetUserId) throw new HttpError(400, 'invalid_report', 'Say who or what you’re reporting.');
    if (store.countRecentReports(user.id, Date.now() - 24 * 3600 * 1000) >= REPORTS_PER_DAY) {
      throw new HttpError(429, 'rate_limited', 'You’ve sent a lot of reports today. Thanks, we’ll review them.');
    }
    store.addReport(user.id, targetUserId, worldId, reason, Date.now());
    metrics.inc('reports_total');
    json(ctx, 201, { ok: true });
  });

  function validReason(value: unknown): string {
    if (typeof value !== 'string') throw new HttpError(400, 'invalid_report', 'A reason is required.');
    const text = sanitizeText(value);
    if (text.length < 3 || text.length > 500) {
      throw new HttpError(400, 'invalid_report', 'Reasons must be 3–500 characters.');
    }
    return text;
  }

  // --- Admin ---

  route('GET', '/api/admin/reports', (ctx) => {
    requireAdmin(ctx);
    json(ctx, 200, { reports: store.listOpenReports(100) });
  });

  route('POST', '/api/admin/reports/:id/resolve', (ctx) => {
    requireAdmin(ctx);
    const id = Number(ctx.params[0]);
    if (!Number.isInteger(id) || !store.resolveReport(id, Date.now())) throw new HttpError(404, 'not_found', 'No such open report.');
    json(ctx, 200, { ok: true });
  });

  route('POST', '/api/admin/users/:id/ban', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx);
    const days = typeof body.days === 'number' && body.days > 0 ? Math.min(body.days, 36500) : 36500;
    const reason = validReason(body.reason);
    if (!store.banUser(ctx.params[0], Date.now() + days * 86_400_000, reason)) {
      throw new HttpError(404, 'not_found', 'No such user.');
    }
    deps.gateway()?.disconnectUser(ctx.params[0], CLOSE.BANNED, 'This account was banned.');
    log.info('user banned', { user: ctx.params[0], days, reason });
    json(ctx, 200, { ok: true });
  });

  route('POST', '/api/admin/users/:id/unban', (ctx) => {
    requireAdmin(ctx);
    if (!store.unbanUser(ctx.params[0])) throw new HttpError(404, 'not_found', 'No such user.');
    json(ctx, 200, { ok: true });
  });

  route('POST', '/api/admin/worlds/:id/unpublish', (ctx) => {
    requireAdmin(ctx);
    if (!store.setWorldPublic(ctx.params[0], false)) throw new HttpError(404, 'not_found', 'No such world.');
    rooms.discard(ctx.params[0], CLOSE.CLOSED, 'This world was taken down by a moderator.');
    log.info('world unpublished', { world: ctx.params[0] });
    json(ctx, 200, { ok: true });
  });

  function serveStatic(ctx: Ctx): boolean {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
    const pathname = ctx.url.pathname === '/' ? '/index.html' : ctx.url.pathname;
    const file = staticFiles.get(pathname);
    if (!file) return false;
    const headers: Record<string, string | number> = {
      'Content-Type': file.type,
      'Cache-Control': file.cache,
      ETag: file.etag,
      Vary: 'Accept-Encoding',
    };
    if (ctx.req.headers['if-none-match'] === file.etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return true;
    }
    const accept = String(ctx.req.headers['accept-encoding'] ?? '');
    let body = file.identity;
    if (file.br && /\bbr\b/.test(accept)) {
      body = file.br;
      headers['Content-Encoding'] = 'br';
    } else if (file.gz && /\bgzip\b/.test(accept)) {
      body = file.gz;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    ctx.res.writeHead(200, headers);
    if (ctx.req.method === 'HEAD') ctx.res.end();
    else ctx.res.end(body);
    return true;
  }

  return (req, res) => {
    const start = performance.now();
    const ip = clientIp(req, config.trustProxy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.trustProxy && req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const ctx: Ctx = { req, res, params: [], url, ip };

    const fail = (err: unknown): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        json(ctx, err.status, { error: { code: err.code, message: err.message } });
        return;
      }
      metrics.inc('http_errors_total');
      log.error('request failed', { err, method: req.method, path: url.pathname });
      json(ctx, 500, { error: { code: 'internal', message: 'Something went wrong on our side.' } });
    };

    res.on('finish', () => {
      metrics.inc('http_requests_total');
      if (url.pathname.startsWith('/api/')) {
        log.debug('request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(performance.now() - start) });
      }
    });

    void (async () => {
      const isApi = url.pathname.startsWith('/api/');
      if (isApi && !apiLimiter.allow(ip)) throw new HttpError(429, 'rate_limited', 'Slow down a little.');
      let pathMatched = false;
      for (const [method, regex, handler] of routes) {
        const match = regex.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (method !== req.method) continue;
        ctx.params = match.slice(1);
        await handler(ctx);
        return;
      }
      if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      if (!isApi && serveStatic(ctx)) return;
      throw new HttpError(404, 'not_found', 'Not found.');
    })().catch(fail);
  };
}

function loadStatic(dir: string, log: Logger): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  if (!fs.existsSync(dir)) {
    log.warn('client build not found, only the API will be served', { dir });
    return files;
  }
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.br') || entry.name.endsWith('.gz')) continue;
      const ext = path.extname(entry.name);
      const type = MIME[ext];
      if (!type) continue;
      const identity = fs.readFileSync(full);
      const brPath = `${full}.br`;
      const gzPath = `${full}.gz`;
      const stat = fs.statSync(full);
      // Hashed asset names never change content, so they can be cached forever.
      const hashed = /\.[0-9A-Z]{8}\.[a-z]+$/.test(entry.name);
      const rel = '/' + path.relative(dir, full).split(path.sep).join('/');
      files.set(rel, {
        type,
        identity,
        br: fs.existsSync(brPath) ? fs.readFileSync(brPath) : undefined,
        gz: fs.existsSync(gzPath) ? fs.readFileSync(gzPath) : undefined,
        cache: hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        etag: `"${stat.size}-${Math.round(stat.mtimeMs)}"`,
      });
    }
  };
  walk(dir);
  return files;
}
