import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Turn } from '../../shared/llm/llm.ts'
import {
  anthropicRequest,
  anthropicStream,
  readAnthropic,
  refusedExtra,
  systemBlocks,
  type Extra,
  allowedMax,
  replyCap,
} from './anthropic.ts'
import { openaiBody, openaiStream, readOpenai } from './openai.ts'
import { readResponse, responsesBody, responsesStream } from './responses.ts'
import { sent as asSent } from '../../shared/agent/aside.ts'

// Items as the Responses API returns them for a reasoning model that calls a tool.
const REASONING = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'gAAAA-sealed' }
const SAID = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'Checking the views.', annotations: [] }],
}
const CALL = {
  id: 'fc_1',
  type: 'function_call',
  status: 'completed',
  call_id: 'call_1',
  name: 'get',
  arguments: '{"path":"views"}',
}
const GET = {
  name: 'get',
  description: 'Read the app by path.',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}

test('a Responses request carries the prompt as instructions, the reply items back as they came, and the tool result after them', () => {
  const history: Turn[] = [
    { role: 'user', text: 'What views are there?' },
    {
      role: 'assistant',
      text: 'Checking the views.',
      toolCalls: [{ id: 'call_1', name: 'get', input: { path: 'views' } }],
      raw: [REASONING, SAID, CALL],
    },
    { role: 'tool', results: [{ callId: 'call_1', output: '["core/note"]', isError: false }] },
  ]
  assert.deepEqual(responsesBody('gpt-5.6-luna', 'You arrange the grid.', history, [GET], true), {
    model: 'gpt-5.6-luna',
    instructions: 'You arrange the grid.',
    input: [
      { role: 'user', content: 'What views are there?' },
      REASONING,
      SAID,
      CALL,
      { type: 'function_call_output', call_id: 'call_1', output: '["core/note"]' },
    ],
    store: false,
    include: ['reasoning.encrypted_content'],
    tools: [
      {
        type: 'function',
        name: 'get',
        description: 'Read the app by path.',
        parameters: GET.parameters,
        strict: false,
      },
    ],
  })
})

test('an assistant turn with nothing to replay is rebuilt; a token cap is sent, and reasoning is left out when asked', () => {
  const history: Turn[] = [
    {
      role: 'assistant',
      text: 'Focusing it.',
      toolCalls: [{ id: 'call_9', name: 'focus', input: { id: 'e1' } }],
      raw: null,
    },
  ]
  assert.deepEqual(responsesBody('gpt-4.1', 'S', history, [], false), {
    model: 'gpt-4.1',
    instructions: 'S',
    input: [
      { role: 'assistant', content: 'Focusing it.' },
      { type: 'function_call', call_id: 'call_9', name: 'focus', arguments: '{"id":"e1"}' },
    ],
    store: false,
  })
})

