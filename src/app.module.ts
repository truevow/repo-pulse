import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => buildLoggerOptions(env),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
