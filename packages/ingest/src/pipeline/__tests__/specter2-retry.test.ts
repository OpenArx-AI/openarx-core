import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpecter2Retryable } from '../workers.js';

// ── Retryable: pool exhaustion / capacity messages ───────────────────

test('502 from embed-service is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 502: bad gateway')), true);
});

test('503 service unavailable is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 503: service unavailable')), true);
});

test('504 gateway timeout is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 504: gateway timeout')), true);
});

test('"no available SPECTER2 servers" body is retryable', () => {
  assert.equal(
    isSpecter2Retryable(new Error('embed-service 502: {"detail":"No available SPECTER2 servers (waited 60s, all at capacity or down)"}')),
    true,
  );
});

test('"all at capacity" message is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('all at capacity')), true);
});

// ── Retryable: connection-level (defensive) ──────────────────────────

test('ECONNREFUSED is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('connect ECONNREFUSED 127.0.0.1:3400')), true);
});

test('socket hang up is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('socket hang up')), true);
});

test('fetch failed is retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('fetch failed')), true);
});

// ── NOT retryable: 4xx and unknown ───────────────────────────────────

test('400 bad request is NOT retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 400: invalid input')), false);
});

test('401 unauthorized is NOT retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 401: unauthorized')), false);
});

test('404 not found is NOT retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('embed-service 404: model not found')), false);
});

test('generic JS error is NOT retryable', () => {
  assert.equal(isSpecter2Retryable(new Error('TypeError: cannot read property of undefined')), false);
});

test('non-Error value is NOT retryable', () => {
  assert.equal(isSpecter2Retryable('something weird'), false);
  assert.equal(isSpecter2Retryable(null), false);
  assert.equal(isSpecter2Retryable(undefined), false);
});
