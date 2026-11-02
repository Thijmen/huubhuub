import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AudioError, decodeAac, mp4ToAdts, parseWav } from "./audio"

function wav(channels: number, rate: number, samples: number[], streamed = false): Uint8Array {
  const data = new Uint8Array(samples.length * 2)
  const dv = new DataView(data.buffer)
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true))
  const out = new Uint8Array(44 + data.length)
  const v = new DataView(out.buffer)
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)))
  put(0, "RIFF")
  v.setUint32(4, streamed ? 0 : 36 + data.length, true)
  put(8, "WAVE")
  put(12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * channels * 2, true)
  v.setUint16(32, channels * 2, true)
  v.setUint16(34, 16, true)
  put(36, "data")
  v.setUint32(40, streamed ? 0 : data.length, true)
  out.set(data, 44)
  return out
}

const samples = (pcm: Uint8Array) => Array.from({ length: pcm.length / 2 }, (_, i) => new DataView(pcm.buffer, pcm.byteOffset).getInt16(i * 2, true))

describe("parseWav", () => {
  test("mono passes through, also when the header has no sizes", () => {
    for (const streamed of [false, true]) {
      const pcm = parseWav(wav(1, 16000, [1, -2, 300], streamed))
      expect(pcm.sampleRate).toBe(16000)
      expect(samples(pcm.data)).toEqual([1, -2, 300])
    }
  })

  test("stereo is mixed down", () => {
    const pcm = parseWav(wav(2, 44100, [100, 300, -10, -30]))
    expect(pcm.sampleRate).toBe(44100)
    expect(samples(pcm.data)).toEqual([200, -20])
  })

  test("anything else is refused", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3]))).toThrow(AudioError)
  })
})

/** Three seconds of a 440 Hz tone, AAC at 16 kHz mono, written by Android's own MP4 writer (64-bit `mdat`, `co64`). */
const android = () => new Uint8Array(readFileSync(join(import.meta.dir, "testdata", "android-voice.m4a")))

/** The ADTS frames in a stream: [profile, rate index, channels, frame length]. */
function adtsFrames(adts: Uint8Array) {
  const frames: number[][] = []
  for (let at = 0; at < adts.length; ) {
    expect(adts[at]).toBe(0xff)
    expect(adts[at + 1]).toBe(0xf1)
    const length = ((adts[at + 3]! & 3) << 11) | (adts[at + 4]! << 3) | (adts[at + 5]! >> 5)
    frames.push([adts[at + 2]! >> 6, (adts[at + 2]! >> 2) & 15, ((adts[at + 2]! & 1) << 2) | (adts[at + 3]! >> 6), length])
    at += length
  }
  return frames
}

describe("mp4ToAdts", () => {
  test("takes the AAC frames out of an Android recording", () => {
    const frames = adtsFrames(mp4ToAdts(android()))
    // About 3 s of 1024-sample frames at 16 kHz.
    expect(frames.length).toBeGreaterThan(45)
    expect(frames.length).toBeLessThan(52)
    // AAC-LC, 16 kHz (index 8), mono.
    for (const [profile, rate, channels] of frames) expect([profile, rate, channels]).toEqual([1, 8, 1])
  })

  test("a recording without its index, or not an MP4, is a clear error", () => {
    const mp4 = android()
    expect(() => mp4ToAdts(mp4.subarray(0, 24))).toThrow("incomplete")
    expect(() => mp4ToAdts(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(AudioError)
  })
})

const hasFaad = Boolean(Bun.which("faad"))
const hasTools = Bun.which("ffmpeg") && hasFaad

/** Seconds of audio, and the pitch from zero crossings in the middle half (the edges are quiet and noisy). */
function measure(pcm: { data: Uint8Array; sampleRate: number }) {
  const s = samples(pcm.data)
  const middle = s.slice(s.length / 4, (s.length * 3) / 4)
  let crossings = 0
  for (let i = 1; i < middle.length; i++) if (middle[i - 1]! < 0 !== middle[i]! < 0) crossings++
  return { seconds: s.length / pcm.sampleRate, hz: crossings / 2 / (middle.length / pcm.sampleRate) }
}

describe("decodeAac", () => {
  test.skipIf(!hasFaad)("decodes an Android recording, which faad can't read as MP4", async () => {
    const { seconds, hz } = measure(await decodeAac(android()))
    expect(seconds).toBeGreaterThan(2.9)
    expect(seconds).toBeLessThan(3.3)
    expect(hz).toBeGreaterThan(420)
    expect(hz).toBeLessThan(460)
  })

  test.skipIf(!hasTools)("decodes AAC in MP4 as ffmpeg writes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aac-"))
    try {
      const file = join(dir, "voice.m4a")
      const ffmpeg = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "16000", "-c:a", "aac", file])
      expect(ffmpeg.exitCode).toBe(0)
      const { seconds, hz } = measure(await decodeAac(new Uint8Array(readFileSync(file))))
      expect(seconds).toBeGreaterThan(0.95)
      expect(seconds).toBeLessThan(1.2)
      expect(hz).toBeGreaterThan(420)
      expect(hz).toBeLessThan(460)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a broken recording is a clear error", async () => {
    await expect(decodeAac(new Uint8Array([1, 2, 3]), Bun.which("faad") ?? "faad-missing")).rejects.toThrow(AudioError)
  })
})
