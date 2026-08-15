import { BadRequestException } from '@nestjs/common';
import { parseGatewayEvent } from './data-source.dto';

/**
 * Phase 3G-2 — the central Gateway-event recorder DTO. This is the ONLY thing
 * the central backend ever receives about a customer resolve/write/create or
 * column-create operation: a POST-HOC, metadata-only fact. This spec proves
 * the allowlist is strict (no arbitrary action string) and that anything
 * value-shaped is refused outright, so the central platform structurally
 * cannot receive a customer value through this endpoint.
 */
describe('Phase 3G-2 — parseGatewayEvent: metadata-only, strict action allowlist', () => {
  it('accepts each of the five allowlisted actions', () => {
    for (const action of [
      'gateway.customer.resolved',
      'gateway.customer.updated',
      'gateway.customer.created',
      'gateway.customer.write_failed',
      'gateway.column.created',
    ]) {
      expect(parseGatewayEvent({ action })).toEqual({ action, rowCount: undefined });
    }
  });

  it('accepts an optional non-negative integer rowCount', () => {
    expect(parseGatewayEvent({ action: 'gateway.customer.resolved', rowCount: 1 })).toEqual({
      action: 'gateway.customer.resolved',
      rowCount: 1,
    });
  });

  it('rejects an action outside the fixed allowlist — no arbitrary audit action string', () => {
    for (const bad of ['gateway.session.created', 'gateway.raw_access.viewed', 'gateway.customer.deleted', 'anything', '']) {
      expect(() => parseGatewayEvent({ action: bad })).toThrow(BadRequestException);
    }
  });

  it('rejects a negative or non-integer rowCount', () => {
    for (const bad of [-1, 1.5, 'five' as unknown as number]) {
      expect(() => parseGatewayEvent({ action: 'gateway.customer.resolved', rowCount: bad })).toThrow(BadRequestException);
    }
  });

  it('rejects any field that looks like an identity value, a field value, or a customer reference', () => {
    for (const forbidden of ['identityValue', 'fields', 'customerRef', 'value', 'values', 'row', 'rows', 'columnValue']) {
      expect(() => parseGatewayEvent({ action: 'gateway.customer.resolved', [forbidden]: 'anything' })).toThrow(
        BadRequestException,
      );
    }
  });

  it('rejects a body with no action at all', () => {
    expect(() => parseGatewayEvent({ rowCount: 1 })).toThrow(BadRequestException);
  });
});
