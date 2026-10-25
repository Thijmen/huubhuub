import {
  LanguageCode,
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
} from "@aws-sdk/client-transcribe-streaming"
import { decodeAac } from "./audio"
import type { Config } from "./config"

const CHUNK_BYTES = 8 * 1024

export class Transcriber {
  private readonly client: TranscribeStreamingClient

  constructor(private readonly config: Config) {
    this.client = new TranscribeStreamingClient({
      region: config.TRANSCRIBE_REGION ?? process.env.AWS_REGION ?? "eu-west-1",
    })
  }

  static enabled(): boolean {
    const env = process.env
    return Boolean(
      env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    )
  }

  /** Transcribe an OGG/Opus voice note (the format Telegram uses) to text. */
  transcribeOgg(audio: Uint8Array): Promise<string> {
    return this.transcribe(audio, "ogg-opus", 48000)
  }

  /** Transcribe a recording from the phone app: OGG/Opus as is, AAC (`.m4a`) decoded to PCM first. */
  async transcribeRecording(audio: Uint8Array, mime: string): Promise<string> {
    if (/ogg|opus/.test(mime)) return this.transcribeOgg(audio)
    const pcm = await decodeAac(audio)
    return this.transcribe(pcm.data, "pcm", pcm.sampleRate)
  }

  private async transcribe(audio: Uint8Array, encoding: "ogg-opus" | "pcm", sampleRate: number): Promise<string> {
    const language = this.config.TRANSCRIBE_LANGUAGE
    const options = this.config.TRANSCRIBE_LANGUAGE_OPTIONS.split(",").map((s) => s.trim()).filter(Boolean)

    const response = await this.client.send(
      new StartStreamTranscriptionCommand({
        MediaEncoding: encoding,
        MediaSampleRateHertz: sampleRate,
        AudioStream: chunks(audio),
        ...(language
          ? { LanguageCode: language as LanguageCode }
          : { IdentifyLanguage: true, LanguageOptions: options.join(",") }),
      }),
    )

    const segments: string[] = []
    for await (const event of response.TranscriptResultStream ?? []) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        if (result.IsPartial) continue
        const text = result.Alternatives?.[0]?.Transcript
        if (text) segments.push(text)
      }
    }
    return segments.join(" ").trim()
  }
}

async function* chunks(audio: Uint8Array): AsyncIterable<AudioStream> {
  for (let i = 0; i < audio.length; i += CHUNK_BYTES) {
    yield { AudioEvent: { AudioChunk: audio.subarray(i, i + CHUNK_BYTES) } }
  }
}
