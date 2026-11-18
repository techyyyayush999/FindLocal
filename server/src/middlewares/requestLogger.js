const crypto = require('crypto');
const logger = require('../utils/logger');

// Observational request logger: assigns a server-generated request id, then logs
// one structured `http_request` line when the response finishes. It records only
// explicitly selected fields — never bodies, headers, cookies, tokens, IP
// addresses or query strings — and always calls next(), so responses are
// byte-for-byte unchanged.
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  // Server-generated id only. Any client-supplied id (e.g. an X-Request-Id
  // header) is deliberately ignored so the identifier cannot be spoofed.
  req.id = crypto.randomUUID();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    logger.info('http_request', {
      requestId: req.id,
      method: req.method,
      path: (req.originalUrl || '').split('?')[0], // path only — query string dropped
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
    });
  });

  next();
}

module.exports = requestLogger;
