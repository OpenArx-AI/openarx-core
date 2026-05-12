/**
 * Build-time info: git commit hash and package version.
 * Computed once at module load, cached for process lifetime.
 */

import { execSync } from 'child_process';

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'unknown';
  }
}

export const BUILD_COMMIT = getCommitHash();
export const BUILD_VERSION = '0.1.0';
