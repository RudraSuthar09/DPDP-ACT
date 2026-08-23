// Pure path-safety helpers for native Enterprise Storage — NO electron
// dependency, so they can be unit-tested with plain node (see
// storage-path-safety.test.js) and reused by enterprise-storage.js. Mirrors
// the discipline of agent/src/storage/path-safety.ts.
'use strict';

const path = require('node:path');

/** A folder/file NAME segment is safe iff it is a non-empty string with no
 *  path separators, no '.'/'..', and no NUL — so it can never mean "go
 *  somewhere else". */
function isSafeSegment(seg) {
  return (
    typeof seg === 'string' &&
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0')
  );
}

/** True iff `p` is an absolute path (POSIX `/…`, Windows `D:\…`/`D:/…`, or
 *  UNC `\\server\…`). A bare folder name is NOT absolute — the exact class of
 *  value ("Enterprise testing") that caused the original bug. */
function isAbsolutePath(p) {
  return typeof p === 'string' && /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(p);
}

/**
 * Resolve `segments` (array of name segments) to an absolute path guaranteed
 * to be contained within `root`. Throws 'PATH_NOT_ALLOWED' on any unsafe
 * segment or any resolved path that escapes the root — defence in depth on
 * top of segment validation, never trusting containment implicitly.
 */
function resolveContained(root, segments) {
  if (!Array.isArray(segments)) throw new Error('PATH_NOT_ALLOWED');
  for (const seg of segments) {
    if (!isSafeSegment(seg)) throw new Error('PATH_NOT_ALLOWED');
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error('PATH_NOT_ALLOWED');
  }
  return target;
}

module.exports = { isSafeSegment, isAbsolutePath, resolveContained };
