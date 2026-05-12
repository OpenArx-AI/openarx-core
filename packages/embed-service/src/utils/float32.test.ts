import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { bufferToVector, vectorToBuffer } from './float32.js';

test('float32: round-trip preserves values', () => {
  const v = [0, 1, -1, 0.5, -0.5, 3.14159, 1e-6, 1e6];
  const buf = vectorToBuffer(v);
  assert.equal(buf.length, v.length * 4);
  const back = bufferToVector(buf, v.length);
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) {
    // float32 precision — near-equality only
    assert.ok(Math.abs(back[i] - v[i]) < 1e-5, `idx ${i}: ${back[i]} vs ${v[i]}`);
  }
});

test('float32: 3072d vector = 12288 bytes', () => {
  const v = new Array(3072).fill(0).map((_, i) => Math.sin(i));
  const buf = vectorToBuffer(v);
  assert.equal(buf.length, 12288);
});

test('float32: wrong buffer size throws', () => {
  assert.throws(() => bufferToVector(Buffer.alloc(10), 768));
});
