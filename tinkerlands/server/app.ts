import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.ts';
import { Gateway } from './gateway.ts';
import { createHttpHandler } from './http.ts';
import { createLogger, type Logger } from './logger.ts';
import { Metrics } from './metrics.ts';
import { TextFilter } from './moderation.ts';
import { RoomManager } from './rooms.ts';
import { seedStarterWorlds } from './seed.ts';
import { Store } from './store.ts';

const GUEST_MAX_IDLE_MS = 30 * 24 * 3600 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 3600 * 1000;

export interface App {
  port: number;
  store: Store;
  rooms: RoomManager;
  metrics: Metrics;
  log: Logger;
  /** Saves all worlds, disconnects clients and closes the database. */
  stop(): Promise<void>;
}

export async function startApp(config: Config): Promise<App> {
  const log = createLogger(config.logLevel);
  const metrics = new Metrics();
  const store = new Store(config.dbPath);
  const filter = new TextFilter(config.extraBlockedWords);
  const rooms = new RoomManager({ store, log, metrics, filter }, config.saveIntervalMs, config.roomIdleMs);

  const seeded = seedStarterWorlds(store, Date.now());
  if (seeded > 0) log.info('created starter worlds', { count: seeded });

  let gateway: Gateway | null = null;
  let draining = false;

  const server = http.createServer(
    createHttpHandler({
      config,
      store,
      rooms,
      log,
      metrics,
      filter,
      gateway: () => gateway,
      isDraining: () => draining,
    }),
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 64;
  gateway = new Gateway(server, config, store, rooms, log, metrics);

  const runCleanup = (): void => {
    try {
      const result = store.cleanup(Date.now(), GUEST_MAX_IDLE_MS);
      log.info('cleanup finished', result);
    } catch (err) {
      log.error('cleanup failed', { err });
    }
  };
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  rooms.start();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  log.info('server listening', { host: config.host, port, env: config.env });

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      draining = true;
      clearInterval(cleanupTimer);
      // 1012 "service restart" tells clients to reconnect shortly.
      rooms.shutdown(1012, 'Server restarting');
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        gateway?.close();
        setTimeout(() => {
          server.closeAllConnections();
        }, 3000).unref();
      });
      store.close();
      log.info('server stopped');
    })();
    return stopping;
  };

  return { port, store, rooms, metrics, log, stop };
}
