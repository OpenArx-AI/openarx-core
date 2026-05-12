/**
 * GitHub URL verifier — validates repo URLs and fetches metadata.
 *
 * HTTP HEAD to check existence (5s timeout, 1 req/sec rate limit).
 * If GITHUB_TOKEN is set, fetches stars + language via GitHub API.
 * Graceful skip on rate limit or network errors.
 */

import type { CodeLink } from '@openarx/types';
import { createChildLogger } from '../../lib/logger.js';

const log = createChildLogger('github-verifier');

const RATE_LIMIT_MS = 1000; // 1 request per second
const TIMEOUT_MS = 5000;

interface GitHubRepoInfo {
  stargazers_count?: number;
  language?: string | null;
}

export class GitHubVerifier {
  private lastRequestAt = 0;
  private readonly token: string | undefined;

  constructor() {
    this.token = process.env.GITHUB_TOKEN;
  }

  async verify(urls: string[]): Promise<CodeLink[]> {
    const results: CodeLink[] = [];

    for (const url of urls) {
      try {
        await this.rateLimit();

        const alive = await this.checkAlive(url);
        if (!alive) {
          log.debug({ url }, 'Dead link filtered out');
          continue;
        }

        const link: CodeLink = {
          repoUrl: url,
          extractedFrom: 'paper_text',
        };

        // If token available, fetch metadata
        if (this.token) {
          const meta = await this.fetchMetadata(url);
          if (meta) {
            link.stars = meta.stargazers_count;
            if (meta.language) link.language = meta.language;
          }
        }

        results.push(link);
      } catch (err) {
        log.warn({ url, err }, 'GitHub verification failed, skipping');
      }
    }

    return results;
  }

  private async checkAlive(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        log.warn('GitHub rate limited on HEAD check, treating as alive');
        return true;
      }

      return response.ok;
    } catch {
      // Network error / timeout — treat as alive to avoid false negatives
      log.debug({ url }, 'HEAD check failed (network/timeout), treating as alive');
      return true;
    }
  }

  private async fetchMetadata(url: string): Promise<GitHubRepoInfo | null> {
    const match = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(url);
    if (!match) return null;

    const [, owner, repo] = match;

    try {
      await this.rateLimit();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'openarx-ingest',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          log.warn('GitHub API rate limited, skipping metadata');
        }
        return null;
      }

      return (await response.json()) as GitHubRepoInfo;
    } catch {
      log.debug({ url }, 'GitHub API metadata fetch failed');
      return null;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;

    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }

    this.lastRequestAt = Date.now();
  }
}
