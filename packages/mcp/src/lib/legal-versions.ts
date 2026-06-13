/**
 * Required legal-consent versions (contract document_publication_pipeline.md
 * §11). Source of truth is a JSON file deployed by the contracts-agent; both
 * Core and Portal read the same file so consent enforcement stays in lockstep.
 *
 * Hot path (publish-document) reads the in-memory cache — never touches disk
 * per request. The file is loaded once at startup and re-read on SIGHUP, so a
 * version bump takes effect without a Core redeploy.
 */
import { readFileSync } from 'node:fs';

export interface LegalVersions {
  tos_version: string;
  privacy_version: string;
  dmca_version: string;
  upload_consent_version: string;
}

const LEGAL_VERSIONS_PATH = process.env.LEGAL_VERSIONS_PATH ?? '/etc/openarx/legal-versions.json';

const REQUIRED_KEYS: (keyof LegalVersions)[] = [
  'tos_version', 'privacy_version', 'dmca_version', 'upload_consent_version',
];

let cached: LegalVersions | null = null;
let loadError: string | null = null;

function load(): void {
  try {
    const raw = JSON.parse(readFileSync(LEGAL_VERSIONS_PATH, 'utf-8')) as Record<string, unknown>;
    const missing = REQUIRED_KEYS.filter((k) => typeof raw[k] !== 'string' || !raw[k]);
    if (missing.length > 0) {
      loadError = `legal-versions file missing keys: ${missing.join(', ')}`;
      return;
    }
    cached = {
      tos_version: raw.tos_version as string,
      privacy_version: raw.privacy_version as string,
      dmca_version: raw.dmca_version as string,
      upload_consent_version: raw.upload_consent_version as string,
    };
    loadError = null;
  } catch (err) {
    loadError = `cannot read legal-versions file at ${LEGAL_VERSIONS_PATH}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Call once at server startup; installs the SIGHUP hot-reload handler. */
export function initLegalVersions(): void {
  load();
  process.on('SIGHUP', () => {
    load();
    // eslint-disable-next-line no-console
    console.error(loadError
      ? `[legal-versions] SIGHUP reload FAILED: ${loadError}`
      : '[legal-versions] reloaded on SIGHUP');
  });
}

/**
 * Current required versions, or null when the file is missing/malformed —
 * the consent check treats null as fail-closed (cannot verify → cannot
 * publish), surfacing loadError to the caller for ops visibility.
 */
export function getRequiredVersions(): LegalVersions | null {
  if (!cached && loadError === null) load(); // lazy first-load safety net
  return cached;
}

export function getLegalVersionsError(): string | null {
  return loadError;
}
