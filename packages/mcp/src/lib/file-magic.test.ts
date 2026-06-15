/**
 * openarx-contracts-xuqi: upload magic-byte detection + PUT-time acceptance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, checkUploadMagic } from './file-magic.js';

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
const PDF = Buffer.from('%PDF-1.7\n', 'latin1');
const TEX = Buffer.from('\\documentclass{article}', 'latin1');
const MD = Buffer.from('# Heading\n', 'latin1');
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]); // PNG-ish, has NUL

test('detectKind classifies zip / pdf / text / binary', () => {
  assert.equal(detectKind(ZIP), 'zip');
  assert.equal(detectKind(PDF), 'pdf');
  assert.equal(detectKind(TEX), 'text');
  assert.equal(detectKind(MD), 'text');
  assert.equal(detectKind(BINARY), 'binary');
});

test('declared application/zip enforces ZIP signature', () => {
  assert.equal(checkUploadMagic(ZIP, 'application/zip'), null);
  assert.ok(checkUploadMagic(PDF, 'application/zip')); // mismatch → reason string
  assert.ok(checkUploadMagic(TEX, 'application/zip'));
});

test('declared application/pdf enforces PDF signature', () => {
  assert.equal(checkUploadMagic(PDF, 'application/pdf'), null);
  assert.ok(checkUploadMagic(ZIP, 'application/pdf'));
});

test('text content types are permissive (accept text, zip, pdf)', () => {
  for (const ct of ['text/x-tex', 'text/markdown', null]) {
    assert.equal(checkUploadMagic(TEX, ct), null);
    assert.equal(checkUploadMagic(MD, ct), null);
    assert.equal(checkUploadMagic(ZIP, ct), null);
    assert.equal(checkUploadMagic(PDF, ct), null);
  }
});

test('opaque binary with no declared type is rejected', () => {
  assert.ok(checkUploadMagic(BINARY, null));
  assert.ok(checkUploadMagic(BINARY, 'text/x-tex'));
});
