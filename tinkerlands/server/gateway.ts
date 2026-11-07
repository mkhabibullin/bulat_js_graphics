import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE, PROTOCOL_VERSION } from '../shared/constants.ts';
import { parseClientMessage } from '../shared/protocol.ts';
import { hashToken } from './auth.ts';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { Metrics } from './metrics.ts';
import { TokenBucket } from './ratelimit.ts';
import type { RoomPlayer, Room } from './room.ts';
import type { RoomManager } from './rooms.ts';
import type { Store } from './store.ts';

const JOIN_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15_000;
const MAX_MESSAGE_BYTES = 2048;
/** Sustained rate well above the 30 Hz input stream plus chat and pings. */
const MESSAGES_PER_SECOND = 120;
const MESSAGE_BURST = 240;
const MAX_VIOLATIONS = 60;

interface ConnState {
  alive: boolean;
  player: RoomPlayer | null;
  room: Room | null;
  bucket: TokenBucket;
  violations: number;
  joining: boolean;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      // The proxy appends the address it saw, so only the last entry is trustworthy.
      const parts = forwarded.split(',');
      return parts[parts.length - 1].trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<WebSocket, ConnState>();
  private readonly ipCounts = new Map<string, number>();
  private readonly byUser = new Map<string, WebSocket>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly config: Config;
  private readonly store: Store;
  private readonly rooms: RoomManager;
  private readonly log: Logger;
  private readonly metrics: Metrics;

  constructor(server: Server, config: Config, store: Store, rooms: RoomManager, log: Logger, metrics: Metrics) {
    this.config = config;
    this.store = store;
    this.rooms = rooms;
    this.log = log;
    this.metrics = metrics;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    metrics.gauge('ws_connections', () => this.conns.size);

    server.on('upgrade', (req, socket, head) => {
      // A reset during the handshake must not surface as an uncaught exception.
      socket.on('error', () => {});
      const reject = (status: string): void => {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname !== '/ws') return reject('404 Not Found');
      if (!this.originAllowed(req)) {
        this.metrics.inc('ws_rejected_origin_total');
        return reject('403 Forbidden');
      }
      const ip = clientIp(req, config.trustProxy);
      if (this.conns.size >= config.maxConnections || (this.ipCounts.get(ip) ?? 0) >= config.maxConnectionsPerIp) {
        this.metrics.inc('ws_rejected_limit_total');
        return reject('503 Service Unavailable');
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
    });

    this.heartbeat = setInterval(() => {
      for (const [ws, conn] of this.conns) {
        if (!conn.alive) {
          ws.terminate();
          continue;
        }
        conn.alive = false;
        ws.ping();
      }
    }, HEARTBEAT_MS);
  }

  /**
   * Browsers always send Origin, so this blocks other sites from opening a
   * socket on a visitor's behalf. Non-browser clients are handled by auth.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const conn: ConnState = {
      alive: true,
      player: null,
      room: null,
      bucket: new TokenBucket(MESSAGES_PER_SECOND, MESSAGE_BURST),
      violations: 0,
      joining: false,
    };
    this.conns.set(ws, conn);
    this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
    this.metrics.inc('ws_connections_total');

    const joinTimer = setTimeout(() => {
      if (!conn.player) ws.close(CLOSE.AUTH, 'Join timed out');
    }, JOIN_TIMEOUT_MS);

    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      // Once we've started closing (kick, ban), nothing more from this client counts.
      if (ws.readyState !== WebSocket.OPEN) return;
      if (isBinary) return this.violation(ws, conn);
      if (!conn.bucket.take()) {
        this.metrics.inc('ws_messages_dropped_total');
        return this.violation(ws, conn);
      }
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        this.metrics.inc('ws_messages_invalid_total');
        return this.violation(ws, conn);
      }
      try {
        if (msg.t === 'join') {
          if (!conn.player && !conn.joining) this.handleJoin(ws, conn, msg.token, msg.worldId, msg.v);
        } else if (conn.player && conn.room) {
          conn.room.handleMessage(conn.player, msg);
        }
      } catch (err) {
        this.metrics.inc('ws_handler_errors_total');
        this.log.error('message handler failed', { err, type: msg.t });
      }
    });
    ws.on('error', (err) => {
      this.log.debug('socket error', { err });
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      this.conns.delete(ws);
      const left = (this.ipCounts.get(ip) ?? 1) - 1;
      if (left <= 0) this.ipCounts.delete(ip);
      else this.ipCounts.set(ip, left);
      if (conn.player) {
        if (this.byUser.get(conn.player.user.id) === ws) this.byUser.delete(conn.player.user.id);
        try {
          conn.room?.removePlayer(conn.player);
        } catch (err) {
          this.log.error('failed to remove player', { err });
        }
      }
    });
  }

  private violation(ws: WebSocket, conn: ConnState): void {
    conn.violations++;
    if (conn.violations >= MAX_VIOLATIONS) {
      this.metrics.inc('ws_closed_abuse_total');
      ws.close(CLOSE.ABUSE, 'Too many invalid messages');
    }
  }

  private handleJoin(ws: WebSocket, conn: ConnState, token: string, worldId: string, version: number): void {
    conn.joining = true;
    const fail = (code: number, reason: string): void => {
      conn.joining = false;
      ws.close(code, reason);
    };
    if (version !== PROTOCOL_VERSION) return fail(CLOSE.PROTOCOL, 'Please refresh to get the latest version.');
    const now = Date.now();
    const user = this.store.getSessionUser(hashToken(token), now);
    if (!user) return fail(CLOSE.AUTH, 'Your session has expired. Please sign in again.');
    if (user.banned_until !== null && user.banned_until > now) return fail(CLOSE.BANNED, 'This account is banned.');
    const room = this.rooms.getOrLoad(worldId);
    if (!room) return fail(CLOSE.NOT_FOUND, 'This world no longer exists.');
    if (!room.meta.is_public && room.meta.owner_id !== user.id) return fail(CLOSE.NOT_FOUND, 'This world is private.');
    if (this.store.isBannedFromWorld(worldId, user.id)) return fail(CLOSE.KICKED, 'You were removed from this world.');

    // One live session per account, so a player can't appear twice.
    const previous = this.byUser.get(user.id);
    if (previous && previous !== ws) {
      const prevConn = this.conns.get(previous);
      if (prevConn?.player && prevConn.room) {
        prevConn.room.removePlayer(prevConn.player);
        prevConn.player = null;
      }
      previous.close(CLOSE.SUPERSEDED, 'Signed in from another tab or device.');
    }

    if (room.isFull) return fail(CLOSE.FULL, 'This world is full. Try again in a moment.');

    this.store.touchUser(user.id, now);
    conn.room = room;
    conn.player = room.addPlayer(ws, user);
    conn.joining = false;
    this.byUser.set(user.id, ws);
  }

  /** Disconnects a user everywhere, e.g. after a ban. */
  disconnectUser(userId: string, code: number, reason: string): void {
    const ws = this.byUser.get(userId);
    if (ws) ws.close(code, reason);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const ws of this.conns.keys()) ws.terminate();
    this.wss.close();
  }
}
