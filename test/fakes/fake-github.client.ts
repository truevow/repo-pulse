import type { GitHubClient } from '../../src/github/github.client';

export type FakeVariables = Record<string, unknown>;

/**
 * Per query document: either responses consumed in order (one per call; an
 * `Error` element is thrown) or a function of the variables (it may throw).
 */
export type FakeResponses = Record<
  string,
  unknown[] | ((vars: FakeVariables) => unknown)
>;

interface Hold {
  document?: string;
  released: Promise<void>;
}

/** Scripted GitHubClient keyed by query document identity. */
export class FakeGitHubClient implements GitHubClient {
  readonly calls: Array<{ document: string; variables: FakeVariables }> = [];
  private readonly cursors = new Map<string, number>();
  private holds: Hold[] = [];

  constructor(private readonly pages: FakeResponses) {}

  /**
   * Makes the next query (of `document`, when given) block until the returned
   * release function is called, so a job can be observed `running`.
   */
  hold(document?: string): () => void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    this.holds.push({ document, released });
    return release;
  }

  callsTo(document: string): FakeVariables[] {
    return this.calls
      .filter((c) => c.document === document)
      .map((c) => c.variables);
  }

  async query<T>(document: string, variables: FakeVariables): Promise<T> {
    this.calls.push({ document, variables });
    const hold = this.holds.find(
      (h) => h.document === undefined || h.document === document,
    );
    if (hold) {
      this.holds = this.holds.filter((h) => h !== hold);
      await hold.released;
    }
    return this.respond(document, variables) as T;
  }

  private respond(document: string, variables: FakeVariables): unknown {
    const entry = this.pages[document];
    if (entry === undefined) {
      throw new Error('FakeGitHubClient: unexpected query document');
    }
    if (typeof entry === 'function') return entry(variables);
    const index = this.cursors.get(document) ?? 0;
    if (index >= entry.length) {
      throw new Error('FakeGitHubClient: scripted responses exhausted');
    }
    this.cursors.set(document, index + 1);
    const response = entry[index];
    if (response instanceof Error) throw response;
    return response;
  }
}
