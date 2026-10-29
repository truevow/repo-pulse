import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { PrismaModule } from './prisma/prisma.module';
import { GithubModule } from './github/github.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    GithubModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => buildLoggerOptions(env),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
