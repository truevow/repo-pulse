import type { Prisma } from '@prisma/client';

export interface ActorRef {
  login: string;
  isBot: boolean;
}

const BOT_LOGIN = /\[bot\]$/;

/** A bot is a GraphQL `Bot` or a login ending in `[bot]`. */
export function actorRef(
  a: { __typename: string; login: string } | null,
): ActorRef | null {
  if (!a?.login) return null;
  return {
    login: a.login,
    isBot: a.__typename === 'Bot' || BOT_LOGIN.test(a.login),
  };
}

/**
 * Ensures one Actor row per login and returns login → id. A bot flag is only
 * ever raised, never cleared: commit users carry no `__typename`.
 */
export async function ensureActors(
  tx: Prisma.TransactionClient,
  refs: ActorRef[],
): Promise<Map<string, number>> {
  const byLogin = new Map<string, boolean>();
  for (const ref of refs) {
    byLogin.set(ref.login, (byLogin.get(ref.login) ?? false) || ref.isBot);
  }
  const ids = new Map<string, number>();
  for (const [login, isBot] of byLogin) {
    const actor = await tx.actor.upsert({
      where: { login },
      create: { login, isBot },
      update: isBot ? { isBot: true } : {},
      select: { id: true },
    });
    ids.set(login, actor.id);
  }
  return ids;
}
