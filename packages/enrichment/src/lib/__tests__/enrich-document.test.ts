import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLocations, mergeLicenseSources, shouldTriggerReindex } from '../enrich-document.js';
import type { OaLocation } from '../enrich-document.js';
import type { OpenAlexResult } from '../../sources/openalex.js';
import type { UnpaywallResult } from '../../sources/unpaywall.js';
import type { CoreResult } from '../../sources/core.js';
import type { PmcResult } from '../../sources/pmc.js';

// ── Test aggregateLocations (pure function, no mocks needed) ──

describe('aggregateLocations', () => {
  const OPENALEX_WITH_OA: OpenAlexResult = {
    status: 'success',
    doi: '10.1038/test',
    openalexId: 'W123',
    oaStatus: 'hybrid',
    locations: [
      { pdfUrl: 'https://nature.com/paper.pdf', landingPageUrl: 'https://nature.com/paper', license: 'cc-by', version: 'publishedVersion', sourceName: 'Nature', sourceType: 'journal', isOa: true },
      { pdfUrl: null, landingPageUrl: 'https://pubmed.ncbi.nlm.nih.gov/123', license: null, version: 'publishedVersion', sourceName: 'PubMed', sourceType: 'repository', isOa: false },
    ],
    raw: null,
  };

  const UNPAYWALL_WITH_OA: UnpaywallResult = {
    status: 'success',
    doi: '10.1038/test',
    isOa: true,
    bestLocation: { url: 'https://repo.edu/paper.pdf', urlForPdf: 'https://repo.edu/paper.pdf', urlForLandingPage: 'https://repo.edu/paper', license: 'cc-by-sa', version: 'acceptedVersion', hostType: 'repository', repositoryInstitution: 'Example Uni' },
    allLocations: [
      { url: 'https://repo.edu/paper.pdf', urlForPdf: 'https://repo.edu/paper.pdf', urlForLandingPage: 'https://repo.edu/paper', license: 'cc-by-sa', version: 'acceptedVersion', hostType: 'repository', repositoryInstitution: 'Example Uni' },
    ],
    raw: null,
  };

  const CORE_WITH_FULLTEXT: CoreResult = {
    status: 'success',
    doi: '10.1038/test',
    coreId: '12345',
    locations: [
      { downloadUrl: 'https://core.ac.uk/download/12345.pdf', sourceFulltextUrls: [], license: 'cc-by-4.0', publisher: 'Nature', repositoryName: 'CORE' },
    ],
    raw: null,
  };

  const PMC_FOUND: PmcResult = {
    status: 'success',
    doi: '10.1038/test',
    pmcid: 'PMC8371605',
    pmid: '34265844',
    pdfUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8371605/pdf/',
    license: null,
    raw: null,
  };

  test('all 4 sources with OA → aggregates all locations', () => {
    const locs = aggregateLocations(OPENALEX_WITH_OA, UNPAYWALL_WITH_OA, CORE_WITH_FULLTEXT, PMC_FOUND);

    assert.ok(locs.length >= 4, `Expected >= 4, got ${locs.length}`);

    const sources = locs.map(l => l.source);
    assert.ok(sources.includes('openalex'));
    assert.ok(sources.includes('unpaywall'));
    assert.ok(sources.includes('core'));
    assert.ok(sources.includes('pmc'));
  });

  test('openalex: only OA locations with pdfUrl included', () => {
    const locs = aggregateLocations(OPENALEX_WITH_OA, null, null, null);

    assert.equal(locs.length, 1);
    assert.equal(locs[0].source, 'openalex');
    assert.equal(locs[0].url, 'https://nature.com/paper.pdf');
    assert.equal(locs[0].license, 'cc-by');
    assert.equal(locs[0].version, 'publishedVersion');
  });

  test('openalex: non-OA locations excluded', () => {
    const closedOnly: OpenAlexResult = {
      status: 'success', doi: '10.1038/test', openalexId: 'W1', oaStatus: 'closed',
      locations: [
        { pdfUrl: null, landingPageUrl: 'https://x.com', license: null, version: 'publishedVersion', sourceName: 'X', sourceType: 'journal', isOa: false },
      ],
      raw: null,
    };
    const locs = aggregateLocations(closedOnly, null, null, null);
    assert.equal(locs.length, 0);
  });

  test('unpaywall: closed paper excluded', () => {
    const closed: UnpaywallResult = {
      status: 'success', doi: '10.1038/test', isOa: false,
      bestLocation: null, allLocations: [], raw: null,
    };
    const locs = aggregateLocations(null, closed, null, null);
    assert.equal(locs.length, 0);
  });

  test('unpaywall: uses urlForPdf when available', () => {
    const locs = aggregateLocations(null, UNPAYWALL_WITH_OA, null, null);
    assert.equal(locs.length, 1);
    assert.equal(locs[0].url, 'https://repo.edu/paper.pdf');
    assert.equal(locs[0].license, 'cc-by-sa');
  });

  test('core: downloadUrl used', () => {
    const locs = aggregateLocations(null, null, CORE_WITH_FULLTEXT, null);
    assert.equal(locs.length, 1);
    assert.equal(locs[0].url, 'https://core.ac.uk/download/12345.pdf');
    assert.equal(locs[0].hostType, 'repository');
  });

  test('core: falls back to sourceFulltextUrls', () => {
    const coreFallback: CoreResult = {
      status: 'success', doi: '10.1038/test', coreId: '99',
      locations: [{ downloadUrl: null, sourceFulltextUrls: ['https://repo.edu/full.pdf'], license: null, publisher: null, repositoryName: null }],
      raw: null,
    };
    const locs = aggregateLocations(null, null, coreFallback, null);
    assert.equal(locs.length, 1);
    assert.equal(locs[0].url, 'https://repo.edu/full.pdf');
  });

  test('core: no URLs → no locations', () => {
    const coreEmpty: CoreResult = {
      status: 'success', doi: '10.1038/test', coreId: '99',
      locations: [{ downloadUrl: null, sourceFulltextUrls: [], license: null, publisher: null, repositoryName: null }],
      raw: null,
    };
    const locs = aggregateLocations(null, null, coreEmpty, null);
    assert.equal(locs.length, 0);
  });

  test('pmc: pdfUrl included', () => {
    const locs = aggregateLocations(null, null, null, PMC_FOUND);
    assert.equal(locs.length, 1);
    assert.equal(locs[0].source, 'pmc');
    assert.ok(locs[0].url.includes('PMC8371605'));
  });

  test('pmc: not_found → no locations', () => {
    const pmcNotFound: PmcResult = {
      status: 'not_found', doi: '10.1038/test', pmcid: null, pmid: null, pdfUrl: null, license: null, raw: null,
    };
    const locs = aggregateLocations(null, null, null, pmcNotFound);
    assert.equal(locs.length, 0);
  });

  test('arxiv URLs filtered out from openalex', () => {
    const oaWithArxiv: OpenAlexResult = {
      status: 'success', doi: '10.1038/test', openalexId: 'W1', oaStatus: 'green',
      locations: [
        { pdfUrl: 'https://arxiv.org/pdf/2002.03438', landingPageUrl: '', license: null, version: 'submittedVersion', sourceName: 'arXiv', sourceType: 'repository', isOa: true },
        { pdfUrl: 'https://publisher.com/paper.pdf', landingPageUrl: '', license: 'cc-by', version: 'publishedVersion', sourceName: 'Publisher', sourceType: 'journal', isOa: true },
      ],
      raw: null,
    };
    const locs = aggregateLocations(oaWithArxiv, null, null, null);
    assert.equal(locs.length, 1);
    assert.equal(locs[0].url, 'https://publisher.com/paper.pdf');
  });

  test('arxiv URLs filtered out from unpaywall', () => {
    const upWithArxiv: UnpaywallResult = {
      status: 'success', doi: '10.1038/test', isOa: true,
      bestLocation: null,
      allLocations: [
        { url: 'https://arxiv.org/pdf/2002.03438', urlForPdf: 'https://arxiv.org/pdf/2002.03438', urlForLandingPage: '', license: null, version: 'submittedVersion', hostType: 'repository', repositoryInstitution: null },
        { url: 'https://doi.org/10.48550/arxiv.2002.03438', urlForPdf: null, urlForLandingPage: '', license: null, version: 'submittedVersion', hostType: 'repository', repositoryInstitution: null },
        { url: 'https://www.ncbi.nlm.nih.gov/pmc/articles/8302213', urlForPdf: 'https://www.ncbi.nlm.nih.gov/pmc/articles/8302213', urlForLandingPage: '', license: null, version: 'publishedVersion', hostType: 'repository', repositoryInstitution: null },
      ],
      raw: null,
    };
    const locs = aggregateLocations(null, upWithArxiv, null, null);
    assert.equal(locs.length, 1);
    assert.ok(locs[0].url.includes('ncbi.nlm.nih.gov'));
  });

  test('arxiv URLs filtered out from core', () => {
    const coreArxiv: CoreResult = {
      status: 'success', doi: '10.1038/test', coreId: '99',
      locations: [{ downloadUrl: 'http://arxiv.org/abs/2002.03438', sourceFulltextUrls: [], license: null, publisher: null, repositoryName: null }],
      raw: null,
    };
    const locs = aggregateLocations(null, null, coreArxiv, null);
    assert.equal(locs.length, 0);
  });

  test('all null → empty array', () => {
    const locs = aggregateLocations(null, null, null, null);
    assert.equal(locs.length, 0);
  });

  test('all not_found → empty array', () => {
    const oaNf: OpenAlexResult = { status: 'not_found', doi: null, openalexId: null, oaStatus: null, locations: [], raw: null };
    const upNf: UnpaywallResult = { status: 'not_found', doi: '10.1038/x', isOa: false, bestLocation: null, allLocations: [], raw: null };
    const coreNf: CoreResult = { status: 'not_found', doi: null, coreId: null, locations: [], raw: null };
    const pmcNf: PmcResult = { status: 'not_found', doi: '10.1038/x', pmcid: null, pmid: null, pdfUrl: null, license: null, raw: null };
    const locs = aggregateLocations(oaNf, upNf, coreNf, pmcNf);
    assert.equal(locs.length, 0);
  });

  test('deduplication NOT done (by design)', () => {
    // Same URL from two sources → both included
    const oaWithUrl: OpenAlexResult = {
      status: 'success', doi: '10.1038/test', openalexId: 'W1', oaStatus: 'gold',
      locations: [
        { pdfUrl: 'https://same-url.com/paper.pdf', landingPageUrl: '', license: 'cc-by', version: 'publishedVersion', sourceName: 'J', sourceType: 'journal', isOa: true },
      ],
      raw: null,
    };
    const upWithSameUrl: UnpaywallResult = {
      status: 'success', doi: '10.1038/test', isOa: true,
      bestLocation: { url: 'https://same-url.com/paper.pdf', urlForPdf: 'https://same-url.com/paper.pdf', urlForLandingPage: '', license: 'cc-by', version: 'publishedVersion', hostType: 'publisher', repositoryInstitution: null },
      allLocations: [
        { url: 'https://same-url.com/paper.pdf', urlForPdf: 'https://same-url.com/paper.pdf', urlForLandingPage: '', license: 'cc-by', version: 'publishedVersion', hostType: 'publisher', repositoryInstitution: null },
      ],
      raw: null,
    };
    const locs = aggregateLocations(oaWithUrl, upWithSameUrl, null, null);
    assert.equal(locs.length, 2); // Both kept — no dedup
  });
});

