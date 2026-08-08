import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowPublicKey } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentFormsService } from './consent-forms.service';
import { parseWidgetSubmission } from './consent-forms.dto';

/**
 * The tenant-wide website embed surface, reached by the SAME publishable API key
 * as the rest of the SDK (PublicApiKeyMiddleware, `/consent/public/*`). One
 * snippet per tenant: the widget calls GET active-forms at render time and shows
 * whatever is currently active — toggling a form/row on the platform changes the
 * live site with no client code change. Submissions still flow through
 * ConsentService.recordConsent() (R3).
 */
@Controller('consent/public')
@UseGuards(TenantGuard)
export class ConsentFormsPublicController {
  constructor(private readonly forms: ConsentFormsService) {}

  /** Every live form + its active rows for this tenant. GET, keyed only by the
   *  publishable key that already scoped the tenant. */
  @Get('active-forms')
  async activeForms() {
    return { forms: await this.forms.activeFormsForTenant() };
  }

  @Post('forms/:formId/submissions')
  @AllowPublicKey()
  @Audited('consent.form.submitted')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Param('formId') formId: string, @Body() body: unknown) {
    return this.forms.submitWidget(formId, parseWidgetSubmission(body));
  }
}
