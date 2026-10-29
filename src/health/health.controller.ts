import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness and dependency status' })
  check(): { status: 'ok'; db: 'up' | 'down' | 'skipped' } {
    // The database check is added in Task 3.
    return { status: 'ok', db: 'skipped' };
  }
}
