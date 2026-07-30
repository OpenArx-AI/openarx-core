import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackends } from '../tei-fleet-supervisor.js';

test('parseBackends: localPort:host:sshPort with optional maxConcurrency', () => {
  const out = parseBackends('8000:gpu-host-a.example:22001,8001:gpu-host-b.example:22002:12');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { localPort: 8000, sshHost: 'gpu-host-a.example', sshPort: 22001 });
  assert.deepEqual(out[1], { localPort: 8001, sshHost: 'gpu-host-b.example', sshPort: 22002, maxConcurrency: 12 });
});

test('parseBackends: tolerates spaces + trailing comma', () => {
  const out = parseBackends(' 8000:h:1 , 8001:h:2 ,');
  assert.equal(out.length, 2);
  assert.equal(out[1].sshPort, 2);
});

test('parseBackends: rejects malformed tokens (never silently drops a GPU)', () => {
  assert.throws(() => parseBackends('8000:onlytwo'), /want localPort/);
  assert.throws(() => parseBackends('notanum:h:1'), /bad localPort/);
  assert.throws(() => parseBackends('8000:h:notanum'), /bad sshPort/);
  assert.throws(() => parseBackends('8000::1'), /empty sshHost/);
  assert.throws(() => parseBackends('8000:h:1:0'), /bad maxConcurrency/);
});
