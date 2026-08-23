// Pure Central DPDP Storage filesystem operations — NO electron dependency, so
// they can be unit-tested with plain node (storage-fs-ops.test.js) and reused
// by enterprise-storage.js's IPC handlers. Every op is contained under the
// caller-supplied absolute `rootPath` via resolveContained; filenames/segments
// are validated with isSafeSegment. Behaviour is identical to what the IPC
// handlers did inline before this extraction — this is the write mechanism the
// Electron consent-form local-storage path relies on.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { isSafeSegment, resolveContained } = require('./storage-path-safety');

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Direct subfolder names under root/segments (dirs only, no dotfiles, sorted).
 *  Returns [] if the folder doesn't exist yet. */
async function browseDir(rootPath, segments) {
  const dir = resolveContained(rootPath, segments ?? []);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

/** Create root/segments/name (idempotent — mkdir recursive). */
async function createFolder(rootPath, segments, name) {
  if (!isSafeSegment(name)) throw new Error('PATH_NOT_ALLOWED');
  await ensureDir(resolveContained(rootPath, [...(segments ?? []), name]));
}

/** Write a plain-text file (e.g. a field's value.txt) — never JSON-wrapped. */
async function writeText(rootPath, segments, filename, text) {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  const dir = resolveContained(rootPath, segments ?? []);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, filename), typeof text === 'string' ? text : String(text), 'utf8');
}

/** Write a pretty-printed JSON file (profile.json / retention.json). */
async function writeJson(rootPath, segments, filename, data) {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  const dir = resolveContained(rootPath, segments ?? []);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
}

/** Write raw bytes (a PDF/Excel upload) from base64 — original bytes preserved. */
async function writeFileBase64(rootPath, segments, filename, base64) {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  if (typeof base64 !== 'string') throw new Error('BAD_REQUEST');
  const dir = resolveContained(rootPath, segments ?? []);
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, filename), Buffer.from(base64, 'base64'));
}

module.exports = { ensureDir, browseDir, createFolder, writeText, writeJson, writeFileBase64 };
