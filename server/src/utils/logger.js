// ─── Structured logger ─────────────────────────────────────────────────────────
// Dependency-free JSON logger that writes one JSON object per line to stdout
// (info/warn/log) or stderr (error).
//
// Safety properties:
//   • Only the fields explicitly handed to a call are serialised. The logger
//     never walks request objects, headers, cookies, bodies or environment
//     values, so passwords, JWTs, cookies and secrets cannot leak through it.
//   • Serialisation is guarded: a value JSON.stringify cannot handle (a circular
//     reference, a BigInt, a throwing getter) degrades to a safe fallback line
//     instead of throwing inside a request or error path.
//   • `log` mirrors `info` so this object is a drop-in for the console-style
//     `logger.log(...)` consumers (graceful shutdown, expiry sweeper).
function emit(level, message, fields) {
  const entry = { ts: new Date().toISOString(), level, msg: message };

  // Copy only the explicitly supplied fields — never spread a whole object
  // (request, error, headers) into the payload.
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) {
      entry[key] = fields[key];
    }
  }

  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Circular reference / BigInt / throwing getter: emit a minimal safe line.
    line = `{"ts":"${entry.ts}","level":"${level}","msg":"log serialization failed"}`;
  }

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  error: (message, fields) => emit('error', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  info: (message, fields) => emit('info', message, fields),
  log: (message, fields) => emit('info', message, fields),
};
