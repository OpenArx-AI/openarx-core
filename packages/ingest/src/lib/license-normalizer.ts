/**
 * License normalizer — converts raw license strings from various sources
 * into canonical SPDX identifiers.
 *
 * Supports:
 * - URL forms (arXiv OAI-PMH, Crossref): http://creativecommons.org/licenses/by/4.0/
 * - SPDX identifiers (OpenAlex, Unpaywall): CC-BY-4.0
 * - Loose strings: cc-by, cc by 4.0
 *
 * Output is always a valid SPDX identifier or LicenseRef-* for non-SPDX licenses.
 *
 * Permissive default: when license cannot be determined, returns NOASSERTION
 * with is_open=true. Per compliance policy, unknown licenses are treated in our
 * favor — we cannot be responsible for licenses we were never informed about.
 */

/**
 * SPDX identifier or LicenseRef-* for licenses not in the SPDX standard.
 *
 * Standard SPDX (subset relevant for scientific publications):
 * - CC0-1.0
 * - CC-BY-4.0, CC-BY-3.0
 * - CC-BY-SA-4.0, CC-BY-SA-3.0
 * - CC-BY-NC-4.0
 * - CC-BY-NC-SA-4.0
 * - CC-BY-NC-ND-4.0
 * - CC-BY-ND-4.0
 *
 * LicenseRef (custom, for arXiv-specific licenses):
 * - LicenseRef-arxiv-nonexclusive — arXiv perpetual non-exclusive distribution license 1.0
 * - LicenseRef-arxiv-assumed — assumed license for arXiv papers from 1991-2003
 *
 * Special:
 * - NOASSERTION — license could not be determined (SPDX standard token)
 */
export type SpdxLicense = string;

export interface LicenseInfo {
  /** Canonical SPDX identifier (or LicenseRef-* / NOASSERTION) */
  spdx: SpdxLicense;
  /** Whether this license allows free redistribution */
  is_open: boolean;
  /** Original raw input (for audit and debugging) */
  raw: string | null;
}

/**
 * Default set of SPDX identifiers we treat as "open" (free redistribution allowed).
 *
 * Configurable via OPEN_LICENSES env var (comma-separated SPDX identifiers).
 * NOTE: NOASSERTION is also treated as open per permissive default policy.
 * Unknown licenses are treated in our favor.
 */
const OPEN_LICENSES_DEFAULT: readonly string[] = [
  'CC0-1.0',
  'CC-BY-4.0', 'CC-BY-3.0',
  'CC-BY-SA-4.0', 'CC-BY-SA-3.0',
  'CC-PDDC',
  'MIT', 'Apache-2.0', 'BSD-3-Clause',
];

const OPEN_LICENSES: ReadonlySet<SpdxLicense> = new Set(
  process.env.OPEN_LICENSES
    ? process.env.OPEN_LICENSES.split(',').map(s => s.trim())
    : OPEN_LICENSES_DEFAULT,
);

/** Normalize raw license string to canonical SpdxLicense identifier. */
export function normalizeLicense(raw: string | null | undefined): LicenseInfo {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return { spdx: 'NOASSERTION', is_open: true, raw: null };
  }

  const original = raw.trim();
  const lower = original.toLowerCase();

  // ── arXiv-specific licenses ─────────────────────────────────
  if (lower.includes('arxiv.org/licenses/nonexclusive-distrib')) {
    return { spdx: 'LicenseRef-arxiv-nonexclusive', is_open: false, raw: original };
  }
  if (lower.includes('arxiv.org/licenses/assumed-1991-2003')) {
    return { spdx: 'LicenseRef-arxiv-assumed', is_open: false, raw: original };
  }

  // ── Creative Commons URL forms ──────────────────────────────
  // Public domain / CC0
  if (lower.includes('creativecommons.org/publicdomain/zero')) {
    return { spdx: 'CC0-1.0', is_open: true, raw: original };
  }
  if (lower.includes('creativecommons.org/publicdomain/mark')) {
    // Public Domain Mark — works in public domain
    return { spdx: 'CC-PDDC', is_open: true, raw: original };
  }

  // CC license URLs follow pattern: creativecommons.org/licenses/{type}/{version}/
  // We check most-specific patterns first (4-letter codes before 3-letter, etc.)
  const ccUrlMatch = lower.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d+\.\d+)/);
  if (ccUrlMatch) {
    return parseCcComponents(ccUrlMatch[1], ccUrlMatch[2], original);
  }

  // ── SPDX-style or loose strings ─────────────────────────────
  // Strip whitespace and unify separators
  const compact = lower.replace(/\s+/g, '-').replace(/_/g, '-');

  if (compact === 'cc0' || compact === 'cc0-1.0' || compact === 'cc-zero') {
    return { spdx: 'CC0-1.0', is_open: true, raw: original };
  }
  if (compact === 'public-domain' || compact === 'pd') {
    return { spdx: 'CC-PDDC', is_open: true, raw: original };
  }

  // Software licenses (rare on papers, but Unpaywall/OpenAlex return them)
  if (compact === 'mit') {
    return { spdx: 'MIT', is_open: true, raw: original };
  }
  if (compact === 'apache-2.0') {
    return { spdx: 'Apache-2.0', is_open: true, raw: original };
  }
  if (compact === 'bsd' || compact === 'bsd-3-clause') {
    return { spdx: 'BSD-3-Clause', is_open: true, raw: original };
  }

  // Unpaywall/OpenAlex markers (not real licenses — treat as unknown → permissive default)
  if (compact === 'implied-oa' || compact === 'other-oa') {
    return { spdx: 'NOASSERTION', is_open: true, raw: original };
  }

  // Match SPDX-style: cc-by-4.0, cc-by-nc-sa-4.0, etc.
  const spdxMatch = compact.match(/^cc-([a-z-]+?)-?(\d+\.\d+)?$/);
  if (spdxMatch) {
    const components = spdxMatch[1];
    const version = spdxMatch[2] ?? '4.0';
    return parseCcComponents(components, version, original);
  }

  // Loose match: bare "cc-by" without version → assume 4.0
  if (compact === 'cc-by') {
    return { spdx: 'CC-BY-4.0', is_open: true, raw: original };
  }
  if (compact === 'cc-by-sa') {
    return { spdx: 'CC-BY-SA-4.0', is_open: true, raw: original };
  }
  if (compact === 'cc-by-nc') {
    return { spdx: 'CC-BY-NC-4.0', is_open: false, raw: original };
  }
  if (compact === 'cc-by-nc-sa') {
    return { spdx: 'CC-BY-NC-SA-4.0', is_open: false, raw: original };
  }
  if (compact === 'cc-by-nc-nd') {
    return { spdx: 'CC-BY-NC-ND-4.0', is_open: false, raw: original };
  }
  if (compact === 'cc-by-nd') {
    return { spdx: 'CC-BY-ND-4.0', is_open: false, raw: original };
  }

  // ── Fallback ────────────────────────────────────────────────
  return { spdx: 'NOASSERTION', is_open: true, raw: original };
}

