import { startApp } from './app.ts';
import { loadConfig } from './config.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

try {
  const app = await startApp(loadConfig());

  const shutdown = (signal: string, exitCode: number): void => {
    app.log.info('shutting down', { signal });
    setTimeout(() => {
      app.log.error('shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    app.stop().then(
      () => process.exit(exitCode),
      (err: unknown) => {
        app.log.error('shutdown failed', { err });
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  // State may be inconsistent after these, so save what we can and restart clean.
  process.on('uncaughtException', (err) => {
    app.log.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    app.log.error('unhandled rejection', { err });
    shutdown('unhandledRejection', 1);
  });
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'failed to start', err: String(err) }));
  process.exit(1);
}
