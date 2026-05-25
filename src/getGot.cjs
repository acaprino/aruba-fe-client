// src/getGot.cjs
// got@14 is ESM-only; CJS callers load it via dynamic import once and cache.
// Cold-start adds ~50-150ms on the first invocation per process.
//
// On rejection the cached promise is cleared so a transient ENOENT or partial
// install does not poison the process for its lifetime.

let _gotPromise = null;

async function getGot() {
  if (!_gotPromise) {
    _gotPromise = import('got').then(
      (mod) => mod.default,
      (err) => { _gotPromise = null; throw err; },
    );
  }
  return _gotPromise;
}

module.exports = { getGot };
