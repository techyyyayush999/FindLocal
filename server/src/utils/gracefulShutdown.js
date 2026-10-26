/**
 * gracefulShutdown — Builds an idempotent, bounded shutdown routine.
 *
 * On SIGINT/SIGTERM the server must:
 *   1. stop accepting new HTTP requests (server.close drains in-flight ones),
 *   2. stop the reservation expiry sweeper,
 *   3. close the HTTP server and the Mongoose connection,
 *   4. exit within a bounded grace period even if a step hangs,
 *   5. tolerate repeated signals without running cleanup twice.
 *
 * The routine is pure with respect to process state (the exit function is
 * injected), which keeps it unit-testable without real OS signals.
 *
 * Returns { shutdown, isShuttingDown }.
 */
function createGracefulShutdown({
  server,
  connection,
  sweeper,
  logger = console,
  timeoutMs = 10000,
  exit = process.exit,
} = {}) {
  let shuttingDown = false;

  // server.close() stops accepting new connections and invokes the callback only
  // once every in-flight request has finished — the desired "drain" behaviour.
  const closeServer = () =>
    new Promise((resolve, reject) => {
      if (!server || typeof server.close !== 'function' || server.listening === false) {
        return resolve();
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });

  const closeConnection = () => {
    if (!connection || typeof connection.close !== 'function') return Promise.resolve();
    return Promise.resolve(connection.close(false));
  };

  async function shutdown(signal) {
    if (shuttingDown) {
      logger.log(`[shutdown] already in progress; ignoring ${signal || 'signal'}.`);
      return { alreadyShuttingDown: true };
    }
    shuttingDown = true;

    logger.log(`[shutdown] received ${signal || 'signal'}; shutting down gracefully...`);

    // Hard ceiling: never hang forever waiting for a stuck socket or driver.
    const forceTimer = setTimeout(() => {
      logger.error(`[shutdown] grace period of ${timeoutMs}ms exceeded; forcing exit.`);
      exit(1);
    }, timeoutMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    try {
      if (sweeper && typeof sweeper.stop === 'function') sweeper.stop();
      await closeServer();
      await closeConnection();
      clearTimeout(forceTimer);
      logger.log('[shutdown] graceful shutdown complete.');
      exit(0);
      return { ok: true };
    } catch (error) {
      clearTimeout(forceTimer);
      logger.error(
        `[shutdown] error during shutdown: ${error && error.message ? error.message : error}`
      );
      exit(1);
      return { ok: false, error };
    }
  }

  return { shutdown, isShuttingDown: () => shuttingDown };
}

module.exports = { createGracefulShutdown };