// ── mergeLicenseSources ──────────────────────────────────────
//
// Covers sub-bug surfaced 2026-05-04 by prod audit: first-write-wins merge
// stuck a closed unpaywall license even when a later unpaywall lookup
// returned an open variant. Most-permissive-per-source upgrade fixes it.

describe('mergeLicenseSources', () => {
  test('empty existing — every incoming source kept', () => {
    const merged = mergeLicenseSources({}, { unpaywall: 'CC-BY-4.0', openalex: 'CC-BY-NC-4.0' });
    assert.deepEqual(merged, { unpaywall: 'CC-BY-4.0', openalex: 'CC-BY-NC-4.0' });
  });

  test('first-write-wins when both existing and incoming are closed', () => {
    const merged = mergeLicenseSources({ unpaywall: 'CC-BY-NC-4.0' }, { unpaywall: 'CC-BY-NC-ND-4.0' });
    assert.equal(merged.unpaywall, 'CC-BY-NC-4.0');
  });

  test('open incoming UPGRADES closed existing per same source', () => {
    const merged = mergeLicenseSources({ unpaywall: 'CC-BY-NC-4.0' }, { unpaywall: 'CC-BY-4.0' });
    assert.equal(merged.unpaywall, 'CC-BY-4.0');
  });

  test('open existing NOT downgraded by closed incoming', () => {
    const merged = mergeLicenseSources({ unpaywall: 'CC-BY-4.0' }, { unpaywall: 'CC-BY-NC-4.0' });
    assert.equal(merged.unpaywall, 'CC-BY-4.0');
  });

  test('different sources kept separately', () => {
    const merged = mergeLicenseSources(
      { arxiv_oai: 'LicenseRef-arxiv-nonexclusive' },
      { unpaywall: 'CC-BY-4.0', openalex: 'CC-BY-NC-4.0' },
    );
    assert.deepEqual(merged, {
      arxiv_oai: 'LicenseRef-arxiv-nonexclusive',
      unpaywall: 'CC-BY-4.0',
      openalex: 'CC-BY-NC-4.0',
    });
  });

  test('open→open same source — keep existing (no preference between open variants)', () => {
    const merged = mergeLicenseSources({ unpaywall: 'CC-BY-SA-4.0' }, { unpaywall: 'CC-BY-4.0' });
    assert.equal(merged.unpaywall, 'CC-BY-SA-4.0');
  });
});

