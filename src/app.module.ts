import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule } from './config/config.module';
import { ENV, type Env } from './config/env';
import { buildLoggerOptions } from './config/logger';
import { PrismaModule } from './prisma/prisma.module';
import { GithubModule } from './github/github.module';
import { HealthController } from './health/health.controller';
import { IngestionModule } from './ingestion/ingestion.module';
import { SignalsModule } from './signals/signals.module';
import { SynthesisModule } from './synthesis/synthesis.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    GithubModule,
    IngestionModule,
    SignalsModule,
    SynthesisModule,
    // Applied only where ThrottlerGuard is used (the narrative controller).
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => [
        { ttl: 60_000, limit: env.NARRATIVE_RATE_LIMIT_PER_MIN },
      ],
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ENV],
      useFactory: (env: Env) => buildLoggerOptions(env),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