test('a Responses reply reads as its text, calls by call id, why it stopped, usage, and every item to send back', () => {
  const broken = { type: 'function_call', call_id: 'call_2', name: 'set', arguments: '{"path":' }
  assert.deepEqual(
    readResponse({
      status: 'completed',
      output: [REASONING, SAID, CALL, broken],
      usage: { input_tokens: 812, output_tokens: 64 },
    }),
    {
      text: 'Checking the views.',
      toolCalls: [
        { id: 'call_1', name: 'get', input: { path: 'views' } },
        { id: 'call_2', name: 'set', input: {} },
      ],
      stopReason: 'completed',
      usage: { input: 812, output: 64, cacheRead: 0, cacheWrite: 0 },
      raw: [REASONING, SAID, CALL, broken],
    },
  )
  const cut = readResponse({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [
      {
        type: 'message',
        content: [
          { type: 'output_text', text: 'Part one' },
          { type: 'output_text', text: ' goes on.' },
        ],
      },
      { type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
    ],
  })
  assert.equal(cut.text, 'Part one goes on.\n\nI cannot help with that.')
  assert.equal(cut.stopReason, 'max_output_tokens')
  assert.deepEqual(readResponse({}), {
    text: '',
    toolCalls: [],
    stopReason: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    raw: [],
  })
})

test('the system prompt of a tool loop is marked for caching at its end, and a single question is not', () => {
  // Nothing in it changes from round to round any more: what does rides on the turns instead.
  assert.deepEqual(
    systemBlocks(['fixed instructions', 'what is installed'], true).map((block) => Boolean(block.cache_control)),
    [false, true],
  )
  // A question asked once has nobody to read the cache back, and writing it costs a quarter more.
  assert.deepEqual(
    systemBlocks(['everything'], false).map((b) => Boolean(b.cache_control)),
    [false],
  )
})

const NONE: ReadonlySet<Extra> = new Set()
const LOOP = { loop: true, effort: 'medium' } as const

test('in a tool loop the state a turn rode with follows it as a message of its own, cleared by the next, and the conversation is marked for caching before it', () => {
  const history: Turn[] = [
    { role: 'user', text: 'Chart FLWS.', context: 'grid: empty' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'tu_1', name: 'place_view', input: { view: 'core/chart' } }],
      raw: [{ type: 'tool_use', id: 'tu_1', name: 'place_view', input: { view: 'core/chart' } }],
    },
    { role: 'tool', results: [{ callId: 'tu_1', output: '{"elementId":"e1"}', isError: false }], context: 'grid: e1' },
  ]
  const { body, betas, sent } = anthropicRequest('claude-opus-5', ['S'], history, [GET], LOOP, NONE, 32_000)
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Chart FLWS.' }] },
    {
      role: 'system',
      clear_at: 'next_user_message',
      content: '<workspace_state>\ngrid: empty\n</workspace_state>',
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'place_view', input: { view: 'core/chart' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: '{"elementId":"e1"}',
          is_error: undefined,
          // The state message takes no mark, so the mark is on the last thing before it.
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    { role: 'system', clear_at: 'next_user_message', content: '<workspace_state>\ngrid: e1\n</workspace_state>' },
  ])
  assert.deepEqual(body.thinking, { type: 'adaptive' })
  assert.deepEqual(body.output_config, { effort: 'medium' })
  assert.equal(body.fallbacks, 'default')
  assert.equal(body.max_tokens, 32_000)
  // Nothing asks the provider to clear old tool results: the conversation goes whole.
  assert.equal(body.context_management, undefined)
  assert.deepEqual(betas, ['mid-conversation-system-clear-at-2026-08-21', 'server-side-fallback-2026-07-01'])
  assert.deepEqual(sent, ['thinking', 'effort', 'turn-state', 'fallbacks'])
})

test('where that message is refused the state goes in the turn itself, kept, and again only when it has changed', () => {
  const result = (id: string): Turn => ({
    role: 'tool',
    results: [{ callId: id, output: 'ok', isError: false }],
    context: id === 'tu_2' ? 'grid: e1, e2' : 'grid: e1',
  })
  const called = (id: string): Turn => ({
    role: 'assistant',
    text: '',
    toolCalls: [{ id, name: 'get', input: {} }],
    raw: [{ type: 'tool_use', id, name: 'get', input: {} }],
  })
  const history: Turn[] = [
    { role: 'user', text: 'Two charts.', context: 'grid: e1' },
    called('tu_1'),
    result('tu_1'),
    called('tu_2'),
    result('tu_2'),
  ]
  const off = new Set<Extra>(['turn-state'])
  const { body, betas } = anthropicRequest('claude-sonnet-5', ['S'], history, [GET], LOOP, off, 32_000)
  const messages = body.messages as { role: string; content: { type: string; text?: string }[] }[]
  assert.equal(
    messages.some((message) => message.role === 'system'),
    false,
  )
  const states = messages.map((message) => message.content.filter((block) => block.text?.includes('workspace_state')))
  // The user's turn carries it; the first result saw the same grid and says nothing; the second saw another.
  assert.deepEqual(
    states.map((found) => found.length),
    [1, 0, 0, 0, 1],
  )
  assert.equal(states[4]![0]!.text, '<workspace_state>\ngrid: e1, e2\n</workspace_state>')
  // The mark is on the last block of the conversation, which here is the state: it is kept, so it is prefix.
  assert.deepEqual(messages[4]!.content.at(-1), {
    type: 'text',
    text: '<workspace_state>\ngrid: e1, e2\n</workspace_state>',
    cache_control: { type: 'ephemeral' },
  })
  assert.equal(betas.includes('mid-conversation-system-clear-at-2026-08-21'), false)
})

test('a state message is left out where the turn after it is not the assistant, which the provider refuses', () => {
  const history: Turn[] = [
    { role: 'user', text: 'Earlier, summarized.', context: 'grid: old' },
    { role: 'user', text: 'And now?', context: 'grid: new' },
  ]
  const { body } = anthropicRequest('claude-opus-5', ['S'], history, [], LOOP, NONE, 32_000)
  const roles = (body.messages as { role: string }[]).map((message) => message.role)
  assert.deepEqual(roles, ['user', 'user', 'system'])
})