/**
 * Parse CC license components ("by", "by-sa", "by-nc-nd", ...) and version
 * into a canonical SPDX identifier.
 */
function parseCcComponents(components: string, version: string, original: string): LicenseInfo {
  // Normalize component string and check by exact match (longest first)
  const c = components.toLowerCase();

  // 4-component forms (NC + ND or NC + SA)
  if (c === 'by-nc-nd' || c === 'by-nd-nc') {
    return { spdx: `CC-BY-NC-ND-${version}`, is_open: false, raw: original };
  }
  if (c === 'by-nc-sa' || c === 'by-sa-nc') {
    return { spdx: `CC-BY-NC-SA-${version}`, is_open: false, raw: original };
  }

  // 3-component forms
  if (c === 'by-nc') {
    return { spdx: `CC-BY-NC-${version}`, is_open: false, raw: original };
  }
  if (c === 'by-nd') {
    return { spdx: `CC-BY-ND-${version}`, is_open: false, raw: original };
  }
  if (c === 'by-sa') {
    return { spdx: `CC-BY-SA-${version}`, is_open: true, raw: original };
  }

  // 2-component
  if (c === 'by') {
    return { spdx: `CC-BY-${version}`, is_open: true, raw: original };
  }

  // Unknown CC variant — fall back to NOASSERTION
  return { spdx: 'NOASSERTION', is_open: true, raw: original };
}

/** Test if a given SPDX identifier represents an open (freely redistributable) license. */
export function isOpenLicense(spdx: SpdxLicense): boolean {
  if (spdx === 'NOASSERTION') return true; // permissive default
  if (OPEN_LICENSES.has(spdx)) return true;
  // CC-BY and CC-BY-SA versions other than 3.0/4.0
  if (/^CC-BY-\d+\.\d+$/.test(spdx)) return true;
  if (/^CC-BY-SA-\d+\.\d+$/.test(spdx)) return true;
  if (/^CC-PDDC$/.test(spdx)) return true;
  return false;
}

/**
 * Source priority for computing the "effective" license from multi-source data.
 *
 * Order matters: earlier entries override later ones. Sources are checked in order
 * and the first one with a value wins. OpenArx-published documents come first
 * (the author explicitly chose the license at publication time, this is a
 * contractual statement). Then we trust arXiv (authoritative for arXiv papers),
 * then Crossref (authoritative for DOI metadata), then aggregators.
 */
export const LICENSE_SOURCE_PRIORITY: readonly string[] = [
  'openarx',    // OpenArx Portal (author-selected at publication, contractual)
  'arxiv_oai',  // arXiv OAI-PMH (authoritative for arXiv papers)
  'crossref',   // Crossref (authoritative for DOI metadata)
  'openalex',   // OpenAlex (CC0 aggregator)
  'unpaywall',  // Unpaywall (OA aggregator)
  'core',       // CORE (UK OA aggregator)
  'pmc',        // PubMed Central (biomedical OA)
];

/**
 * Compute the effective SPDX license from a multi-source licenses map.
 *
 * Strategy: most permissive wins. If ANY source reports an open license,
 * that becomes the effective license (best for user). Among open licenses,
 * higher-priority source wins. Among closed licenses, higher-priority wins.
 *
 * This ensures that a CC-BY-4.0 from Unpaywall/OpenAlex is not overridden
 * by a restrictive arXiv non-exclusive license just because arXiv has
 * higher source priority.
 *
 * @param licenses - Map of source_id → SPDX identifier (e.g. { arxiv_oai: 'CC-BY-4.0' })
 * @returns The effective SPDX identifier
 */
export function computeEffectiveLicense(
  licenses: Record<string, string> | null | undefined,
): SpdxLicense {
  if (!licenses) return 'NOASSERTION';

  // First pass: find the highest-priority OPEN license
  for (const source of LICENSE_SOURCE_PRIORITY) {
    const value = licenses[source];
    if (value && typeof value === 'string' && isOpenLicense(value)) return value;
  }

  // Second pass: no open license found — return highest-priority closed one
  for (const source of LICENSE_SOURCE_PRIORITY) {
    const value = licenses[source];
    if (value && typeof value === 'string') return value;
  }

  return 'NOASSERTION';
}
