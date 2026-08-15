import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE PERSISTENT SAAS LOCAL SOURCE BOUNDARY GUARD.
 *
 * This feature lets a browser remember a FileSystemFileHandle for a Data
 * Source across visits, entirely client-side. It must hold to the exact same
 * discipline as the Phase-2 raw-data viewer it extends (see
 * frontend-raw-data-boundary.spec.ts): no file bytes, rows, or filesystem
 * paths ever reach the backend, no new backend endpoint is introduced, and the
 * handle lives ONLY in this browser's IndexedDB — never localStorage/
 * sessionStorage, never mixed into the raw-data files' own text (which a
 * separate guard forbids from mentioning IndexedDB at all, since THIS file is
 * meant to be the one and only place that talks to it).
 *
 * (This runs in the backend jest suite because that is the project's test
 * runner; it only reads the frontend source files, it does not import them.)
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const HANDLES_LIB = join(REPO_ROOT, 'frontend', 'src', 'lib', 'local-source-handles.ts');
const VIEWER = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'data-sources', '[id]', 'viewer', 'page.tsx');
const SOURCES_PAGE = join(REPO_ROOT, 'frontend', 'src', 'app', '(app)', 'data-sources', 'page.tsx');
const AMBIENT_TYPES = join(REPO_ROOT, 'frontend', 'src', 'types', 'file-system-access.d.ts');

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('Persistent SaaS local source — the handle stays in the browser, never the backend', () => {
  it('checks real files (not vacuous)', () => {
    for (const f of [HANDLES_LIB, VIEWER, SOURCES_PAGE, AMBIENT_TYPES]) {
      expect(() => readFileSync(f, 'utf8')).not.toThrow();
    }
  });

  it('local-source-handles.ts makes NO network call at all (pure browser-local IndexedDB)', () => {
    const code = codeOnly(readFileSync(HANDLES_LIB, 'utf8'));
    for (const net of ['fetch(', 'apiFetch', 'XMLHttpRequest', 'WebSocket', 'axios', 'sendBeacon']) {
      expect(code.includes(net)).toBe(false);
    }
  });

  it('local-source-handles.ts never reads file bytes/content — only the handle + a display name', () => {
    const code = codeOnly(readFileSync(HANDLES_LIB, 'utf8'));
    for (const forbidden of ['.arrayBuffer(', '.text(', 'readAsText', 'readAsArrayBuffer', 'FileReader', '.getFile()']) {
      expect(code.includes(forbidden)).toBe(false);
    }
  });

  it('local-source-handles.ts uses IndexedDB, never localStorage/sessionStorage, for the handle', () => {
    const code = codeOnly(readFileSync(HANDLES_LIB, 'utf8'));
    expect(code).toContain('indexedDB');
    for (const forbidden of ['localStorage', 'sessionStorage']) {
      expect(code.includes(forbidden)).toBe(false);
    }
  });

  it('no filesystem-path pattern is ever constructed, stored, or logged', () => {
    for (const f of [HANDLES_LIB, VIEWER, SOURCES_PAGE]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const pathPattern of ['C:\\\\', 'file://', '/home/', '/Users/', '.path', 'fullPath', 'webkitRelativePath']) {
        expect({ f, pathPattern, hit: code.includes(pathPattern) }).toEqual({ f, pathPattern, hit: false });
      }
    }
  });

  it('the viewer and Data Sources files themselves never reference indexedDB/localStorage/sessionStorage directly — only via the dedicated lib', () => {
    for (const f of [VIEWER, SOURCES_PAGE]) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const forbidden of ['indexedDB', 'localStorage', 'sessionStorage']) {
        expect({ f, forbidden, hit: code.includes(forbidden) }).toEqual({ f, forbidden, hit: false });
      }
    }
  });

  it("the viewer's only backend (apiFetch) calls remain the existing source-load and raw-access audit — no new endpoint", () => {
    const code = codeOnly(readFileSync(VIEWER, 'utf8'));
    const calls = Array.from(code.matchAll(/apiFetch(?:<[^>]*>)?\(\s*`([^`]*)`/g)).map((m) => m[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const isSourceLoad = /^\/data-sources\/\$\{id\}$/.test(call);
      const isRawAccess = /^\/data-sources\/\$\{id\}\/raw-access$/.test(call);
      expect({ call, ok: isSourceLoad || isRawAccess }).toEqual({ call, ok: true });
    }
  });

  it('requestPermission() is only ever called from an explicit click handler, never on mount/effect', () => {
    const code = codeOnly(readFileSync(VIEWER, 'utf8'));
    // requestHandlePermission must be called exactly once in this file, and
    // its only caller must be the reconnect click handler — never the mount
    // effect that looks up a saved handle (which uses queryHandlePermission,
    // a read-only check that cannot itself trigger a browser permission UI).
    const occurrences = code.split('requestHandlePermission(').length - 1;
    expect(occurrences).toBe(1);
    const at = code.indexOf('requestHandlePermission(');
    const before = code.slice(Math.max(0, at - 400), at);
    expect(before).toContain('async function onReconnectClick');
    expect(code).toContain('queryHandlePermission');
  });

  it('Data Sources: the per-row local status is never sent to or read from the backend as a field', () => {
    const code = codeOnly(readFileSync(SOURCES_PAGE, 'utf8'));
    // The status must be computed from getHandle/queryHandlePermission, not a
    // DataSource field like s.localStatus / s.connectionStatus.
    for (const forbidden of ['localStatus', 'connectionStatus', 'handleStatus']) {
      expect(code.includes(forbidden)).toBe(false);
    }
    expect(code).toContain('getHandle');
    expect(code).toContain('queryHandlePermission');
  });

  it('removing a Data Source cleans up its local handle best-effort, without blocking the delete', () => {
    const code = codeOnly(readFileSync(SOURCES_PAGE, 'utf8'));
    const delAt = code.indexOf("method: 'DELETE'");
    expect(delAt).toBeGreaterThan(-1);
    const removeAt = code.indexOf('removeHandle(');
    expect(removeAt).toBeGreaterThan(delAt);
    // The removeHandle call must be wrapped in its own try/catch so a failure
    // there can never surface as (or block) a deletion failure.
    const between = code.slice(delAt, removeAt);
    expect(between).toContain('try {');
  });
});