test('a single question is the plain request it always was', () => {
  const history: Turn[] = [{ role: 'user', text: 'Summarize this.' }]
  const { body, betas, sent } = anthropicRequest('claude-opus-5', ['S'], history, [], {}, NONE, 16_000)
  assert.deepEqual(body, {
    model: 'claude-opus-5',
    max_tokens: 16_000,
    system: [{ type: 'text', text: 'S' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this.' }] }],
  })
  assert.deepEqual(betas, [])
  assert.deepEqual(sent, [])
})

test('an assistant turn with nothing left to say still says something, since an empty one is refused', () => {
  const history: Turn[] = [
    { role: 'user', text: 'Hi.' },
    { role: 'assistant', text: '', toolCalls: [], raw: null },
    { role: 'user', text: 'Hello?' },
  ]
  const { body } = anthropicRequest('claude-opus-5', ['S'], history, [], {}, NONE, 16_000)
  assert.deepEqual((body.messages as { content: unknown }[])[1]!.content, [{ type: 'text', text: '(no reply)' }])
})

test('thinking is summarized only for a caller that reads it', () => {
  const history: Turn[] = [{ role: 'user', text: 'Hi.' }]
  const reading = { ...LOOP, onThinking: () => {} }
  const { body } = anthropicRequest('claude-opus-5', ['S'], history, [], reading, NONE, 32_000)
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
})

test("a reply's cap is the adapter's own, raised by a caller that needs more room and never lowered by one", () => {
  assert.equal(replyCap(undefined, true), 64_000)
  assert.equal(replyCap(undefined, false), 16_000)
  // The builder asks for at least 16,000: where there is already more room than that, it keeps it.
  assert.equal(replyCap(16_000, true), 64_000)
  assert.equal(replyCap(100_000, true), 100_000)
  // A model that said how much it allows is asked for no more than that.
  assert.equal(replyCap(16_000, true, 32_000), 32_000)
  assert.equal(replyCap(undefined, false, 32_000), 16_000)
})

test('a model that allows less says how much, and anything else it refuses is not about the cap', () => {
  assert.equal(
    allowedMax(
      'Anthropic returned 400: max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1',
    ),
    32_000,
  )
  assert.equal(allowedMax('Anthropic returned 400: prompt is too long: 1200000 tokens > 1000000 maximum'), null)
  assert.equal(allowedMax('Anthropic returned 529: overloaded'), null)
})

test('what a model or a proxy refuses is named by its refusal, and only among what was sent', () => {
  const sent: Extra[] = ['thinking', 'effort', 'turn-state', 'fallbacks']
  const refused = (detail: string, among = sent): Extra | null =>
    refusedExtra(`Anthropic returned 400: ${detail}`, among)
  assert.equal(refused("thinking: Input tag 'adaptive' found using 'type' does not match"), 'thinking')
  assert.equal(refused('output_config.effort requires a model that supports it'), 'effort')
  assert.equal(refused("role 'system' is not supported on this model"), 'turn-state')
  assert.equal(refused('messages.1.clear_at: Extra inputs are not permitted'), 'turn-state')
  assert.equal(
    refused('Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header'),
    'fallbacks',
  )
  // A refusal about something else is not one of these, and nor is one about what was never sent.
  assert.equal(refused('prompt is too long: 1200000 tokens > 1000000 maximum'), null)
  assert.equal(refused('thinking: unsupported', ['effort']), null)
  // A thinking block tied to a conversation that has changed is about the history, not the request.
  assert.equal(refused('messages.5.content.0: Invalid `signature` in `thinking` block.'), null)
  assert.equal(refusedExtra('Anthropic returned 429: thinking too hard', sent), null)
})

test('what the prompt cache served and took is counted into the prompt, which is what was read', () => {
  const reply = readAnthropic({
    content: [{ type: 'text', text: 'Hi.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
  })
  assert.deepEqual(reply.usage, { input: 9340, output: 5, cacheRead: 9000, cacheWrite: 300 })
})

// Streaming. The readers put a stream back together as the one reply the whole-response path would
// have parsed, so what is checked here is the assembly: the text as it arrives, the tool call's
// arguments across the pieces they come in, and what the round cost.

test('the Messages stream rebuilds each content block as it would have been sent whole', () => {
  const deltas: string[] = []
  const thoughts: string[] = []
  const reader = anthropicStream(
    (delta) => deltas.push(delta),
    (delta) => thoughts.push(delta),
  )
  for (const event of [
    { type: 'message_start', message: { usage: { input_tokens: 1200, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Which view' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Opening ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the chart.' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'place_view', input: {} },
    },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"view":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"core/chart"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 95 } },
  ]) {
    reader.push(event)
  }
  // Only the text is offered as the reply: thinking goes to whoever asked for it, and arguments are not words.
  assert.deepEqual(deltas, ['Opening ', 'the chart.'])
  assert.deepEqual(thoughts, ['Which view'])
  const reply = readAnthropic(reader.done())
  assert.equal(reply.text, 'Opening the chart.')
  assert.deepEqual(reply.toolCalls, [{ id: 'tu_1', name: 'place_view', input: { view: 'core/chart' } }])
  assert.equal(reply.stopReason, 'tool_use')
  // Input comes with the message, output is cumulative, so the last one is the total.
  assert.deepEqual(reply.usage, { input: 1200, output: 95, cacheRead: 0, cacheWrite: 0 })
  // The blocks go back verbatim next round, so the thinking block has to carry its signature.
  assert.deepEqual(reply.raw, [
    { type: 'thinking', thinking: 'Which view', signature: 'sig-abc' },
    { type: 'text', text: 'Opening the chart.' },
    { type: 'tool_use', id: 'tu_1', name: 'place_view', input: { view: 'core/chart' } },
  ])
})

test('a Chat Completions stream joins the content and the arguments a tool call arrives in', () => {
  const deltas: string[] = []
  const reader = openaiStream((delta) => deltas.push(delta))
  for (const event of [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'One moment' }, finish_reason: null }] },
    // The id and the name come with the first piece; the arguments come in pieces after it.
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get', arguments: '' } }] } },
      ],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"views"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40 } },
  ]) {
    reader.push(event)
  }
  assert.deepEqual(deltas, ['One moment'])
  const reply = readOpenai(reader.done())
  assert.equal(reply.text, 'One moment')
  assert.deepEqual(reply.toolCalls, [{ id: 'call_1', name: 'get', input: { path: 'views' } }])
  assert.equal(reply.stopReason, 'tool_calls')
  assert.deepEqual(reply.usage, { input: 900, output: 40, cacheRead: 0, cacheWrite: 0 })
  assert.equal(reply.raw, null)
})

