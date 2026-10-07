import { JASPERS_ACCOUNT, gatewayUrl } from '../app/jaspers.ts'
import type { ProviderInput, ProviderKind, ProviderSetting } from '../state'

/** Request shape for language models: Anthropic's Messages API, OpenAI's Responses API, or Chat Completions for everyone else. */
export type LlmApi = 'anthropic' | 'openai-responses' | 'openai'
/** Request shape for speech to text. */
export type VoiceApi = 'openai' | 'elevenlabs' | 'deepgram' | 'cartesia'
/** Request shape for web search: Brave's API, Jaspers' service answering in its own shape, or Bedrock's Web Search tool on the Responses API. */
export type SearchApi = 'brave' | 'jaspers' | 'bedrock'

export interface Provider<Api extends string = string> {
  id: string
  name: string
  /** One line under the name in the picker. */
  hint: string
  /** Which request shape main builds for this provider. */
  api: Api
  /** Default API base URL, editable by the user. Empty means the user has to supply one. */
  baseUrl: string
  /** Default model, editable by the user like the base URL. Empty means the user has to supply one. */
  model: string
  /** Where to create an API key. Opened in the system browser. */
  keyUrl?: string
  /** Keys from this provider start with this. Used to warn about a likely paste mistake, never to block. */
  tokenPrefix?: string
  tokenRequired: boolean
}

/**
 * Jaspers' own service, which serves every kind under the one sign-in with Jaspers: models through
 * OpenRouter, in OpenAI's shapes. The server is the jaspers-account repo; the base URL here is the
 * public gateway, and main follows Account's address instead when the environment names another.
 */
export const JASPERS = 'jaspers'
const JASPERS_URL = gatewayUrl(JASPERS_ACCOUNT)

/** Whether a provider's credential is the sign-in with Jaspers rather than a key the user pastes: Jaspers' own entries, which the sign-in serves together. */
export function signsIn(provider: Provider): boolean {
  return provider.id === JASPERS
}

