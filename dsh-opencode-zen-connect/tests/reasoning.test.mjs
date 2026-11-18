/**
 * Reasoning metadata tests: OpenCode variants -> pi-ai reasoning fields.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reasoningFromVariants, THINKING_LEVELS } from '../src/reasoning.js'

test('a model with no variants is non-reasoning', () => {
  assert.deepEqual(reasoningFromVariants(undefined), { reasoning: false })
  assert.deepEqual(reasoningFromVariants(null), { reasoning: false })
  assert.deepEqual(reasoningFromVariants({}), { reasoning: false })
})

test('deepseek-v4.1-flash-free exposes only low/high/max', () => {
  const result = reasoningFromVariants({ low: {}, high: {}, max: {} })
  assert.equal(result.reasoning, true)
  assert.equal(result.thinkingLevelMap.low, 'low')
  assert.equal(result.thinkingLevelMap.high, 'high')
  assert.equal(result.thinkingLevelMap.max, 'max')
  // Unsupported levels must be pinned to null (otherwise pi-ai treats them
  // as "supported, use default" for minimal/low/medium/high).
  assert.equal(result.thinkingLevelMap.minimal, null)
  assert.equal(result.thinkingLevelMap.medium, null)
  assert.equal(result.thinkingLevelMap.xhigh, null)
})

test('a full-spectrum model maps every level to itself', () => {
  const variants = Object.fromEntries(THINKING_LEVELS.map(level => [level, {}]))
  const result = reasoningFromVariants(variants)
  assert.equal(result.reasoning, true)
  for (const level of THINKING_LEVELS) {
    assert.equal(result.thinkingLevelMap[level], level)
  }
})

test('off is not configured so the opencode default variant is used', () => {
  const result = reasoningFromVariants({ none: {}, high: {} })
  assert.equal(Object.prototype.hasOwnProperty.call(result.thinkingLevelMap, 'off'), false)
  assert.equal(result.thinkingLevelMap.high, 'high')
  // "none" is not a pi thinking level, so it does not appear.
  assert.equal(Object.prototype.hasOwnProperty.call(result.thinkingLevelMap, 'none'), false)
})