test('a Chat Completions stream says what the model is thinking, where its provider sends that', () => {
  const thoughts: string[] = []
  const reader = openaiStream(undefined, undefined, (delta) => thoughts.push(delta))
  for (const event of [
    // OpenRouter sends a thought twice in one piece, as a string and in its details: it is said once.
    {
      choices: [
        {
          delta: {
            content: '',
            reasoning: 'The guide ',
            reasoning_details: [{ type: 'reasoning.text', text: 'The guide ', format: 'unknown', index: 0 }],
          },
        },
      ],
    },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'lists the fields.' }] } }] },
    // The string alone, where that is all there is.
    { choices: [{ delta: { reasoning: ' Next, the screen.' } }] },
    // Sealed thinking has no words to say, whatever stands in for them.
    {
      choices: [
        { delta: { reasoning: '[REDACTED]', reasoning_details: [{ type: 'reasoning.encrypted', data: 'eyJ' }] } },
      ],
    },
    { choices: [{ delta: { reasoning: '', reasoning_details: [] } }] },
    { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] },
  ]) {
    reader.push(event)
  }
  assert.deepEqual(thoughts, ['The guide ', 'lists the fields.', ' Next, the screen.'])
  // The thinking is shown and not kept: the reply is its words.
  const reply = readOpenai(reader.done())
  assert.deepEqual([reply.text, reply.raw], ['Done.', null])
  // Nobody listening changes nothing.
  const quiet = openaiStream()
  quiet.push({ choices: [{ delta: { reasoning: 'A thought.' } }] })
  assert.equal(readOpenai(quiet.done()).text, '')
})

test('two tool calls in one Chat Completions stream keep their own arguments, in the order they were asked for', () => {
  const reader = openaiStream()
  for (const event of [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'focus', arguments: '{"id":' } }] } }] },
    {
      choices: [
        { delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'remove_element', arguments: '{"id":' } }] } },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"e2"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"e1"}' } }] } }] },
  ]) {
    reader.push(event)
  }
  assert.deepEqual(readOpenai(reader.done()).toolCalls, [
    { id: 'a', name: 'focus', input: { id: 'e1' } },
    { id: 'b', name: 'remove_element', input: { id: 'e2' } },
  ])
})

