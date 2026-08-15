import { evaluateOrigin } from './origin';
import { inspectAuthHeader } from './auth';

describe('Phase 3B — Origin authorization is EXACT (no wildcard/substring/startsWith)', () => {
  const allow = ['https://app.example', 'https://portal.example:8443'];

  it('7. an exact allowed origin succeeds', () => {
    expect(evaluateOrigin('https://app.example', allow)).toBe('allowed');
    expect(evaluateOrigin('https://portal.example:8443', allow)).toBe('allowed');
  });

  it('8. similar-but-not-identical origins are denied', () => {
    expect(evaluateOrigin('https://app.example.evil.com', allow)).toBe('denied'); // suffix attack
    expect(evaluateOrigin('https://app.exampl', allow)).toBe('denied'); // prefix / startsWith
    expect(evaluateOrigin('https://app.exampleX', allow)).toBe('denied'); // substring
    expect(evaluateOrigin('http://app.example', allow)).toBe('denied'); // scheme differs
    expect(evaluateOrigin('https://app.example:8443', allow)).toBe('denied'); // port differs
    expect(evaluateOrigin('https://evil.example', allow)).toBe('denied');
  });

  it('a request with no Origin header is classified separately (not "allowed")', () => {
    expect(evaluateOrigin(undefined, allow)).toBe('no-origin');
  });

  it('an empty allowlist denies every presented origin', () => {
    expect(evaluateOrigin('https://app.example', [])).toBe('denied');
  });
});

describe('Phase 3B — auth-header boundary: shape only, present-if-provided', () => {
  it('absent header is a liveness call (present:false, valid:true)', () => {
    expect(inspectAuthHeader(undefined)).toEqual({ present: false, valid: true });
  });

  it('a well-formed opaque token is accepted (shape only, NOT authenticated)', () => {
    expect(inspectAuthHeader('abcDEF123456._~-token')).toEqual({ present: true, valid: true });
  });

  it('malformed tokens are rejected', () => {
    expect(inspectAuthHeader('short').valid).toBe(false); // too short
    expect(inspectAuthHeader('   ').valid).toBe(false); // whitespace only
    expect(inspectAuthHeader('has spaces in it here').valid).toBe(false); // illegal char
    expect(inspectAuthHeader('x'.repeat(5000)).valid).toBe(false); // too long
  });

  it('a duplicated header (array) is rejected', () => {
    expect(inspectAuthHeader(['a-token-value-1234', 'b-token-value-5678'])).toEqual({
      present: true,
      valid: false,
    });
  });
});
