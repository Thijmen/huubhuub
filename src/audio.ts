import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface Pcm {
  /** 16-bit little-endian mono samples. */
  data: Uint8Array
  sampleRate: number
}

export class AudioError extends Error {}

/**
 * Decode an AAC recording (`.m4a`, what the phone app records) to PCM with `faad`, which Amazon Transcribe
 * can take. A temp file, because faad needs to seek in MP4 files.
 */
export async function decodeAac(audio: Uint8Array, faad = "faad"): Promise<Pcm> {
  const dir = await mkdtemp(join(tmpdir(), "voice-"))
  try {
    const file = join(dir, "voice.m4a")
    await writeFile(file, audio)
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([faad, "-w", "-q", file], { stdout: "pipe", stderr: "pipe" })
    } catch {
      throw new AudioError("Voice notes from the app need faad on the server.")
    }
    const [wav, err, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).arrayBuffer(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    if (code !== 0) throw new AudioError(`Couldn't decode the recording: ${err.trim() || `faad exited with ${code}`}`)
    return parseWav(new Uint8Array(wav))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The samples of a 16-bit PCM WAV, mixed down to mono. Streamed WAVs have no sizes in their header, so the data runs to the end. */
export function parseWav(wav: Uint8Array): Pcm {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4))
  if (wav.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new AudioError("The decoded audio isn't a WAV file.")
  let channels = 1
  let sampleRate = 0
  let bits = 16
  let at = 12
  while (at + 8 <= wav.length) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true)
      sampleRate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (id === "data") {
      if (bits !== 16 || !sampleRate) throw new AudioError(`Unsupported audio (${bits}-bit, ${sampleRate} Hz).`)
      const end = size && at + 8 + size <= wav.length ? at + 8 + size : wav.length
      const data = wav.subarray(at + 8, end)
      return { data: channels === 1 ? data : mixDown(data, channels), sampleRate }
    }
    at += 8 + size + (size % 2)
  }
  throw new AudioError("The decoded audio has no samples.")
}

function mixDown(data: Uint8Array, channels: number): Uint8Array {
  const input = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const frames = Math.floor(data.byteLength / (2 * channels))
  const out = new Uint8Array(frames * 2)
  const view = new DataView(out.buffer)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += input.getInt16((f * channels + c) * 2, true)
    view.setInt16(f * 2, Math.round(sum / channels), true)
  }
  return out
}