test('the Responses stream follows the text and takes the whole response off the event that ends it', () => {
  const deltas: string[] = []
  const reader = responsesStream((delta) => deltas.push(delta))
  for (const event of [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Checking ' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'the views.' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [REASONING, SAID, CALL],
        usage: { input_tokens: 800, output_tokens: 30 },
      },
    },
  ]) {
    reader.push(event)
  }
  assert.deepEqual(deltas, ['Checking ', 'the views.'])
  const reply = readResponse(reader.done())
  assert.equal(reply.text, 'Checking the views.')
  assert.deepEqual(reply.toolCalls, [{ id: 'call_1', name: 'get', input: { path: 'views' } }])
  // The reasoning item is on the turn verbatim, encrypted content and all, or the next round refuses it.
  assert.deepEqual(reply.raw, [REASONING, SAID, CALL])
  assert.deepEqual(reply.usage, { input: 800, output: 30, cacheRead: 0, cacheWrite: 0 })
})

test('a stream that fails part way through says so rather than answering with half a reply', () => {
  const anthropic = anthropicStream()
  anthropic.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  assert.throws(
    () => anthropic.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    /Overloaded/,
  )
  const responses = responsesStream()
  assert.throws(() => responses.push({ type: 'error', message: 'The model is busy.' }), /The model is busy/)
})

// The state a turn rode with, on the protocols with no message of its own for it. Only the newest is
// said, at the very end, so everything before it is the same on every request and the provider's
// own prefix cache can serve it.

const PLACED: Turn[] = [
  { role: 'user', text: 'Chart FLWS.', context: 'grid: empty' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'get', input: { path: 'views' } }], raw: null },
  { role: 'tool', results: [{ callId: 'call_1', output: '["core/chart"]', isError: false }], context: 'grid: e1' },
]

test('a Chat Completions request says only the newest state, after everything else', () => {
  const body = openaiBody('gpt-4.1', 'S', PLACED, [], undefined)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Chart FLWS.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get', arguments: '{"path":"views"}' } }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '["core/chart"]\n\n<workspace_state>\ngrid: e1\n</workspace_state>',
    },
  ])
  const asked = openaiBody('gpt-4.1', 'S', PLACED.slice(0, 1), [], undefined)
  assert.deepEqual((asked.messages as unknown[])[1], {
    role: 'user',
    content: 'Chart FLWS.\n\n<workspace_state>\ngrid: empty\n</workspace_state>',
  })
})

test('a Responses request says only the newest state, and thinks as hard as it was asked to', () => {
  const body = responsesBody('gpt-5.4', 'S', PLACED, [], true, 'medium')
  assert.deepEqual((body.input as unknown[]).at(-1), {
    type: 'function_call_output',
    call_id: 'call_1',
    output: '["core/chart"]\n\n<workspace_state>\ngrid: e1\n</workspace_state>',
  })
  assert.deepEqual((body.input as unknown[])[0], { role: 'user', content: 'Chart FLWS.' })
  assert.deepEqual(body.reasoning, { effort: 'medium' })
  // The ladder is shorter there: what is above high asks for high.
  assert.deepEqual(responsesBody('gpt-5.4', 'S', PLACED, [], true, 'max').reasoning, { effort: 'high' })
  // A model that does not reason is not asked how hard to.
  assert.equal('reasoning' in responsesBody('gpt-4.1', 'S', PLACED, [], false, 'medium'), false)
})

test('what a provider hangs on a tool call goes back on it, since it may refuse the call without', () => {
  const signed = {
    id: 'call_1',
    type: 'function',
    function: { name: 'get', arguments: '{"path":"views"}' },
    extra_content: { google: { thought_signature: 'sig-xyz' } },
  }
  const reply = readOpenai({
    choices: [{ message: { content: null, tool_calls: [signed] }, finish_reason: 'tool_calls' }],
  })
  assert.deepEqual(reply.raw, [signed])
  const history: Turn[] = [
    { role: 'user', text: 'What views?' },
    { role: 'assistant', text: '', toolCalls: reply.toolCalls, raw: reply.raw },
  ]
  const sent = (openaiBody('gemini-3.8-flash', 'S', history, [], undefined).messages as { tool_calls?: unknown[] }[])[2]
  assert.deepEqual(sent!.tool_calls, [signed])

  // The same arrives in a stream on the piece that opens the call.
  const reader = openaiStream()
  reader.push({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'get', arguments: '{"path":"views"}' },
              extra_content: { google: { thought_signature: 'sig-xyz' } },
            },
          ],
        },
      },
    ],
  })
  assert.deepEqual(readOpenai(reader.done()).raw, [
    {
      id: 'call_1',
      function: { name: 'get', arguments: '{"path":"views"}' },
      extra_content: { google: { thought_signature: 'sig-xyz' } },
    },
  ])
})

