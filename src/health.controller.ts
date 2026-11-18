import { Controller, Get, Module } from '@nestjs/common';
import { Public } from './common/auth.guard.js';

/** Liveness probe for the hosting platform (Render healthCheckPath). No DB/Redis calls. */
@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok' as const };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
