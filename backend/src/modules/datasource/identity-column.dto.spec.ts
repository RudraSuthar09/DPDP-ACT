import { BadRequestException } from '@nestjs/common';
import { parseIdentityColumn } from './data-source.dto';

/**
 * Phase 3G-1 — the customer-identity column configuration. This is a pure
 * request-shape validator: it records a client-chosen COLUMN NAME (never a
 * value) and performs NO lookup. Nothing here assumes email/mobile — any
 * plausible column identifier is accepted, and none is applied by default.
 */
describe('Phase 3G-1 — parseIdentityColumn: explicit column choice only', () => {
  it('accepts an explicitly chosen column — not assumed to be email/mobile', () => {
    expect(parseIdentityColumn({ identityColumn: 'customer_id' })).toEqual({ identityColumn: 'customer_id' });
    expect(parseIdentityColumn({ identityColumn: 'email' })).toEqual({ identityColumn: 'email' });
    expect(parseIdentityColumn({ identityColumn: 'mobile_number' })).toEqual({ identityColumn: 'mobile_number' });
  });

  it('null clears the configuration (no identity column configured)', () => {
    expect(parseIdentityColumn({ identityColumn: null })).toEqual({ identityColumn: null });
  });

  it('rejects a non-identifier string (never used to construct SQL)', () => {
    for (const evil of ['email; DROP TABLE customers;--', "' OR 1=1 --", 'has space', '1starts_with_digit']) {
      expect(() => parseIdentityColumn({ identityColumn: evil })).toThrow(BadRequestException);
    }
  });

  it('rejects a non-string, non-null value', () => {
    expect(() => parseIdentityColumn({ identityColumn: 123 })).toThrow(BadRequestException);
  });
});
