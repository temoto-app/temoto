/**
 * Collects 16 kHz / mono PCM from the microphone (item 226, 4.5.10). **The recorded audio is kept only in memory and
 * discarded once handed to main as a WAV** (not saved).
 *
 * Capture uses `ScriptProcessorNode`. qlm uses `AudioWorklet`, but aios's renderer is loaded from `file://` and the CSP is `script-src 'self'`,
 * so whether the worklet module can be loaded from the same origin has not been confirmed on a real machine (blob: / data: are blocked by the CSP). `ScriptProcessorNode` is deprecated but
 * remains in Chromium, and at every 4,096 samples of 16 kHz (4 times a second) it does not compete with rendering. Moving to a worklet
 * waits until loading is confirmed on a real machine (TODO 227).
 */
import { concatSamples, downsample } from './voice-wav.js'
import { rmsOf } from './voice-input.js'
import { VOICE_SAMPLE_RATE } from '@shared/voice.js'

const BUFFER_SIZE = 4096

export class VoiceRecorder {
  private chunks: Float32Array[] = []
  private closed = false

  private constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
    private readonly source: MediaStreamAudioSourceNode,
    private readonly processor: ScriptProcessorNode
  ) {}

  /**
   * Opens the microphone and starts collecting. `onLevel` is the volume (rms) per slice. Throws if it cannot be opened
   * (the caller shows "the microphone is unavailable").
   */
  static async start(onLevel: (rms: number) => void): Promise<VoiceRecorder> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    let context: AudioContext
    try {
      context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
    } catch {
      // A fallback for environments that cannot open at 16 kHz. Decimated when stopping.
      context = new AudioContext()
    }
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    const recorder = new VoiceRecorder(stream, context, source, processor)
    processor.onaudioprocess = (event) => {
      if (recorder.closed) return
      // **Take a copy.** The input buffer is reused on the next call (the same caution as qlm's worklet).
      const copy = new Float32Array(event.inputBuffer.getChannelData(0))
      recorder.chunks.push(copy)
      onLevel(rmsOf(copy))
    }
    source.connect(processor)
    // Without connecting to the output, onaudioprocess does not fire. The output is silent (the input is not copied), so nothing is heard.
    processor.connect(context.destination)
    return recorder
  }

  /** Stops and returns the 16 kHz samples. */
  async stop(): Promise<Float32Array> {
    const rate = this.context.sampleRate
    const chunks = this.chunks
    await this.close()
    const joined = concatSamples(chunks)
    return rate === VOICE_SAMPLE_RATE ? joined : downsample(joined, rate)
  }

  /** Discards without transcribing (Esc, a thread switch, component cleanup). */
  async cancel(): Promise<void> {
    await this.close()
  }

  private async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.chunks = []
    this.processor.onaudioprocess = null
    try {
      this.source.disconnect()
      this.processor.disconnect()
    } catch {
      // It may already be disconnected
    }
    for (const track of this.stream.getTracks()) track.stop()
    await this.context.close().catch(() => undefined)
  }
}
