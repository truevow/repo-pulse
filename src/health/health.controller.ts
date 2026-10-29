import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProblemException } from '../common/problem.exception';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and dependency status' })
  async check(): Promise<{ status: 'ok'; db: 'up' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ProblemException({
        status: 503,
        type: 'internal',
        title: 'Service Unavailable',
        detail: 'Database unreachable',
        extensions: { db: 'down' },
      });
    }
    return { status: 'ok', db: 'up' };
  }
}
