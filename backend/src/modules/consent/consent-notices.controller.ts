import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentNoticesService } from './consent-notices.service';
import { parseCreateNotice, parseNoticeIdsQuery } from './consent-notices.dto';
import type { NoticeVersionWithTranslations } from './consent-notices.repository';

/**
 * Notice management (FR-CON-02). A separate controller class on the SAME
 * `consent` base path as ConsentController — same nesting precedent as
 * EntryPurposesController alongside RegisterController: notices are always
 * reached in the context of their purpose, except for the single-version
 * lookup by the version's own id (already globally unique; RLS still confines
 * it to the caller's tenant).
 */
@Controller('consent')
@UseGuards(TenantGuard)
export class ConsentNoticesController {
  constructor(private readonly notices: ConsentNoticesService) {}

  /** Publish a new notice version (all its translations together). */
  @Post('purposes/:purposeId/notices')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.notice.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Param('purposeId', ParseUUIDPipe) purposeId: string, @Body() body: unknown) {
    const translations = parseCreateNotice(body);
    return toResponse(await this.notices.create(purposeId, translations));
  }

  /** Version history for one purpose's notice, newest first. */
  @Get('purposes/:purposeId/notices')
  async list(@Param('purposeId', ParseUUIDPipe) purposeId: string) {
    const versions = await this.notices.listForPurpose(purposeId);
    return { notices: versions.map(toResponse) };
  }

  /**
   * Many notice versions by id in one round trip — `?ids=a,b,c` — for the
   * subject consent timeline, which otherwise resolves every DISTINCT notice
   * version its events reference with one `findOne` each. An id with no
   * matching notice is simply absent from `notices`, mirroring `findOne`'s
   * 404 per-id without turning one bad id into a failed batch.
   */
  @Get('notices')
  async findMany(@Query('ids') ids?: string) {
    const parsed = parseNoticeIdsQuery(ids);
    const found = await this.notices.findMany(parsed);
    return { notices: found.map(toResponse) };
  }

  /** One notice version by its own id — the first-class notice_version_id. */
  @Get('notices/:id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return toResponse(await this.notices.findOne(id));
  }
}

function toResponse(result: NoticeVersionWithTranslations) {
  return {
    id: result.version.id,
    purposeId: result.version.purpose_id,
    versionNumber: result.version.version_number,
    createdAt: result.version.created_at,
    translations: result.translations.map((t) => ({ language: t.language, body: t.body })),
  };
}
