import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles, AllowReadOnly } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentProofService } from './consent-proof.service';
import { parseSubjectHistoryQuery, parseSubjectRefParam } from './dto';

/**
 * FR-CON-08 — proof-of-consent export. POST, not GET, even though it changes
 * nothing — same reasoning as RopaController's export, word for word: the
 * audit interceptor only records non-safe HTTP methods (Stage 1 does not yet
 * audit reads), so a GET here would carry an @Audited decorator that silently
 * never fires. Generating a regulator-facing certificate is exactly the
 * compliance-significant act R3's audit trail exists to catch. @AllowReadOnly
 * is required alongside @Roles because 'auditor' is a read-only role and
 * generating a certificate is the documented exception that decorator exists
 * for.
 */
@Controller('consent')
@UseGuards(TenantGuard)
export class ConsentProofController {
  constructor(private readonly proof: ConsentProofService) {}

  @Post('subjects/:subjectRef/purposes/:purposeId/proof-of-consent')
  @Roles('owner', 'dpo', 'compliance_officer', 'auditor')
  @AllowReadOnly()
  @Audited('consent.proof_of_consent.generated')
  @HttpCode(HttpStatus.OK)
  async generate(
    @Param('subjectRef') subjectRef: string,
    @Param('purposeId', ParseUUIDPipe) purposeId: string,
    @Query('asOf') asOf?: string,
    @Query('knownAs') knownAs?: string,
  ): Promise<StreamableFile> {
    const ref = parseSubjectRefParam(subjectRef);
    const query = parseSubjectHistoryQuery({ asOf, knownAs });
    const { buffer, filename } = await this.proof.generate(ref, purposeId, query);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
