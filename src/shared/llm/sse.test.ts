import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sseFrames, sseTail, SSE_DONE } from './sse.ts'

test('a frame ends at a blank line, and what is left over waits for the next chunk', () => {
  const first = sseFrames('event: ping\ndata: {"a":1}\n\ndata: {"b":2')
  assert.deepEqual(first.data, ['{"a":1}'])
  assert.equal(first.rest, 'data: {"b":2')
  // The rest is fed back in front of what arrives next, which is how a payload split mid-JSON survives.
  const second = sseFrames(`${first.rest}}\n\n`)
  assert.deepEqual(second.data, ['{"b":2}'])
  assert.equal(second.rest, '')
})

test('several frames in one chunk all come out, in order', () => {
  const { data, rest } = sseFrames('data: one\n\ndata: two\n\ndata: three\n\n')
  assert.deepEqual(data, ['one', 'two', 'three'])
  assert.equal(rest, '')
})

test('CRLF reads the same as LF, including a CRLF split across two chunks', () => {
  assert.deepEqual(sseFrames('data: {"a":1}\r\n\r\n').data, ['{"a":1}'])
  const first = sseFrames('data: {"a":1}\r')
  assert.deepEqual(first.data, [])
  assert.deepEqual(sseFrames(`${first.rest}\n\r\n`).data, ['{"a":1}'])
})

test('only data lines are the payload; a comment, a name, and a keep-alive are not', () => {
  assert.deepEqual(sseFrames(': keep alive\n\n').data, [])
  assert.deepEqual(sseFrames('event: message\nid: 7\nretry: 100\n\n').data, [])
  // Two data lines in one frame join with a newline, which is what the format says they mean.
  assert.deepEqual(sseFrames('data: one\ndata: two\n\n').data, ['one\ntwo'])
})

test('one space after the colon is the format, and a second space is the value', () => {
  assert.deepEqual(sseFrames('data:{"a":1}\n\n').data, ['{"a":1}'])
  assert.deepEqual(sseFrames('data:  padded\n\n').data, [' padded'])
})

test('a stream that ends without its blank line still gives up its last frame', () => {
  assert.equal(sseTail('data: {"last":true}'), '{"last":true}')
  assert.equal(sseTail('\n'), null)
  assert.equal(sseTail(`data: ${SSE_DONE}`), SSE_DONE)
})
