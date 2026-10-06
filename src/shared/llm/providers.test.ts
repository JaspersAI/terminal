import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findProvider,
  marksCache,
  providerChanged,
  providerFields,
  searchWith,
  signsIn,
  takesModel,
  validateProviderInput,
  voiceWith,
  withJaspersWhereNone,
} from './providers.ts'
import type { ProviderSetting } from '../state.ts'

const SAVED: ProviderSetting = {
  providerId: 'ollama',
  baseUrl: 'http://gpu-box:11434/v1',
  model: 'qwen3',
  hasToken: false,
}
const OLLAMA = findProvider('llm', 'ollama')!
const ANTHROPIC = findProvider('llm', 'anthropic')!

test('a form shows what is saved for the saved provider, and the defaults for any other', () => {
  assert.deepEqual(providerFields(SAVED, OLLAMA), { baseUrl: 'http://gpu-box:11434/v1', model: 'qwen3' })
  assert.deepEqual(providerFields(SAVED, ANTHROPIC), { baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5' })
  assert.deepEqual(providerFields(null, OLLAMA), { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' })
})

test('a form holds no change while it reads as what main would store', () => {
  const same = { providerId: 'ollama', baseUrl: ' http://gpu-box:11434/v1/ ', model: 'qwen3 ', token: '  ' }
  assert.equal(providerChanged(SAVED, same), false)
})

test('another provider, base URL, or model is a change, and so is a key to store', () => {
  const same = { providerId: 'ollama', baseUrl: 'http://gpu-box:11434/v1', model: 'qwen3', token: '' }
  assert.equal(providerChanged(SAVED, { ...same, providerId: 'anthropic' }), true)
  assert.equal(providerChanged(SAVED, { ...same, baseUrl: 'http://localhost:11434/v1' }), true)
  assert.equal(providerChanged(SAVED, { ...same, model: 'llama3.2' }), true)
  assert.equal(providerChanged(SAVED, { ...same, token: 'sk-new' }), true)
})

test('anything is a change when nothing is saved yet', () => {
  assert.equal(
    providerChanged(null, { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', token: '' }),
    true,
  )
})

test('Amazon Bedrock is the Messages endpoint, with the region in its base URL', () => {
  const bedrock = findProvider('llm', 'bedrock')!
  // The same request shape as Anthropic's own, which is what that endpoint serves.
  assert.equal(bedrock.api, 'anthropic')
  assert.equal(bedrock.baseUrl, 'https://bedrock-mantle.us-east-1.api.aws/anthropic')
  assert.equal(
    validateProviderInput('llm', {
      providerId: 'bedrock',
      baseUrl: 'https://bedrock-mantle.eu-west-1.api.aws/anthropic',
      model: 'anthropic.claude-sonnet-5',
      token: 'a-bedrock-token',
    }),
    null,
  )
})

const JASPERS_LLM = {
  providerId: 'jaspers',
  baseUrl: 'https://account.jsprai.com/v1',
  model: 'z-ai/glm-5.3',
  token: 'sealed-key',
}

test('a Jaspers key saved as the language model sets voice up with it', () => {
  assert.deepEqual(voiceWith(JASPERS_LLM, null), {
    providerId: 'jaspers',
    baseUrl: 'https://account.jsprai.com/v1',
    model: 'openai/gpt-4o-mini-transcribe',
    token: 'sealed-key',
  })
  // Voice already on Jaspers keeps its model, and takes the new key and address.
  const before = { providerId: 'jaspers', baseUrl: 'http://127.0.0.1:3350/v1', model: 'openai/whisper-1', token: 'old' }
  assert.deepEqual(voiceWith(JASPERS_LLM, before), { ...JASPERS_LLM, model: 'openai/whisper-1' })
})

test('voice on another provider stays, and any other language model leaves voice alone', () => {
  const elevenlabs = { providerId: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', model: 'scribe_v2', token: 'x' }
  assert.equal(voiceWith(JASPERS_LLM, elevenlabs), elevenlabs)
  const anthropic = {
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    token: 'y',
  }
  assert.equal(voiceWith(anthropic, null), null)
  const jaspersVoice = voiceWith(JASPERS_LLM, null)
  assert.equal(voiceWith(anthropic, jaspersVoice), jaspersVoice)
})

test('Jaspers is one address for both kinds, takes no key, and needs the sign-in', () => {
  assert.equal(findProvider('llm', 'jaspers')!.baseUrl, findProvider('voice', 'jaspers')!.baseUrl)
  assert.equal(signsIn(findProvider('llm', 'jaspers')!), true)
  assert.equal(signsIn(ANTHROPIC), false)
  const input = { providerId: 'jaspers', baseUrl: 'https://account.jsprai.com/v1', model: 'openai/gpt-5.4', token: '' }
  assert.equal(validateProviderInput('llm', input), 'Sign in with Jaspers to use Jaspers.')
  // A key pasted anyway is not what Jaspers takes: the sign-in is, and nothing else makes it valid.
  assert.equal(validateProviderInput('llm', { ...input, token: 'eyJ…' }), 'Sign in with Jaspers to use Jaspers.')
  assert.equal(validateProviderInput('llm', input, { savedToken: true }), 'Sign in with Jaspers to use Jaspers.')
  assert.equal(validateProviderInput('llm', input, { signedIn: true }), null)
  // Every other provider is as it was: a key, pasted or saved.
  const anthropic = { providerId: 'anthropic', baseUrl: ANTHROPIC.baseUrl, model: ANTHROPIC.model, token: '' }
  assert.equal(validateProviderInput('llm', anthropic, { signedIn: true }), 'Anthropic needs an API key.')
  assert.equal(validateProviderInput('llm', anthropic, { savedToken: true }), null)
})

test('signing in sets Jaspers up wherever the user has no provider, and leaves every chosen one alone', () => {
  const none = { llm: null, voice: null, search: null }
  assert.deepEqual(withJaspersWhereNone(none), {
    llm: { providerId: 'jaspers', baseUrl: 'https://account.jsprai.com/v1', model: 'z-ai/glm-5.3', token: null },
    voice: {
      providerId: 'jaspers',
      baseUrl: 'https://account.jsprai.com/v1',
      model: 'openai/gpt-4o-mini-transcribe',
      token: null,
    },
    search: { providerId: 'jaspers', baseUrl: 'https://account.jsprai.com/v1', model: '', token: null },
  })
  const anthropic = {
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    token: 'y',
  }
  const brave = { providerId: 'brave', baseUrl: 'https://api.search.brave.com/res/v1', model: '', token: 'b' }
  const filled = withJaspersWhereNone({ llm: anthropic, voice: null, search: brave })
  assert.equal(filled.llm, anthropic)
  assert.equal(filled.search, brave)
  assert.equal(filled.voice!.providerId, 'jaspers')
})

test('a request through OpenRouter marks its prompt for caching; the other providers cache on their own or not at all', () => {
  assert.equal(marksCache(findProvider('llm', 'jaspers')!), true)
  assert.equal(marksCache(findProvider('llm', 'openrouter')!), true)
  assert.equal(marksCache(OLLAMA), false)
  assert.equal(marksCache(findProvider('llm', 'google')!), false)
  assert.equal(marksCache(ANTHROPIC), false)
})

test('a Jaspers key saved as the language model sets web search up with it, and leaves another search provider alone', () => {
  assert.deepEqual(searchWith(JASPERS_LLM, null), {
    providerId: 'jaspers',
    baseUrl: 'https://account.jsprai.com/v1',
    model: '',
    token: 'sealed-key',
  })
  const brave = { providerId: 'brave', baseUrl: 'https://api.search.brave.com/res/v1', model: '', token: 'b' }
  assert.equal(searchWith(JASPERS_LLM, brave), brave)
  const anthropic = {
    providerId: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    token: 'y',
  }
  assert.equal(searchWith(anthropic, null), null)
})

test('a search provider needs a key and no model', () => {
  const brave = findProvider('search', 'brave')!
  assert.equal(brave.api, 'brave')
  assert.equal(takesModel('search', brave), false)
  const input = { providerId: 'brave', baseUrl: brave.baseUrl, model: '', token: '' }
  assert.equal(validateProviderInput('search', input), 'Brave Search needs an API key.')
  assert.equal(validateProviderInput('search', { ...input, token: 'BSA-key' }), null)
  assert.equal(findProvider('search', 'jaspers')!.baseUrl, findProvider('llm', 'jaspers')!.baseUrl)
})

test('Amazon Bedrock searches through a model, so it is the search provider that needs one', () => {
  const bedrock = findProvider('search', 'bedrock')!
  assert.equal(bedrock.api, 'bedrock')
  // The same host the language model is on, at the path that serves the Responses API.
  assert.equal(bedrock.baseUrl, 'https://bedrock-mantle.us-east-1.api.aws/openai/v1')
  assert.equal(takesModel('search', bedrock), true)
  const input = { providerId: 'bedrock', baseUrl: bedrock.baseUrl, model: '', token: 'a-bedrock-key' }
  assert.equal(validateProviderInput('search', input), 'Amazon Bedrock needs a model name.')
  assert.equal(validateProviderInput('search', { ...input, model: bedrock.model }), null)
  assert.equal(takesModel('llm', OLLAMA), true)
})
