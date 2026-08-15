import { BadRequestException } from '@nestjs/common';
import { parseSetEndpoint } from './gateway.dto';

/**
 * Phase 3G-2.5 — the Gateway ENDPOINT is a plain, non-secret URL the client
 * explicitly configures. This spec proves it is validated as a real http(s)
 * URL, that credential-embedding (userinfo) is refused, and that the DTO still
 * rejects any of the module's forbidden secret fields (shared discipline).
 */
describe('Phase 3G-2.5 — parseSetEndpoint: a plain http(s) URL, never a credential', () => {
  it('accepts http/https URLs, including with a port and a hostname', () => {
    for (const endpoint of [
      'http://192.168.1.50:7071',
      'http://localhost:7071',
      'https://gateway.client-domain.example',
      'http://client-gateway.local:7071',
    ]) {
      expect(parseSetEndpoint({ endpoint })).toEqual({ endpoint });
    }
  });

  it('trims whitespace', () => {
    expect(parseSetEndpoint({ endpoint: '  http://192.168.1.50:7071  ' })).toEqual({
      endpoint: 'http://192.168.1.50:7071',
    });
  });

  it('null or empty clears the configuration', () => {
    expect(parseSetEndpoint({ endpoint: null })).toEqual({ endpoint: null });
    expect(parseSetEndpoint({ endpoint: '' })).toEqual({ endpoint: null });
    expect(parseSetEndpoint({ endpoint: '   ' })).toEqual({ endpoint: null });
  });

  it('rejects a non-URL string', () => {
    for (const bad of ['not a url', '192.168.1.50', 'gateway']) {
      expect(() => parseSetEndpoint({ endpoint: bad })).toThrow(BadRequestException);
    }
  });

  it('rejects a non-http(s) scheme', () => {
    for (const bad of ['ftp://192.168.1.50', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() => parseSetEndpoint({ endpoint: bad })).toThrow(BadRequestException);
    }
  });

  it('rejects a URL with embedded credentials (userinfo) — never smuggle a password here', () => {
    expect(() => parseSetEndpoint({ endpoint: 'http://user:pass@192.168.1.50:7071' })).toThrow(BadRequestException);
  });

  it('rejects the shared forbidden-secret-field list on this endpoint too', () => {
    for (const field of ['password', 'privateKey', 'token', 'secret']) {
      expect(() => parseSetEndpoint({ endpoint: 'http://192.168.1.50:7071', [field]: 'x' })).toThrow(
        BadRequestException,
      );
    }
  });

  it('rejects a non-string, non-null endpoint', () => {
    expect(() => parseSetEndpoint({ endpoint: 123 })).toThrow(BadRequestException);
  });
});
