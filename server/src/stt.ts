// Speech-to-text for push-to-talk. G2 mic = PCM s16le, 16 kHz, mono. We wrap it in a WAV header and
// send it to any OpenAI-compatible /audio/transcriptions endpoint (OpenAI Whisper, Groq, local whisper.cpp server...).
const BASE = process.env.STT_BASE_URL ?? 'https://api.openai.com/v1'
const KEY = process.env.STT_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
const MODEL = process.env.STT_MODEL ?? 'whisper-1'

export const sttEnabled = Boolean(KEY) || /localhost|127\.0\.0\.1/.test(BASE)

export function pcmToWav(pcm: Uint8Array, sampleRate = 16000, channels = 1, bits = 16): Uint8Array {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, (sampleRate * channels * bits) / 8, true)
  v.setUint16(32, (channels * bits) / 8, true); v.setUint16(34, bits, true)
  w(36, 'data'); v.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header), 0)
  out.set(pcm, 44)
  return out
}

export async function transcribe(pcm: Uint8Array): Promise<string> {
  if (!sttEnabled) throw new Error('voice off: set STT_API_KEY or STT_BASE_URL on server')
  if (pcm.length < 3200) throw new Error('too short - hold while you speak')
  const form = new FormData()
  form.append('file', new Blob([pcmToWav(pcm) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'speech.wav')
  form.append('model', MODEL)
  form.append('language', 'en')
  form.append('prompt', 'Crypto trading commands: alert bitcoin above 60k, long ETH 100 dollars, bet yes 20, reply on it, show funding, Hyperliquid, Polymarket, Telegram.')
  const res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: KEY ? { authorization: `Bearer ${KEY}` } : {}, body: form })
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 120)}`)
  const j = (await res.json()) as { text?: string }
  return (j.text ?? '').trim()
}