export const PROVIDERS: { llm: Provider<LlmApi>[]; voice: Provider<VoiceApi>[]; search: Provider<SearchApi>[] } = {
  llm: [
    {
      id: JASPERS,
      name: 'Jaspers',
      hint: 'Models, voice, and web search with one sign-in',
      api: 'openai',
      baseUrl: JASPERS_URL,
      model: 'anthropic/claude-opus-5.5',
      tokenRequired: true,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      hint: 'Claude',
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5',
      keyUrl: 'https://console.anthropic.com/settings/keys',
      tokenPrefix: 'sk-ant-',
      tokenRequired: true,
    },
    {
      id: 'bedrock',
      name: 'Amazon Bedrock',
      hint: 'Claude, billed to an AWS account. The region is in the base URL.',
      api: 'anthropic',
      baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/anthropic',
      model: 'anthropic.claude-opus-4-8',
      keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
      tokenRequired: true,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      hint: 'GPT',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4',
      keyUrl: 'https://platform.openai.com/api-keys',
      tokenPrefix: 'sk-',
      tokenRequired: true,
    },
    {
      id: 'google',
      name: 'Google',
      hint: 'Gemini',
      api: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3.8-flash',
      keyUrl: 'https://aistudio.google.com/apikey',
      tokenPrefix: 'AIza',
      tokenRequired: true,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      hint: 'Many models, one key',
      api: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-opus-5.5',
      keyUrl: 'https://openrouter.ai/keys',
      tokenPrefix: 'sk-or-',
      tokenRequired: true,
    },
    {
      id: 'groq',
      name: 'Groq',
      hint: 'Fast open models',
      api: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.3-70b-versatile',
      keyUrl: 'https://console.groq.com/keys',
      tokenPrefix: 'gsk_',
      tokenRequired: true,
    },
    {
      id: 'xai',
      name: 'xAI',
      hint: 'Grok',
      api: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      keyUrl: 'https://console.x.ai',
      tokenPrefix: 'xai-',
      tokenRequired: true,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      hint: 'Local models, no key needed',
      api: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
      tokenRequired: false,
    },
    {
      id: 'custom',
      name: 'Custom',
      hint: 'Any OpenAI-compatible endpoint',
      api: 'openai',
      baseUrl: '',
      model: '',
      tokenRequired: false,
    },
  ],
  voice: [
    {
      id: JASPERS,
      name: 'Jaspers',
      hint: 'Comes with the Jaspers sign-in',
      api: 'openai',
      baseUrl: JASPERS_URL,
      model: 'openai/gpt-4o-mini-transcribe',
      tokenRequired: true,
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      hint: 'Speech to text and text to speech',
      api: 'elevenlabs',
      baseUrl: 'https://api.elevenlabs.io',
      model: 'scribe_v2',
      keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
      tokenRequired: true,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      hint: 'Whisper and TTS',
      api: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      keyUrl: 'https://platform.openai.com/api-keys',
      tokenPrefix: 'sk-',
      tokenRequired: true,
    },
    {
      id: 'deepgram',
      name: 'Deepgram',
      hint: 'Nova and Aura',
      api: 'deepgram',
      baseUrl: 'https://api.deepgram.com/v1',
      model: 'nova-3',
      keyUrl: 'https://console.deepgram.com',
      tokenRequired: true,
    },
    {
      id: 'cartesia',
      name: 'Cartesia',
      hint: 'Sonic and Ink',
      api: 'cartesia',
      baseUrl: 'https://api.cartesia.ai',
      model: 'ink-whisper',
      keyUrl: 'https://play.cartesia.ai/keys',
      tokenPrefix: 'sk_car_',
      tokenRequired: true,
    },
    {
      id: 'custom',
      name: 'Custom',
      hint: 'Any OpenAI-compatible audio endpoint',
      api: 'openai',
      baseUrl: '',
      model: 'whisper-1',
      tokenRequired: false,
    },
  ],
  // A search engine has no model: the field stays empty and the form hides it. Bedrock's search is a
  // model that searches, so it has one, and the form shows it.
  search: [
    {
      id: JASPERS,
      name: 'Jaspers',
      hint: 'Comes with the Jaspers sign-in',
      api: 'jaspers',
      baseUrl: JASPERS_URL,
      model: '',
      tokenRequired: true,
    },
    {
      id: 'brave',
      name: 'Brave Search',
      hint: 'Web search on your own key',
      api: 'brave',
      baseUrl: 'https://api.search.brave.com/res/v1',
      model: '',
      keyUrl: 'https://brave.com/search/api/',
      tokenPrefix: 'BSA',
      tokenRequired: true,
    },
    {
      id: 'bedrock',
      name: 'Amazon Bedrock',
      hint: 'Web Search on Bedrock, billed to an AWS account. The region is in the base URL.',
      api: 'bedrock',
      baseUrl: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
      model: 'openai.gpt-5.6-luna',
      keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
      tokenRequired: true,
    },
  ],
}

/** The provider type for a kind: `Provider<LlmApi>` for llm, `Provider<VoiceApi>` for voice. */
export type ProviderFor<K extends ProviderKind> = (typeof PROVIDERS)[K][number]

export function findProvider<K extends ProviderKind>(kind: K, id: string): ProviderFor<K> | undefined {
  return (PROVIDERS[kind] as ProviderFor<K>[]).find((p) => p.id === id)
}

/** Trim and drop trailing slashes so "https://host/v1/" and "https://host/v1" mean the same thing. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** The base URL and model a form shows for a provider: what is saved when it is the saved provider, else its defaults. */
export function providerFields(saved: ProviderSetting | null, provider: Provider): { baseUrl: string; model: string } {
  if (saved?.providerId === provider.id) return { baseUrl: saved.baseUrl, model: saved.model }
  return { baseUrl: provider.baseUrl, model: provider.model }
}

/** A provider as main stores it: the token sealed, or none. */
interface SavedProvider {
  providerId: string
  baseUrl: string
  model: string
  token: string | null
}

/** The Jaspers provider as the sign-in sets it up: its defaults, with no key, since the sign-in is the credential. */
export function jaspersSetting(kind: ProviderKind): SavedProvider {
  const provider = findProvider(kind, JASPERS)!
  return { providerId: JASPERS, baseUrl: provider.baseUrl, model: provider.model, token: null }
}