test('what a provider served from its cache is said beside the prompt it is part of', () => {
  const chat = readOpenai({
    choices: [{ message: { content: 'Hi.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4096 } },
  })
  assert.deepEqual(chat.usage, { input: 5000, output: 3, cacheRead: 4096, cacheWrite: 0 })
  const responses = readResponse({
    status: 'completed',
    output: [],
    usage: { input_tokens: 5000, output_tokens: 3, input_tokens_details: { cached_tokens: 4096 } },
  })
  assert.deepEqual(responses.usage, { input: 5000, output: 3, cacheRead: 4096, cacheWrite: 0 })
})

test('through OpenRouter a tool loop asks for automatic caching and marks the system prompt; a plain provider gets neither', () => {
  const marked = openaiBody('anthropic/claude-opus', 'S', PLACED, [], undefined, true)
  assert.deepEqual(marked.cache_control, { type: 'ephemeral' })
  assert.deepEqual((marked.messages as unknown[])[0], {
    role: 'system',
    content: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }],
  })
  const plain = openaiBody('gpt-4.1', 'S', PLACED, [], undefined, false)
  assert.equal('cache_control' in plain, false)
  assert.deepEqual((plain.messages as unknown[])[0], { role: 'system', content: 'S' })
})

test('what OpenRouter served from its cache and wrote to it is read into the usage', () => {
  const { usage } = readOpenai({
    choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 10339,
      completion_tokens: 60,
      prompt_tokens_details: { cached_tokens: 10318, cache_write_tokens: 21 },
    },
  })
  assert.deepEqual(usage, { input: 10339, output: 60, cacheRead: 10318, cacheWrite: 21 })
})

// What the user added while a run was at work: a user turn straight after a round's results, with
// the round's state riding on it rather than on the results.
const STEERED: Turn[] = [
  { role: 'user', text: 'Chart FLWS.', context: 'grid: empty' },
  PLACED[1]!,
  { role: 'tool', results: [{ callId: 'call_1', output: '["core/chart"]', isError: false }] },
  { role: 'user', text: 'Use two years.', context: 'grid: e1' },
]

test('what the user added after a round goes to Chat Completions as a user message after the result, with the state', () => {
  const body = openaiBody('gpt-4.1', 'S', STEERED, [], undefined)
  assert.deepEqual((body.messages as unknown[]).slice(-2), [
    { role: 'tool', tool_call_id: 'call_1', content: '["core/chart"]' },
    { role: 'user', content: 'Use two years.\n\n<workspace_state>\ngrid: e1\n</workspace_state>' },
  ])
})

test('what the user added after a round goes to Responses as a user item after the call\u2019s output, with the state', () => {
  const body = responsesBody('gpt-5.4', 'S', STEERED, [], true, 'medium')
  assert.deepEqual((body.input as unknown[]).slice(-2), [
    { type: 'function_call_output', call_id: 'call_1', output: '["core/chart"]' },
    { role: 'user', content: 'Use two years.\n\n<workspace_state>\ngrid: e1\n</workspace_state>' },
  ])
})

