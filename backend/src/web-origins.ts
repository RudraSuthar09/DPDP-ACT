/**
 * The dashboard (Next.js frontend) origins, from WEB_ORIGIN (comma-separated,
 * exact scheme://host[:port]). ONE definition, used by:
 *   - main.ts, for the API's own CORS policy;
 *   - the Gateway heartbeat (gateway.service.ts), which tells the enrolled
 *     Gateway which dashboard origins may call its local listener -- so the
 *     two lists can never drift apart, and no Gateway needs a hand-edited
 *     allowedOrigins entry.
 */
export function webOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
