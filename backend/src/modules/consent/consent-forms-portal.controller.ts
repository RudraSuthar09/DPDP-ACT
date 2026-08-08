import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { FormGuard } from '../../tenancy/form.guard';
import type { RequestWithFormTenant } from '../../tenancy/form-tenant.middleware';
import { PublicForm } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentFormsService } from './consent-forms.service';
import { parseLinkSubmission } from './consent-forms.dto';

/**
 * THE HOSTED CONSENT FORM LINK — for a client with no website of their own to
 * embed the widget into. Built on FormTenantMiddleware/FormGuard, the exact
 * same pattern as the public request portal (FR-GRV-01): a slug resolved
 * before the handler runs, an anonymous tenant context, no credential of any
 * kind. See form-tenant.middleware.ts's header for why a slug is an
 * identifier and not a credential.
 *
 * There is no host page here to already know who the visitor is, so the form
 * itself collects name + email/phone as its first field — parseLinkSubmission
 * requires one of the two, and ConsentFormsService.submitLink() feeds it into
 * the SAME SubjectRefHasher every other consent surface uses (no second
 * identity scheme).
 */
@Controller('forms/:slug')
@UseGuards(FormGuard)
export class ConsentFormsPortalController {
  constructor(private readonly forms: ConsentFormsService) {}

  @Get()
  @PublicForm()
  async definition(@Req() req: RequestWithFormTenant) {
    return this.forms.publicFormForLink(req.formTenant!.formId);
  }

  @Post('submit')
  @PublicForm()
  @Audited('consent.form.submitted')
  @HttpCode(HttpStatus.CREATED)
  async submit(@Req() req: RequestWithFormTenant, @Body() body: unknown) {
    return this.forms.submitLink(req.formTenant!.formId, parseLinkSubmission(body));
  }
}
