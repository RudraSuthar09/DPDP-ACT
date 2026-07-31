/** Where a requester's portal token lives after OTP verification: this tab's
 *  `sessionStorage` only, keyed per ticket. Never `localStorage` (it must not
 *  outlive the tab on a shared machine) and never a URL (see request-portal
 *  controller's comment on why a reference code alone must not be a bearer). */
export function portalTokenKey(ticketId: string): string {
  return `dpdp.portal.token.${ticketId}`;
}
