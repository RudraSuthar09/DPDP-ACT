import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentApiKeysService } from './consent-api-keys.service';
import { parseApiKeyLabelInput } from './dto';

/**
 * FR-CON-09: staff-facing management of the credentials the Consent SDK's
 * public routes accept. JWT-gated like the rest of ConsentController — this
 * is the "mint/list/revoke a key" surface, not the surface the SDK itself
 * calls (that's ConsentPublicController, authenticated by the key instead).
 */
@Controller('consent/api-keys')
@UseGuards(TenantGuard)
export class ConsentApiKeysController {
  constructor(private readonly keys: ConsentApiKeysService) {}

  /** The raw key is returned exactly once, here, and never again — there is
   *  no reveal endpoint (see ConsentApiKeysService's doc comment). */
  @Post()
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.api_key.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const { label } = parseApiKeyLabelInput(body);
    return this.keys.create(label);
  }

  @Get()
  async list() {
    return { keys: await this.keys.list() };
  }

  @Post(':id/revoke')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('consent.api_key.revoked')
  @HttpCode(HttpStatus.OK)
  async revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.keys.revoke(id);
  }
}
