import { Controller, Get } from '@nestjs/common';
import { MODULES } from '@dpdp/shared';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; stage: number; modules: readonly string[] } {
    return { status: 'ok', stage: 1, modules: MODULES };
  }
}
