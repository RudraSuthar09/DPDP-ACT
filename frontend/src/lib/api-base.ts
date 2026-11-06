/**
 * Just the two backend addresses, with no browser (DOM) dependency of any
 * kind — so the server-only public-page helpers, and the unit tests that
 * load them in Node, can take them without pulling in api.ts's token and
 * file-download machinery. api.ts re-exports both, so every existing
 * importer is unaffected and there is still one definition of each.
 */

/** The address the BROWSER uses. Baked in at build time; deliberately a
 *  host-reachable address (e.g. http://localhost:3001), never an in-Docker
 *  service name. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * The address a Next.js SERVER COMPONENT (SSR, running inside this
 * container) must use to reach the backend. Inside a container, "localhost"
 * means the container itself, not the backend's — the SSR-side public pages
 * (form-portal-api.ts's formPortalFetchServer, portal-api.ts's
 * portalFetchServer) need a container-network-reachable address. Falls back
 * to API_URL for local (non-Docker) `pnpm dev`, where both resolve to the
 * same host anyway. Read at request time (not build time) — a plain server
 * env var, never NEXT_PUBLIC_-prefixed.
 */
export const SERVER_API_URL = process.env.INTERNAL_API_URL ?? API_URL;
