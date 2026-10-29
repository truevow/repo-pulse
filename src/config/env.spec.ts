import { loadEnv } from './env';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' });
    expect(env.PORT).toBe(3000);
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(env.ANTHROPIC_EFFORT).toBe('medium');
    expect(env.SYNC_MAX_WEEKS).toBe(26);
    expect(env.NARRATIVE_RATE_LIMIT_PER_MIN).toBe(10);
  });

  it('rejects a missing DATABASE_URL without echoing other values', () => {
    expect(() => loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-secret' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-secret' })).not.toThrow(
      /sk-ant-secret/,
    );
  });

  it('treats empty optional strings as unset', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      GITHUB_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      CORS_ORIGIN: '',
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CORS_ORIGIN).toBeUndefined();
  });
});
