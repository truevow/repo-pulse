import { Module } from '@nestjs/common';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';
import { MetricsRepository } from './metrics.repository';

@Module({
  controllers: [InsightsController],
  providers: [MetricsRepository, InsightsService],
  exports: [InsightsService, MetricsRepository],
})
export class SignalsModule {}
