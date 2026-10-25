import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AudioError, decodeAac, parseWav } from "./audio"

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

const hasTools = Bun.which("ffmpeg") && Bun.which("faad")

describe("decodeAac", () => {
  test.skipIf(!hasTools)("decodes what the phone records (AAC in MP4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aac-"))
    try {
      const file = join(dir, "voice.m4a")
      const ffmpeg = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "1", "-ar", "16000", "-c:a", "aac", file])
      expect(ffmpeg.exitCode).toBe(0)
      const pcm = await decodeAac(new Uint8Array(readFileSync(file)))
      expect(pcm.sampleRate).toBe(16000)
      // About a second of 16-bit mono.
      expect(pcm.data.length).toBeGreaterThan(28_000)
      expect(pcm.data.length).toBeLessThan(40_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a broken recording is a clear error", async () => {
    await expect(decodeAac(new Uint8Array([1, 2, 3]), Bun.which("faad") ?? "faad-missing")).rejects.toThrow(AudioError)
  })
})
