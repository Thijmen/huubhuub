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
 * can take. faad's own MP4 reader trips over common layouts (64-bit boxes, `co64`, newer sound entries) and
 * then exits without output, so the AAC frames are taken out of the MP4 here and handed to faad as ADTS.
 */
export async function decodeAac(audio: Uint8Array, faad = "faad"): Promise<Pcm> {
  const adts = isAdts(audio) ? audio : mp4ToAdts(audio)
  const dir = await mkdtemp(join(tmpdir(), "voice-"))
  try {
    const file = join(dir, "voice.aac")
    await writeFile(file, adts)
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
    // faad can fail and still exit 0, so no output is a failure too.
    if (code !== 0 || !wav.byteLength) throw new AudioError(`Couldn't decode the recording: ${err.trim() || `faad exited with ${code}`}`)
    return parseWav(new Uint8Array(wav))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const isAdts = (b: Uint8Array) => b.length > 7 && b[0] === 0xff && (b[1]! & 0xf6) === 0xf0

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

interface Box {
  type: string
  /** Where the contents start and end, after the header. */
  start: number
  end: number
}

function boxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7))
    let header = 8
    if (size === 1) {
      if (at + 16 > end) break
      size = Number(view.getBigUint64(at + 8))
      header = 16
    } else if (size === 0) size = end - at
    if (size < header) break
    // A recording cut short has a last box that runs past the end; keep what is there.
    out.push({ type, start: at + header, end: Math.min(at + size, end) })
    at += size
  }
  return out
}

/**
 * The AAC frames of the first sound track of an MP4, each with an ADTS header, so they can be decoded
 * without an MP4 reader.
 */
export function mp4ToAdts(mp4: Uint8Array): Uint8Array {
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength)
  const top = boxes(view, 0, mp4.length)
  if (top[0]?.type !== "ftyp") throw new AudioError("The recording isn't an MP4 or AAC file.")
  const child = (box: Box | undefined, type: string) => (box ? boxes(view, box.start, box.end).find((b) => b.type === type) : undefined)
  const moov = top.find((b) => b.type === "moov")
  if (!moov) throw new AudioError("The recording is incomplete (it has no index).")

  const tracks = boxes(view, moov.start, moov.end).filter((b) => b.type === "trak")
  const track = tracks.find((t) => {
    const hdlr = child(child(t, "mdia"), "hdlr")
    return hdlr && hdlr.start + 12 <= hdlr.end && view.getUint32(hdlr.start + 8) === 0x736f756e // "soun"
  })
  const stbl = child(child(child(track, "mdia"), "minf"), "stbl")
  if (!stbl) throw new AudioError("The recording has no audio.")
  const config = audioConfig(view, child(stbl, "stsd"))

  // Sample sizes.
  const stsz = child(stbl, "stsz")
  if (!stsz) throw new AudioError("The recording has no sample sizes.")
  const uniform = view.getUint32(stsz.start + 4)
  const count = view.getUint32(stsz.start + 8)
  const sizes = Array.from({ length: count }, (_, i) => (uniform ? uniform : view.getUint32(stsz.start + 12 + i * 4)))

  // Chunk offsets, 32 or 64 bit.
  const stco = child(stbl, "stco")
  const co64 = child(stbl, "co64")
  const table = stco ?? co64
  if (!table) throw new AudioError("The recording has no chunk offsets.")
  const chunks = Array.from({ length: view.getUint32(table.start + 4) }, (_, i) =>
    stco ? view.getUint32(table.start + 8 + i * 4) : Number(view.getBigUint64(table.start + 8 + i * 8)),
  )

  // Samples per chunk, as runs starting at a (1-based) chunk.
  const stsc = child(stbl, "stsc")
  if (!stsc) throw new AudioError("The recording has no chunk table.")
  const runs = Array.from({ length: view.getUint32(stsc.start + 4) }, (_, i) => ({
    first: view.getUint32(stsc.start + 8 + i * 12),
    perChunk: view.getUint32(stsc.start + 12 + i * 12),
  }))

  const frames: Uint8Array[] = []
  let sample = 0
  for (let c = 0; c < chunks.length && sample < count; c++) {
    const run = runs.findLast((r) => r.first <= c + 1)
    let offset = chunks[c]!
    for (let n = 0; n < (run?.perChunk ?? 0) && sample < count; n++, sample++) {
      const size = sizes[sample]!
      if (offset + size > mp4.length) break
      frames.push(adtsHeader(config, size), mp4.subarray(offset, offset + size))
      offset += size
    }
  }
  if (!frames.length) throw new AudioError("The recording has no audio.")
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

interface AacConfig {
  profile: number
  rateIndex: number
  channels: number
}

/** The AAC settings from the `mp4a` entry's AudioSpecificConfig. */
function audioConfig(view: DataView, stsd: Box | undefined): AacConfig {
  const entry = stsd && boxes(view, stsd.start + 8, stsd.end)[0]
  if (!entry || entry.type !== "mp4a") throw new AudioError(`The recording isn't AAC${entry ? ` (${entry.type.trim()})` : ""}.`)
  // Sound sample entry: 8 bytes before the version; version 1 and 2 (QuickTime) add 16 and 36 bytes.
  const version = view.getUint16(entry.start + 8)
  const esds = boxes(view, entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.end).find((b) => b.type === "esds")
  if (!esds) throw new AudioError("The recording has no AAC configuration.")

  let at = esds.start + 4
  const descriptor = (tag: number) => {
    if (at >= esds.end || view.getUint8(at++) !== tag) throw new AudioError("The recording's AAC configuration is unreadable.")
    let length = 0
    for (let i = 0; i < 4; i++) {
      const b = view.getUint8(at++)
      length = (length << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return length
  }
  descriptor(3)
  const flags = view.getUint8(at + 2)
  at += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + view.getUint8(at + 3 + (flags & 0x80 ? 2 : 0)) : 0) + (flags & 0x20 ? 2 : 0)
  descriptor(4)
  at += 13
  const length = descriptor(5)
  if (length < 2 || at + length > esds.end) throw new AudioError("The recording's AAC configuration is unreadable.")

  // AudioSpecificConfig, a bit stream.
  let bit = at * 8
  const bits = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((view.getUint8(bit >> 3) >> (7 - (bit & 7))) & 1)
    return v
  }
  const objectType = () => {
    const t = bits(5)
    return t === 31 ? 32 + bits(6) : t
  }
  const rate = () => {
    const i = bits(4)
    return i === 15 ? SAMPLE_RATES.indexOf(bits(24)) : i
  }
  let type = objectType()
  const rateIndex = rate()
  const channels = bits(4)
  // HE-AAC: the core is described after the SBR rate; ADTS carries the core and faad finds the SBR itself.
  if (type === 5 || type === 29) {
    rate()
    type = objectType()
  }
  if (type < 1 || type > 4) throw new AudioError(`This kind of AAC (type ${type}) isn't supported.`)
  if (rateIndex < 0 || rateIndex >= SAMPLE_RATES.length) throw new AudioError("The recording's sample rate isn't supported.")
  if (channels < 1 || channels > 7) throw new AudioError("The recording's channel layout isn't supported.")
  return { profile: type - 1, rateIndex, channels }
}

function adtsHeader({ profile, rateIndex, channels }: AacConfig, size: number): Uint8Array {
  const length = size + 7
  if (length > 0x1fff) throw new AudioError("The recording has an AAC frame too large to decode.")
  return new Uint8Array([
    0xff,
    0xf1, // MPEG-4, no CRC
    (profile << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
  ])
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
