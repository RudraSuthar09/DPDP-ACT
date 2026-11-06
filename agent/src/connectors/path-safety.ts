import { realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { GatewayErrorCode } from '@dpdp/shared';

/**
 * Filesystem containment — the Phase-3A resolver contract, enforced.
 *
 * The browser NEVER sends a path; it sends an opaque handle that the Gateway
 * resolved from its own discovery within configured roots. This module is the
 * final backstop: before ANY file is opened, its path is canonicalised, its
 * symlinks/junctions resolved (realpath), and it is verified to be a strict
 * descendant of an allowed root with an approved extension. A '..', an absolute
 * path outside the roots, or a symlink escaping a root all fail closed here.
 */

export const ALLOWED_EXTENSIONS = new Set(['.csv', '.xlsx']);

export class PathSecurityError extends Error {
  constructor(public readonly code: GatewayErrorCode) {
    super(code);
    this.name = 'PathSecurityError';
  }
}

/** Canonicalise a root once (realpath if it exists, else a plain resolve). */
function canonicalRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}

/**
 * Resolve `candidate` (an absolute path the Gateway built, never browser input)
 * and assert it is inside one of `allowedRoots` with an approved extension.
 * Returns the canonical real path, or throws PathSecurityError. Symlinks are
 * resolved BEFORE the containment check, so a link inside a root that points
 * outside it is rejected, not followed.
 */
export function resolveWithinRoots(candidate: string, allowedRoots: readonly string[]): string {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    throw new PathSecurityError('FILE_NOT_FOUND');
  }
  const roots = allowedRoots.map(canonicalRoot);
  const contained = roots.some((root) => real === root || real.startsWith(root + sep));
  if (!contained) throw new PathSecurityError('PATH_NOT_ALLOWED');
  if (!ALLOWED_EXTENSIONS.has(extname(real).toLowerCase())) {
    throw new PathSecurityError('UNSUPPORTED_SOURCE');
  }
  return real;
}

/**
 * Folder counterpart of resolveWithinRoots (file picker): the canonical real
 * path of a DIRECTORY inside one of `allowedRoots`, with no extension rule.
 * Same symlink-before-containment discipline. `candidate` is always a path
 * the Gateway built itself from its own handle map, never browser input.
 */
export function resolveDirWithinRoots(candidate: string, allowedRoots: readonly string[]): string {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    throw new PathSecurityError('FILE_NOT_FOUND');
  }
  const roots = allowedRoots.map(canonicalRoot);
  if (!roots.some((root) => real === root || real.startsWith(root + sep))) throw new PathSecurityError('PATH_NOT_ALLOWED');
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new PathSecurityError('FILE_NOT_FOUND');
  return real;
}

/** True if a directory entry name is an approved data file (used in discovery). */
export function isApprovedFile(name: string): boolean {
  return ALLOWED_EXTENSIONS.has(extname(name).toLowerCase());
}
