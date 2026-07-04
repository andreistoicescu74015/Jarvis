import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerLimits, LIMITS_DOC_DATE } from '../src/core/ai-limits.js';

test('ai-limits: documented ceilings resolve per tier and plan', () => {
  assert.deepEqual(providerLimits('low', 'free'), { rpm: 15, rpd: 150, tokensIn: 8000, tokensOut: 4000, concurrent: 5 });
  assert.deepEqual(providerLimits('high', 'enterprise'), { rpm: 15, rpd: 150, tokensIn: 16000, tokensOut: 8000, concurrent: 4 });
  assert.equal(providerLimits('LOW', ' Business ').rpd, 300); // tolerant of case/whitespace
});

test('ai-limits: defaults match the shipped model (gpt-4o-mini = low tier, Copilot Free)', () => {
  assert.equal(providerLimits().rpd, 150);
});

test('ai-limits: an unknown tier/plan resolves to undefined (the display just omits the line)', () => {
  assert.equal(providerLimits('custom', 'free'), undefined);
  assert.equal(providerLimits('low', 'trial'), undefined);
});

test('ai-limits: the doc date is stamped so the display can say how fresh the table is', () => {
  assert.match(LIMITS_DOC_DATE, /^\d{4}-\d{2}-\d{2}$/);
});
