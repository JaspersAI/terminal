import { app, ipcMain, systemPreferences } from 'electron'
import type { VoiceApi } from '../../shared/llm/providers'
import { post } from './http'
import { getProviderConfig, type ProviderConfig } from '../secrets'

// Speech to text through the configured voice provider. The renderer records with MediaRecorder
// (webm/opus) and sends the bytes over IPC; one request later the transcript comes back as text.

export async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<string> {
  const config = getProviderConfig('voice')
  if (!config) throw new Error('No voice provider configured.')
  const type = mimeType.split(';')[0] ?? 'audio/webm' // "audio/webm;codecs=opus" -> "audio/webm"
  const blob = new Blob([audio], { type })
  console.log(`[voice] ${audio.byteLength} bytes ${type} to ${config.provider.name} ${config.model}`)
  const text = (await request(config, blob, `recording.${type.split('/')[1] ?? 'webm'}`)).trim()
  console.log(`[voice] heard: ${text || '(nothing)'}`)
  return text
}

function request(config: ProviderConfig<'voice'>, blob: Blob, filename: string): Promise<string> {
  const { provider, baseUrl, model, token } = config
  const bearer: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  const form = (field: string): FormData => {
    const data = new FormData()
    data.append('file', blob, filename)
    data.append(field, model)
    return data
  }
  const api: VoiceApi = provider.api
  switch (api) {
    case 'openai':
      return post<{ text?: string }>(config, `${baseUrl}/audio/transcriptions`, bearer, form('model')).then(
        (r) => r.text ?? '',
      )
    case 'elevenlabs':
      return post<{ text?: string }>(
        config,
        `${baseUrl}/v1/speech-to-text`,
        { 'xi-api-key': token ?? '' },
        form('model_id'),
      ).then((r) => r.text ?? '')
    case 'cartesia':
      return post<{ text?: string }>(
        config,
        `${baseUrl}/stt`,
        { ...bearer, 'x-api-key': token ?? '', 'cartesia-version': '2026-08-14' },
        form('model'),
      ).then((r) => r.text ?? '')
    case 'deepgram': {
      const query = new URLSearchParams({ model, smart_format: 'true' })
      return post<{ results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } }>(
        config,
        `${baseUrl}/listen?${query}`,
        { authorization: `Token ${token ?? ''}`, 'content-type': blob.type },
        blob,
      ).then((r) => r.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '')
    }
  }
}

/** macOS asks once per app. Elsewhere the OS grants the mic without a prompt. */
async function requestMicrophone(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  // A fake capture device (the driver skill uses one) touches no hardware, so there is nothing to authorize.
  if (app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  console.log(`[voice] microphone access: ${status}`)
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone')
  return status !== 'denied' && status !== 'restricted'
}

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:request-microphone', () => requestMicrophone())
  ipcMain.handle('voice:transcribe', (_event, audio: unknown, mimeType: unknown) => {
    if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0) throw new Error('No audio recorded.')
    if (typeof mimeType !== 'string') throw new Error('Malformed audio type.')
    return transcribe(audio, mimeType)
  })
}