test('what the user added after a round goes to Messages in the same user message as the results: results first, then the words', () => {
  const history: Turn[] = [
    STEERED[0]!,
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'tu_1', name: 'get', input: {} }],
      raw: [{ type: 'tool_use', id: 'tu_1', name: 'get', input: {} }],
    },
    { role: 'tool', results: [{ callId: 'tu_1', output: 'ok', isError: false }] },
    STEERED[3]!,
    { role: 'user', text: 'And add SPY.', context: 'grid: e1' },
  ]
  type Block = { type: string; text?: string }
  // Where the state is a message of its own: one user message for the round, and this round's state last.
  const asMessage = anthropicRequest('claude-opus-5', ['S'], history.slice(0, 4), [GET], LOOP, NONE, 32_000).body
    .messages as { role: string; content: unknown }[]
  assert.deepEqual(
    asMessage.map((message) => message.role),
    ['user', 'system', 'assistant', 'user', 'system'],
  )
  assert.deepEqual(
    (asMessage[3]!.content as Block[]).map((block) => [block.type, block.text]),
    [
      ['tool_result', undefined],
      ['text', 'Use two years.'],
    ],
  )
  assert.match(asMessage[4]!.content as string, /grid: e1/)
  // Where it is refused: the results, the words, then the state, all in the one message. Two added
  // in the same round are both in it, in order.
  const inline = anthropicRequest(
    'claude-sonnet-5',
    ['S'],
    history,
    [GET],
    LOOP,
    new Set<Extra>(['turn-state']),
    32_000,
  ).body.messages as { role: string; content: Block[] }[]
  assert.deepEqual(
    inline.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(
    inline[2]!.content.map((block) => [block.type, block.text?.split('\n')[0]]),
    [
      ['tool_result', undefined],
      ['text', 'Use two years.'],
      ['text', '<workspace_state>'],
      ['text', 'And add SPY.'],
    ],
  )
  // Two user turns that follow no round stay two messages, as they were.
  const plain: Turn[] = [
    { role: 'user', text: 'one' },
    { role: 'user', text: 'two' },
  ]
  const two = anthropicRequest('claude-sonnet-5', ['S'], plain, [], LOOP, new Set<Extra>(['turn-state']), 32_000).body
    .messages as { role: string }[]
  assert.deepEqual(
    two.map((message) => message.role),
    ['user', 'user'],
  )
})

test('each stream says the call the model starts writing, once, by its tool', () => {
  const call = (index: number, fn: Record<string, string>, id?: string): Record<string, unknown> => ({
    choices: [{ index: 0, delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: fn }] } }],
  })
  const chat: string[] = []
  const completions = openaiStream(undefined, (name) => chat.push(name))
  for (const event of [
    call(0, { name: 'build_plugin', arguments: '' }, 'call_1'),
    call(0, { arguments: '{"request"' }),
    call(0, { arguments: ':"a feed"}' }),
    // A second call in the same reply is its own.
    call(1, { name: 'get', arguments: '{}' }, 'call_2'),
  ]) {
    completions.push(event)
  }
  assert.deepEqual(chat, ['build_plugin', 'get'])
  assert.deepEqual(readOpenai(completions.done()).toolCalls, [
    { id: 'call_1', name: 'build_plugin', input: { request: 'a feed' } },
    { id: 'call_2', name: 'get', input: {} },
  ])

  const blocks: string[] = []
  const messages = anthropicStream(undefined, undefined, (name) => blocks.push(name))
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Build it.' } },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'build_plugin', input: {} },
    },
    // The input comes once it is whole, however long that took: the start is all there is to go by.
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"request"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"a feed"}' } },
    { type: 'content_block_stop', index: 1 },
  ]) {
    messages.push(event)
  }
  assert.deepEqual(blocks, ['build_plugin'])

  const items: string[] = []
  const responses = responsesStream(undefined, (name) => items.push(name))
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'build_plugin', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"request"' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':"a feed"}' },
  ]) {
    responses.push(event)
  }
  assert.deepEqual(items, ['build_plugin'])
})

test('a streamed request asks Messages for a call\u2019s input as it is written, and one read whole does not', () => {
  const history: Turn[] = [{ role: 'user', text: 'Build it.', context: 'grid: empty' }]
  const tools = (options: object, off: ReadonlySet<Extra> = NONE): { eager_input_streaming?: boolean }[] =>
    anthropicRequest('claude-opus-5', ['S'], history, [GET], options, off, 32_000).body.tools as {
      eager_input_streaming?: boolean
    }[]
  // Held back until each value is whole, a long call is minutes of a stream with not one byte in it.
  const streamed = anthropicRequest('claude-opus-5', ['S'], history, [GET], { ...LOOP, stream: true }, NONE, 32_000)
  assert.deepEqual(streamed.sent, ['thinking', 'effort', 'turn-state', 'fallbacks', 'call-input'])
  assert.deepEqual(
    tools({ ...LOOP, stream: true }).map((tool) => tool.eager_input_streaming),
    [true],
  )
  // Read whole there is no silence to break, and the provider checks the input before it sends it.
  assert.equal(tools(LOOP)[0]?.eager_input_streaming, undefined)
  // Refused once, it is left off, like any extra.
  assert.equal(tools({ ...LOOP, stream: true }, new Set<Extra>(['call-input']))[0]?.eager_input_streaming, undefined)
  assert.equal(
    refusedExtra('Anthropic returned 400: tools.0.custom.eager_input_streaming: Extra inputs are not permitted', [
      'thinking',
      'call-input',
    ]),
    'call-input',
  )
})

