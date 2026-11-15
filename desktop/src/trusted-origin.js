// The ONE origin the desktop shell trusts. No Electron dependency (same
// convention as storage-path-safety.js), so it is unit-tested directly in
// trusted-origin.test.js.
//
// The main window loads the hosted DPDP frontend from this origin. Main-window
// navigation is restricted to it (main.js), and every native IPC handler
// (enterprise-storage.js, dialog-bridge.js) refuses a caller that is not the
// top-level frame of a page on exactly this origin. Comparison is by parsed
// origin, never by string prefix: "https://app.hhgoa.work.example.com" and
// "https://app.hhgoa.work@example.com" must not match.
'use strict';

const TRUSTED_ORIGIN = 'https://app.hhgoa.work';

/** True only when `url` parses and its origin is exactly TRUSTED_ORIGIN. */
function isTrustedUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  try {
    return new URL(url).origin === TRUSTED_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * True only when an IPC event comes from the top-level frame of a page on
 * TRUSTED_ORIGIN. `event.senderFrame` is Electron's WebFrameMain for the frame
 * that sent the message (null if it has already gone away); `parent === null`
 * means it is the top-level frame, not an iframe inside the page.
 */
function isTrustedSender(event) {
  const frame = event && event.senderFrame;
  if (!frame) return false;
  if (frame.parent !== null) return false;
  return isTrustedUrl(frame.url);
}

module.exports = { TRUSTED_ORIGIN, isTrustedUrl, isTrustedSender };
