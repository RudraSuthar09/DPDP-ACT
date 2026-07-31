import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowReadOnly, Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { parseLadder } from '../request/request-sla-policy';
import { BreachService } from './breach.service';
import {
  asRecord,
  parseClosure,
  parseCreateIncident,
  parseEvidence,
  parseGate,
  parseGateCompletion,
} from './dto';

/** Who may work an incident. A local constant, not an import — the same
 *  reasoning GRIEVANCE_HANDLERS and DPR_HANDLERS give: each module answers
 *  "who may act here" for itself, even when the answers currently coincide. */
const BREACH_HANDLERS = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * The Breach Register's HTTP surface (FR-BRC-01…07).
 *
 * Every mutating route is @Audited, so each gate transition, evidence
 * attestation and policy supersession lands in the S5 hash chain with its actor
 * and reason (FR-BRC-03). A deadline firing in the worker is not an HTTP route
 * at all, so it reaches the chain a different way — through
 * `SystemAuditService`, called from `BreachEscalationService`; see that file.
 */
@Controller('breach')
@UseGuards(TenantGuard)
export class BreachController {
  constructor(private readonly breach: BreachService) {}

  @Get('deadline-policies')
  async deadlinePolicies() {
    return { policies: await this.breach.deadlinePolicies() };
  }

  /** Supersede a gate's deadline — the most consequential configuration change
   *  in this module, so owner/DPO only and always audited. */
  @Post('deadline-policies/:gate')
  @Roles('owner', 'dpo')
  @Audited('breach.deadline_policy.superseded')
  @HttpCode(HttpStatus.CREATED)
  async supersedeDeadline(@Param('gate') gate: string, @Body() body: unknown) {
    const raw = asRecord(body);
    const slaSeconds = Number(raw.slaSeconds);
    if (!Number.isInteger(slaSeconds) || slaSeconds < 60 || slaSeconds > 31_536_000) {
      throw new BadRequestException('slaSeconds must be an integer between 60 and 31536000.');
    }
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    if (note.length < 10 || note.length > 1000) {
      throw new BadRequestException(
        'note must be 10-1000 characters: a statutory deadline with no stated basis is exactly ' +
          'what the versioned record exists to prevent.',
      );
    }
    const effectiveFrom = raw.effectiveFrom ? new Date(String(raw.effectiveFrom)) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('effectiveFrom must be an ISO-8601 timestamp.');
    }
    return this.breach.supersedeDeadline(parseGate(gate), {
      slaSeconds,
      ladder: parseLadder(raw.ladder),
      effectiveFrom,
      note,
    });
  }

  @Get('incidents')
  async list(@Query('status') status?: string, @Query('limit') limit?: string) {
    if (status !== undefined && status !== '' && status !== 'open' && status !== 'closed') {
      throw new BadRequestException('status must be open or closed.');
    }
    const parsed = Number(limit);
    return {
      incidents: await this.breach.list({
        status: status === '' || status === undefined ? undefined : (status as 'open' | 'closed'),
        limit: Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50,
      }),
    };
  }

  @Post('incidents')
  @Roles(...BREACH_HANDLERS)
  @Audited('breach.incident.opened')
  @HttpCode(HttpStatus.CREATED)
  async open(@Body() body: unknown) {
    return this.breach.open(parseCreateIncident(body));
  }

  @Get('incidents/:id')
  async detail(@Param('id') id: string) {
    return this.breach.detail(id);
  }

  @Post('incidents/:id/gates/:gate')
  @Roles(...BREACH_HANDLERS)
  @Audited('breach.gate.completed')
  @HttpCode(HttpStatus.OK)
  async completeGate(@Param('id') id: string, @Param('gate') gate: string, @Body() body: unknown) {
    const { notes } = parseGateCompletion(body);
    return this.breach.completeGate(id, parseGate(gate), notes);
  }

  @Post('incidents/:id/close')
  @Roles('owner', 'dpo')
  @Audited('breach.incident.closed')
  @HttpCode(HttpStatus.OK)
  async close(@Param('id') id: string, @Body() body: unknown) {
    return this.breach.close(id, parseClosure(body).note);
  }

  /** FR-BRC-05. The bytes are hashed and dropped; only the digest is kept. */
  @Post('incidents/:id/evidence')
  @Roles(...BREACH_HANDLERS)
  @Audited('breach.evidence.registered')
  @HttpCode(HttpStatus.CREATED)
  async addEvidence(@Param('id') id: string, @Body() body: unknown) {
    return this.breach.addEvidence(id, parseEvidence(body));
  }

  /**
   * FR-BRC-06. POST rather than GET for the reason RopaController and the
   * consent certificate both document: the audit interceptor records non-safe
   * methods only, and drafting a regulator report is exactly the
   * compliance-significant act the trail exists to catch.
   */
  @Post('incidents/:id/templates/:kind')
  @Roles(...BREACH_HANDLERS, 'auditor')
  @AllowReadOnly()
  @Audited('breach.template.generated')
  @HttpCode(HttpStatus.OK)
  async template(@Param('id') id: string, @Param('kind') kind: string) {
    if (kind !== 'data_principal_notice' && kind !== 'regulator_report') {
      throw new BadRequestException('kind must be data_principal_notice or regulator_report.');
    }
    return this.breach.template(id, kind);
  }

  @Post('incidents/:id/closure-packet')
  @Roles(...BREACH_HANDLERS, 'auditor')
  @AllowReadOnly()
  @Audited('breach.closure_packet.generated')
  @HttpCode(HttpStatus.OK)
  async closurePacket(@Param('id') id: string): Promise<StreamableFile> {
    const { buffer, filename } = await this.breach.closurePacket(id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
