/**
 * Message-shaping tests.
 *
 * These pin the two shape assumptions the bridge depends on: DSH appends its
 * own context blocks as extra `user` messages, and it states the tool workspace
 * in a system-reminder rather than anywhere structural.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  conversationKey,
  isInjectedContext,
  lastUserText,
  systemText,
  textOf,
  workdirOf,
} from '../src/message-shape.js'

const reminder = (dir) => `\n<system-reminder>\nCurrent working directory: "${dir}".\n</system-reminder>\n`
const skills = 'A skill is a reusable set of task-specific instructions.\n\n- cangjie-skill\n'
const titlePrompt = 'Generate the session title from this JSON array: ["hi"]'

test('textOf flattens string and part-array content', () => {
  assert.equal(textOf({ content: 'plain' }), 'plain')
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(textOf({ content: [{ type: 'image', url: 'x' }] }), '')
  assert.equal(textOf({}), '')
})

test('isInjectedContext recognises the three DSH blocks', () => {
  assert.equal(isInjectedContext(reminder('/tmp')), true)
  assert.equal(isInjectedContext(skills), true)
  assert.equal(isInjectedContext(titlePrompt), true)
  assert.equal(isInjectedContext('What is 17*23?'), false)
})

test('lastUserText skips injected context and returns the real question', () => {
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'What is 17*23?' },
    { role: 'user', content: reminder('/tmp/work') },
    { role: 'user', content: skills },
  ]
  assert.equal(lastUserText(messages), 'What is 17*23?')
})

test('lastUserText falls back to a probe when every user turn is injected', () => {
  assert.equal(lastUserText([{ role: 'user', content: reminder('/tmp') }]), 'Reply with exactly: PONG')
  assert.equal(lastUserText([]), 'Reply with exactly: PONG')
})

test('lastUserText keeps a later real question after an injected block', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'user', content: skills },
    { role: 'user', content: 'second' },
  ]
  assert.equal(lastUserText(messages), 'second')
})

test('systemText joins every system message and ignores the rest', () => {
  const messages = [
    { role: 'system', content: 'agent prompt' },
    { role: 'user', content: 'hi' },
    { role: 'system', content: titlePrompt },
  ]
  assert.equal(systemText(messages), `agent prompt\n\n${titlePrompt}`)
  assert.equal(systemText([{ role: 'user', content: 'hi' }]), '')
})

test('workdirOf reads the cwd out of the system-reminder', () => {
  const messages = [{ role: 'user', content: 'q' }, { role: 'user', content: reminder('/Users/x/proj') }]
  assert.equal(workdirOf(messages), '/Users/x/proj')
})

test('workdirOf falls back when no reminder is present', () => {
  assert.equal(workdirOf([{ role: 'user', content: 'q' }], '/fallback'), '/fallback')
})

test('conversationKey is stable per conversation and differs per workspace', () => {
  const messages = [
    { role: 'system', content: 'agent prompt' },
    { role: 'user', content: 'What is 17*23?' },
    { role: 'user', content: reminder('/tmp/a') },
  ]
  const later = [...messages, { role: 'assistant', content: '391' }, { role: 'user', content: 'and +1?' }]
  assert.equal(conversationKey(messages, '/tmp/a'), conversationKey(later, '/tmp/a'))
  assert.notEqual(conversationKey(messages, '/tmp/a'), conversationKey(messages, '/tmp/b'))
})

test('conversationKey ignores an injected block that arrives first', () => {
  const clean = [{ role: 'user', content: 'real question' }]
  const withInjected = [{ role: 'user', content: reminder('/tmp/a') }, { role: 'user', content: 'real question' }]
  assert.equal(conversationKey(clean, '/tmp/a'), conversationKey(withInjected, '/tmp/a'))
})
