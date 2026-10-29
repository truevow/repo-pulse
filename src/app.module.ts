import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { HealthController } from './health/health.controller';

@Module({
  imports: [ConfigModule, LoggerModule.forRoot(buildLoggerOptions(loadEnv()))],
  controllers: [HealthController],
})
export class AppModule {}