/**
 * What signing in with Jaspers sets up: Jaspers for every kind the user has no provider for, so a
 * new user gets the model, voice, and web search in one step. A provider already chosen is the
 * user's and stays, so signing in later from Settings changes none of them.
 */
export function withJaspersWhereNone<T extends SavedProvider>(providers: {
  llm: T | null
  voice: T | null
  search: T | null
}): { llm: T | null; voice: T | null; search: T | null } {
  const fill = (kind: ProviderKind): T | null => providers[kind] ?? (jaspersSetting(kind) as T)
  return { llm: fill('llm'), voice: fill('voice'), search: fill('search') }
}

/**
 * The voice setting to keep once `llm` is saved. The Jaspers sign-in serves voice as well, so a
 * language model on Jaspers sets voice up on the same service, keeping the voice model if voice was
 * on Jaspers already. Voice on another provider is the user's choice and stays.
 */
export function voiceWith<T extends { providerId: string; baseUrl: string; model: string }>(
  llm: T,
  voice: T | null,
): T | null {
  if (llm.providerId !== JASPERS || (voice !== null && voice.providerId !== JASPERS)) return voice
  return { ...llm, model: voice?.model ?? findProvider('voice', JASPERS)!.model }
}

/**
 * The search setting to keep once `llm` is saved, the way `voiceWith` keeps voice: the Jaspers
 * sign-in serves search as well, so a language model on Jaspers sets search up on the same service.
 * Search on another provider is the user's choice and stays.
 */
export function searchWith<T extends { providerId: string; baseUrl: string; model: string }>(
  llm: T,
  search: T | null,
): T | null {
  if (llm.providerId !== JASPERS || (search !== null && search.providerId !== JASPERS)) return search
  return { ...llm, model: '' }
}

/** Whether a provider runs on a model the user names: every one does but a search engine, which has none. */
export function takesModel(kind: ProviderKind, provider: Provider): boolean {
  return kind !== 'search' || provider.model !== ''
}

/** Whether saving a form would change anything: compared the way main stores it, and a key typed in always would. */
export function providerChanged(saved: ProviderSetting | null, input: ProviderInput): boolean {
  if (saved?.providerId !== input.providerId) return true
  return (
    normalizeBaseUrl(input.baseUrl) !== saved.baseUrl || input.model.trim() !== saved.model || input.token.trim() !== ''
  )
}

/** What the user already has, for a form that asks for nothing twice: a key saved for this provider, and the sign-in with Jaspers. */
export interface Credentials {
  savedToken?: boolean
  signedIn?: boolean
}

/**
 * Hard validation. Runs in the renderer for feedback and again in main before saving. A saved key
 * lets an empty token pass for its provider; the Jaspers provider takes no key at all, and needs the
 * sign-in instead.
 */
export function validateProviderInput(kind: ProviderKind, input: ProviderInput, has: Credentials = {}): string | null {
  const provider = findProvider(kind, input.providerId)
  if (!provider) return 'Unknown provider.'
  if (!isHttpUrl(input.baseUrl)) return 'Base URL must be a full http:// or https:// URL.'
  if (takesModel(kind, provider) && !input.model.trim()) return `${provider.name} needs a model name.`
  if (signsIn(provider)) return has.signedIn ? null : `Sign in with Jaspers to use ${provider.name}.`
  if (provider.tokenRequired && !input.token && !has.savedToken) return `${provider.name} needs an API key.`
  return null
}

/** Soft heuristic: warn when the key does not look like one from this provider. Never blocks. */
export function tokenWarning(provider: Provider, token: string): string | null {
  if (!token || !provider.tokenPrefix || token.startsWith(provider.tokenPrefix)) return null
  return `${provider.name} keys usually start with "${provider.tokenPrefix}". Check that you pasted the right one.`
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Whether a request to this provider marks its prompt for caching. OpenRouter caches an Anthropic
 * model's prompt only where the request asks, and Jaspers' own service is OpenRouter behind the sign-in;
 * the models that cache on their own ignore the marks. Every other Chat Completions provider caches
 * by prefix on its own or not at all, and some refuse a field they do not know.
 */
export function marksCache(provider: Provider<LlmApi>): boolean {
  return provider.id === JASPERS || provider.id === 'openrouter'
}
