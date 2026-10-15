import { createLogger, redactSecrets, LOG_LEVELS } from './logger';

describe('logger — leveled, structured, secret-redacting (Phase 1)', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('LOG_LEVELS is ordered debug < info < warn < error', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('filters lines below the configured minimum level', () => {
    const logger = createLogger('warn');
    logger.debug('debug line');
    logger.info('info line');
    logger.warn('warn line');
    logger.error('error line');
    expect(logSpy).not.toHaveBeenCalled(); // debug/info suppressed, and warn/error go to console.error
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('info-level logger still emits info/warn/error but not debug', () => {
    const logger = createLogger('info');
    logger.debug('debug line');
    logger.info('info line');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('info line');
  });

  it('warn/error go to console.error, debug/info go to console.log', () => {
    const logger = createLogger('debug');
    logger.info('to stdout');
    logger.warn('to stderr');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('child() prefixes the scope without affecting the parent', () => {
    const logger = createLogger('debug');
    const child = logger.child('heartbeat');
    child.info('tick');
    expect(logSpy.mock.calls[0][0]).toContain('[heartbeat]');
  });

  it('redactSecrets masks known sensitive key=value / "key":"value" shapes', () => {
    expect(redactSecrets('deviceToken=abc.def.ghi')).toBe('deviceToken=[REDACTED]');
    expect(redactSecrets('"enrollmentCode":"SECRET123"')).toBe('"enrollmentCode=[REDACTED]"');
    expect(redactSecrets('password=hunter2 and more')).toBe('password=[REDACTED] and more');
    expect(redactSecrets('x-gateway-device-token: abc123')).toContain('[REDACTED]');
  });

  it('(Phase 4) redacts proxy/URL user info and Authorization / Proxy-Authorization values', () => {
    const out = redactSecrets('HTTPS_PROXY=http://svc:Pr0xy-PW@proxy.corp:8080 failed; https://u@h.example/x');
    expect(out).not.toContain('Pr0xy-PW');
    expect(out).not.toContain('svc:');
    expect(out).toContain('http://[REDACTED]@proxy.corp:8080');
    expect(out).toContain('https://[REDACTED]@h.example/x');
    expect(redactSecrets('proxy-authorization: Basic c3ZjOnB3')).not.toContain('c3ZjOnB3');
    expect(redactSecrets('{"Proxy-Authorization":"Basic c3ZjOnB3"}')).not.toContain('c3ZjOnB3');
    expect(redactSecrets('Authorization: Bearer eyJabc.def.ghi')).not.toContain('eyJabc');
  });

  it('redactSecrets leaves ordinary, non-sensitive text untouched', () => {
    const line = 'Gateway heartbeat failed (will retry): connect ECONNREFUSED 127.0.0.1:3001';
    expect(redactSecrets(line)).toBe(line);
  });

  it('every emitted line is redacted automatically', () => {
    const logger = createLogger('debug');
    logger.info('deviceToken=super-secret-value should never appear raw');
    const emitted = logSpy.mock.calls[0][0] as string;
    expect(emitted).not.toContain('super-secret-value');
    expect(emitted).toContain('[REDACTED]');
  });
});
