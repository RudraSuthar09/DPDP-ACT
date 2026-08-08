import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { ConsentFormsService } from './consent-forms.service';
import {
  parseActiveFlag,
  parseAddRowInput,
  parseSaveFormInput,
  parseUpdateRowInput,
} from './consent-forms.dto';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Staff CRUD for the new-UX consent forms: the single-screen builder (a form
 * name + a mutable flat list of rows) and per-form submissions. No "publish"
 * step — a form is served the moment it is toggled active (is_active), which is
 * what the tenant-wide embed and the per-form hosted link both read.
 */
@Controller('consent/forms')
@UseGuards(TenantGuard)
export class ConsentFormsController {
  constructor(private readonly forms: ConsentFormsService) {}

  @Get()
  async list() {
    return { forms: await this.forms.list() };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return this.forms.getForm(id);
  }

  @Post()
  @Roles(...MANAGE)
  @Audited('consent.form.created')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    return this.forms.createForm(parseSaveFormInput(body));
  }

  @Put(':id')
  @Roles(...MANAGE)
  @Audited('consent.form.updated')
  async update(@Param('id') id: string, @Body() body: unknown) {
    return this.forms.updateForm(id, parseSaveFormInput(body));
  }

  @Patch(':id/active')
  @Roles(...MANAGE)
  @Audited('consent.form.active_toggled')
  async setActive(@Param('id') id: string, @Body() body: unknown) {
    return this.forms.setActive(id, parseActiveFlag(body, 'isActive'));
  }

  // --- rows ------------------------------------------------------------------

  @Post(':id/rows')
  @Roles(...MANAGE)
  @Audited('consent.form.row_added')
  @HttpCode(HttpStatus.CREATED)
  async addRow(@Param('id') id: string, @Body() body: unknown) {
    return this.forms.addRow(id, parseAddRowInput(body));
  }

  @Put(':id/rows/:rowId')
  @Roles(...MANAGE)
  @Audited('consent.form.row_updated')
  async updateRow(@Param('id') id: string, @Param('rowId') rowId: string, @Body() body: unknown) {
    return this.forms.updateRow(id, rowId, parseUpdateRowInput(body));
  }

  @Patch(':id/rows/:rowId/active')
  @Roles(...MANAGE)
  @Audited('consent.form.row_active_toggled')
  async toggleRow(@Param('id') id: string, @Param('rowId') rowId: string, @Body() body: unknown) {
    return this.forms.toggleRow(id, rowId, parseActiveFlag(body, 'active'));
  }

  @Delete(':id/rows/:rowId')
  @Roles(...MANAGE)
  @Audited('consent.form.row_removed')
  async removeRow(@Param('id') id: string, @Param('rowId') rowId: string) {
    return this.forms.removeRow(id, rowId);
  }

  // --- submissions -----------------------------------------------------------

  @Get(':id/submissions')
  async submissions(@Param('id') id: string) {
    return { submissions: await this.forms.listSubmissions(id) };
  }
}
