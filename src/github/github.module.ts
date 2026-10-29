import { Module } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ENV, type Env } from '../config/env';
import { GITHUB_CLIENT, MissingTokenGitHubClient } from './github.client';
import { GitHubGraphqlClient } from './github-graphql.client';

@Module({
  providers: [
    {
      provide: GITHUB_CLIENT,
      inject: [ENV, PinoLogger],
      useFactory: (env: Env, logger: PinoLogger) =>
        env.GITHUB_TOKEN
          ? new GitHubGraphqlClient({ token: env.GITHUB_TOKEN, logger })
          : new MissingTokenGitHubClient(),
    },
  ],
  exports: [GITHUB_CLIENT],
})
export class GithubModule {}
