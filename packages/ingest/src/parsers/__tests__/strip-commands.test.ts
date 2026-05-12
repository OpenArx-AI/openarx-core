/**
 * TDD tests for stripCommands() in latex-parser.ts.
 *
 * Run: node --test --import tsx packages/ingest/src/parsers/__tests__/strip-commands.test.ts
 * Or:  pnpm --filter @openarx/ingest test:strip
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommands } from '../latex-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, 'strip-fixtures.json');

interface Fixture {
  name: string;
  input: string;
  expected: string;
  note: string;
}

const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

describe('stripCommands', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.note}`, () => {
      const result = stripCommands(fixture.input).trim();
      const expected = fixture.expected.trim();
      assert.equal(result, expected, `\nInput:    ${JSON.stringify(fixture.input)}\nExpected: ${JSON.stringify(expected)}\nGot:      ${JSON.stringify(result)}`);
    });
  }
});
