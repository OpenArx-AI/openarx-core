/**
 * Live smoke test — real HTTP calls to all 4 source APIs.
 * Run manually: CORE_API_KEY=xxx npx tsx src/sources/__tests__/live-smoke.ts
 *
 * Uses real papers with published DOIs.
 * Verifies: correct URLs, response parsing, real data shapes.
 */

import { createOpenAlexClient } from '../openalex.js';
import { createUnpaywallClient } from '../unpaywall.js';
import { createPmcClient } from '../pmc.js';
import { createCoreClient } from '../core.js';

// AlphaFold paper — known OA, has PMC, has Unpaywall, published in Nature
const ALPHAFOLD_DOI = '10.1038/s41586-021-03819-2';
// Closed paper from our DB (no OA expected)
const CLOSED_DOI = '10.1117/12.2550651';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function testOpenAlex(): Promise<void> {
  console.log('\n══════ OpenAlex ══════');
  const client = createOpenAlexClient({ email: 'hello@openarx.ai' });

  console.log(`\n[1] lookupByDoi('${ALPHAFOLD_DOI}') — OA paper`);
  const r1 = await client.lookupByDoi(ALPHAFOLD_DOI);
  check('status = success', r1.status === 'success');
  check('doi extracted (no prefix)', r1.doi === ALPHAFOLD_DOI, `got: ${r1.doi}`);
  check('openalexId present', !!r1.openalexId);
  check('oaStatus is hybrid or gold', r1.oaStatus === 'hybrid' || r1.oaStatus === 'gold', `got: ${r1.oaStatus}`);
  check('has locations', r1.locations.length > 0, `got: ${r1.locations.length}`);
  const oaLoc = r1.locations.find(l => l.isOa && l.pdfUrl);
  check('has OA location with PDF URL', !!oaLoc, oaLoc ? `pdf: ${oaLoc.pdfUrl?.slice(0, 60)}` : 'none');
  check('OA location has license', !!oaLoc?.license, `got: ${oaLoc?.license}`);

  console.log(`\n[2] lookupByDoi('${CLOSED_DOI}') — closed paper`);
  const r2 = await client.lookupByDoi(CLOSED_DOI);
  check('status = success', r2.status === 'success');
  check('oaStatus = closed', r2.oaStatus === 'closed', `got: ${r2.oaStatus}`);

  console.log(`\n[3] lookupByDoi('10.9999/fake-openarx-test') — non-existent`);
  const r3 = await client.lookupByDoi('10.9999/fake-openarx-test');
  check('status = not_found', r3.status === 'not_found', `got: ${r3.status}`);
}

async function testUnpaywall(): Promise<void> {
  console.log('\n══════ Unpaywall ══════');
  const client = createUnpaywallClient({ email: 'hello@openarx.ai' });

  console.log(`\n[1] lookup('${ALPHAFOLD_DOI}') — OA paper`);
  const r1 = await client.lookup(ALPHAFOLD_DOI);
  check('status = success', r1.status === 'success');
  check('isOa = true', r1.isOa === true, `got: ${r1.isOa}`);
  check('bestLocation present', !!r1.bestLocation);
  check('bestLocation has URL', !!r1.bestLocation?.url, `got: ${r1.bestLocation?.url?.slice(0, 60)}`);
  check('bestLocation has license', !!r1.bestLocation?.license, `got: ${r1.bestLocation?.license}`);
  check('bestLocation has hostType', !!r1.bestLocation?.hostType, `got: ${r1.bestLocation?.hostType}`);
  check('bestLocation has version', !!r1.bestLocation?.version, `got: ${r1.bestLocation?.version}`);
  check('allLocations > 0', r1.allLocations.length > 0, `got: ${r1.allLocations.length}`);

  console.log(`\n[2] lookup('${CLOSED_DOI}') — closed paper`);
  const r2 = await client.lookup(CLOSED_DOI);
  check('status = success', r2.status === 'success');
  check('isOa = false', r2.isOa === false, `got: ${r2.isOa}`);

  console.log(`\n[3] lookup('10.9999/fake-openarx-test') — non-existent`);
  const r3 = await client.lookup('10.9999/fake-openarx-test');
  check('status = not_found', r3.status === 'not_found', `got: ${r3.status}`);
}

async function testPmc(): Promise<void> {
  console.log('\n══════ PMC ══════');
  const client = createPmcClient();

  console.log(`\n[1] lookup('${ALPHAFOLD_DOI}') — paper in PMC`);
  const r1 = await client.lookup(ALPHAFOLD_DOI);
  check('status = success', r1.status === 'success');
  check('pmcid starts with PMC', r1.pmcid?.startsWith('PMC') ?? false, `got: ${r1.pmcid}`);
  check('pmid present', !!r1.pmid, `got: ${r1.pmid}`);
  check('pdfUrl constructed', !!r1.pdfUrl?.includes('/pmc/articles/PMC'), `got: ${r1.pdfUrl}`);

  console.log(`\n[2] lookup('${CLOSED_DOI}') — paper NOT in PMC`);
  const r2 = await client.lookup(CLOSED_DOI);
  check('status = not_found', r2.status === 'not_found', `got: ${r2.status}`);

  console.log(`\n[3] lookup('10.9999/fake-openarx-test') — non-existent`);
  const r3 = await client.lookup('10.9999/fake-openarx-test');
  check('status = not_found', r3.status === 'not_found', `got: ${r3.status}`);
}

async function testCore(): Promise<void> {
  console.log('\n══════ CORE ══════');
  const apiKey = process.env.CORE_API_KEY;
  if (!apiKey) {
    console.log('  ⚠️  CORE_API_KEY not set, skipping');
    return;
  }
  const client = createCoreClient({ apiKey });

  console.log(`\n[1] lookup('${ALPHAFOLD_DOI}') — well-known paper`);
  const r1 = await client.lookup(ALPHAFOLD_DOI);
  console.log(`  status: ${r1.status}, coreId: ${r1.coreId}, locations: ${r1.locations.length}`);
  check('status is success or not_found', r1.status === 'success' || r1.status === 'not_found');
  // CORE coverage is spotty — not all DOIs are found

  console.log(`\n[2] lookup('10.9999/fake-openarx-test') — non-existent`);
  const r2 = await client.lookup('10.9999/fake-openarx-test');
  check('status = not_found', r2.status === 'not_found', `got: ${r2.status}`);
}

async function main(): Promise<void> {
  try {
    await testOpenAlex();
    await testUnpaywall();
    await testPmc();
    await testCore();
    console.log(`\n══════════════════════════`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log('🎉 All live smoke tests passed');
  } catch (err) {
    console.error('\n💥 CRASH:', err);
    process.exit(1);
  }
}

main();