// What the loop hands a protocol is a thread as it is sent (`shared/agent/aside.ts`). These hold the
// two together: a turn rebuilt for sending has to leave on the wire the way it was rebuilt.
const LONG = 'q'.repeat(900)
const ANSWER = 'r'.repeat(5_000)

/** A finished request and the one at work, each with a call whose argument and answer are long, on one protocol's own payloads. */
function twoRequests(raw: (id: string) => unknown[]): Turn[] {
  const round = (id: string): Turn[] => [
    { role: 'assistant', text: 'Looking.', toolCalls: [{ id, name: 'get', input: { path: LONG } }], raw: raw(id) },
    { role: 'tool', results: [{ callId: id, output: ANSWER, isError: false }], context: `grid after ${id}` },
  ]
  return [
    { role: 'user', text: 'First.', context: 'grid: then' },
    ...round('c1'),
    { role: 'assistant', text: 'Done.', toolCalls: [], raw: null },
    { role: 'user', text: 'Second.', context: 'grid: now' },
    ...round('c2'),
  ]
}

/** The conversation as each protocol writes it, split where the request at work begins. */
function onTheWire(
  raw: (id: string) => unknown[],
  write: (turns: Turn[]) => unknown,
): { earlier: string; atWork: string } {
  const wire = JSON.stringify(write(asSent(twoRequests(raw), { asked: 4, aside: 4 })))
  const at = wire.indexOf('Second.')
  return { earlier: wire.slice(0, at), atWork: wire.slice(at) }
}

const PROTOCOLS: { name: string; sealed: string; raw: (id: string) => unknown[]; write: (turns: Turn[]) => unknown }[] =
  [
    {
      name: 'Messages',
      sealed: 'sig-abc',
      raw: (id) => [
        { type: 'thinking', thinking: 'hm', signature: 'sig-abc' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id, name: 'get', input: { path: LONG } },
      ],
      write: (turns) => anthropicRequest('claude-opus-5', ['S'], turns, [GET], LOOP, NONE, 32_000).body.messages,
    },
    {
      name: 'Responses',
      sealed: 'gAAAA-sealed',
      raw: (id) => [
        { ...REASONING, id: `rs_${id}` },
        { ...SAID, id: `msg_${id}`, content: [{ type: 'output_text', text: 'Looking.', annotations: [] }] },
        { ...CALL, id: `fc_${id}`, call_id: id, arguments: JSON.stringify({ path: LONG }) },
      ],
      write: (turns) => responsesBody('gpt-5.6-luna', 'S', turns, [GET], true).input,
    },
    {
      name: 'Chat Completions',
      sealed: 'sig-xyz',
      raw: (id) => [
        {
          id,
          type: 'function',
          function: { name: 'get', arguments: JSON.stringify({ path: LONG }) },
          extra_content: { google: { thought_signature: 'sig-xyz' } },
        },
      ],
      write: (turns) => openaiBody('gemini-3.8-flash', 'S', turns, [], undefined).messages,
    },
  ]

for (const { name, sealed, raw, write } of PROTOCOLS) {
  test(`an earlier request leaves on ${name} as its words and calls: its long argument cut, its long answer a note, nothing the provider tied to it`, () => {
    const { earlier } = onTheWire(raw, write)
    assert.ok(earlier.includes('First.') && earlier.includes('Looking.') && earlier.includes('Done.'))
    assert.ok(!earlier.includes(LONG), 'the long argument is cut short')
    assert.ok(earlier.includes('900 characters, set aside'))
    assert.ok(!earlier.includes(ANSWER), 'the long answer is a note')
    assert.ok(earlier.includes('Set aside: 5,000 characters'))
    assert.ok(!earlier.includes(sealed), "the provider's own payload stays with the request it was written in")
    assert.ok(
      !earlier.includes('grid: then') && !earlier.includes('grid after c1'),
      'the state it rode with was only true then',
    )
  })

  test(`the request at work leaves on ${name} as the provider wrote it, whole`, () => {
    const { atWork } = onTheWire(raw, write)
    assert.ok(atWork.includes(LONG))
    assert.ok(atWork.includes(ANSWER))
    assert.ok(atWork.includes(sealed))
    assert.ok(atWork.includes('grid after c2'))
  })
}