// ── shouldTriggerReindex ─────────────────────────────────────
//
// Covers main bug 2026-05-04: enricher reset abstract_only docs to
// 'downloaded' whenever it managed to fetch any file, regardless of
// whether the resulting effective license was open. Live audit found
// 3/14 reset cases were closed (CC-BY-NC-ND, arxiv-nonexclusive, NC-SA)
// and got pointlessly reprocessed back to abstract_only.

describe('shouldTriggerReindex', () => {
  test('abstract_only + files + open license → fire', () => {
    assert.equal(shouldTriggerReindex('abstract_only', 1, 'CC-BY-4.0'), true);
  });

  test('abstract_only + files + closed license → DO NOT fire (the bug case)', () => {
    assert.equal(shouldTriggerReindex('abstract_only', 1, 'CC-BY-NC-ND-4.0'), false);
    assert.equal(shouldTriggerReindex('abstract_only', 2, 'LicenseRef-arxiv-nonexclusive'), false);
    assert.equal(shouldTriggerReindex('abstract_only', 3, 'CC-BY-NC-SA-4.0'), false);
  });

  test('abstract_only + 0 files → DO NOT fire (nothing to serve)', () => {
    assert.equal(shouldTriggerReindex('abstract_only', 0, 'CC-BY-4.0'), false);
  });

  test('tier !== abstract_only → DO NOT fire (already full or null)', () => {
    assert.equal(shouldTriggerReindex('full', 5, 'CC-BY-4.0'), false);
    assert.equal(shouldTriggerReindex(null, 5, 'CC-BY-4.0'), false);
  });

  test('NOASSERTION effective → fire (unknown treated as permissive — matches computeIndexingTier)', () => {
    // computeIndexingTier returns 'full' for NOASSERTION (line 61, document-orchestrator.ts).
    // Reindex check stays consistent with that: if the runner would route the doc as full,
    // enricher should reset it for full re-process.
    assert.equal(shouldTriggerReindex('abstract_only', 1, 'NOASSERTION'), true);
  });

  test('CC-BY variants and CC0 fire correctly', () => {
    for (const lic of ['CC-BY-4.0', 'CC-BY-3.0', 'CC-BY-SA-4.0', 'CC0-1.0']) {
      assert.equal(shouldTriggerReindex('abstract_only', 1, lic), true, `expected fire for ${lic}`);
    }
  });

  test('NC/ND variants do not fire', () => {
    for (const lic of ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0', 'CC-BY-ND-4.0']) {
      assert.equal(shouldTriggerReindex('abstract_only', 1, lic), false, `expected NO fire for ${lic}`);
    }
  });
});
