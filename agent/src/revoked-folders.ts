/**
 * The folders DPDP has revoked, as this process currently knows them.
 *
 * Why this exists at all: both planes build their registry ONCE at startup
 * from the local source list. Rewriting sources.json when a revocation
 * arrives is therefore not enough on its own — without this, a folder the
 * customer removed would keep being served until the service restarted, which
 * could be weeks. Both registries consult this set on every single lookup
 * instead, so a revocation applied mid-run takes effect on the next request.
 *
 * It only ever DENIES. There is no way to put an id back through this object,
 * so nothing here can widen what this Gateway may touch — the worst a bug can
 * do is refuse a folder that is in fact still authorized, which the
 * administrator fixes by re-approving it.
 */
export class RevokedFolders {
  private readonly ids = new Set<string>();

  /** Adds ids; never removes any. Returns how many were new. */
  add(...ids: readonly string[]): number {
    let added = 0;
    for (const id of ids) {
      if (id && !this.ids.has(id)) {
        this.ids.add(id);
        added += 1;
      }
    }
    return added;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }
}
