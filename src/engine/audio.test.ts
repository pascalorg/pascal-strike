// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { createAudio, type SoundName } from './audio'

interface ParamEvent {
  kind: 'set' | 'exponential'
  value: number
  time: number
}

class FakeAudioParam {
  value = 0
  readonly events: ParamEvent[] = []

  setValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ kind: 'set', value, time })
    return this
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.events.push({ kind: 'exponential', value, time })
    return this
  }
}

class FakeNode {
  connect<T>(destination: T): T {
    return destination
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeAudioParam()
}

class FakePanner extends FakeNode {
  readonly pan = new FakeAudioParam()
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeAudioParam()
  readonly Q = new FakeAudioParam()
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null
  startTime = NaN
  stopTime = NaN

  start(time: number): void {
    this.startTime = time
  }

  stop(time: number): void {
    this.stopTime = time
  }
}

class FakeOscillator extends FakeSource {
  type: OscillatorType = 'sine'
  readonly frequency = new FakeAudioParam()
  readonly detune = new FakeAudioParam()
}

class FakeBuffer {
  private readonly channel: Float32Array

  constructor(length: number) {
    this.channel = new Float32Array(length)
  }

  getChannelData(): Float32Array {
    return this.channel
  }
}

class FakeAudioContext {
  readonly currentTime = 10
  readonly sampleRate = 100
  readonly destination = new FakeNode()
  readonly sources: FakeSource[] = []
  readonly gains: FakeGain[] = []
  readonly filters: FakeFilter[] = []
  readonly panners: FakePanner[] = []
  state: AudioContextState = 'running'

  createGain(): GainNode {
    const node = new FakeGain()
    this.gains.push(node)
    return node as unknown as GainNode
  }

  createStereoPanner(): StereoPannerNode {
    const node = new FakePanner()
    this.panners.push(node)
    return node as unknown as StereoPannerNode
  }

  createBiquadFilter(): BiquadFilterNode {
    const node = new FakeFilter()
    this.filters.push(node)
    return node as unknown as BiquadFilterNode
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = new FakeSource()
    this.sources.push(node)
    return node as unknown as AudioBufferSourceNode
  }

  createOscillator(): OscillatorNode {
    const node = new FakeOscillator()
    this.sources.push(node)
    return node as unknown as OscillatorNode
  }

  createBuffer(_channels: number, length: number): AudioBuffer {
    return new FakeBuffer(length) as unknown as AudioBuffer
  }

  async resume(): Promise<void> {
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }
}

const NEW_SOUNDS: SoundName[] = [
  'reloadStart',
  'reloadEnd',
  'pistolShot',
  'knifeSwing',
  'knifeHit',
  'weaponSwitch',
  'glassBreak',
  'shardTinkle',
]

test('every wave-four sound schedules finite sub-second sources and envelopes', () => {
  const originalWindow = globalThis.window
  const contexts: FakeAudioContext[] = []
  class TestAudioContext extends FakeAudioContext {
    constructor() {
      super()
      contexts.push(this)
    }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: TestAudioContext },
  })

  try {
    const audio = createAudio()
    for (const name of NEW_SOUNDS) {
      const context = contexts[0]
      const sourceStart = context?.sources.length ?? 0
      const gainStart = context?.gains.length ?? 0
      audio.play(name)
      const activeContext = contexts[0]!
      const sources = activeContext.sources.slice(sourceStart)
      const envelopes = activeContext.gains.slice(gainStart)
        .filter((node) => node.gain.events.some((event) => event.kind === 'exponential'))

      expect(sources.length).toBeGreaterThan(0)
      expect(envelopes.length).toBeGreaterThan(0)
      for (const source of sources) {
        const duration = source.stopTime - source.startTime
        expect(Number.isFinite(duration)).toBe(true)
        expect(duration).toBeGreaterThan(0)
        expect(duration).toBeLessThanOrEqual(1)
      }
      for (const envelope of envelopes) {
        const end = envelope.gain.events.find((event) => event.kind === 'exponential')!
        expect(Number.isFinite(end.time)).toBe(true)
        expect(end.time - activeContext.currentTime).toBeLessThanOrEqual(1)
      }
    }

    const context = contexts[0]!
    expect(context.gains[0]!.gain.value).toBe(0.32)

    const reloadSourceCount = context.sources.length
    audio.play('reload')
    expect(context.sources.length).toBeGreaterThan(reloadSourceCount)

    const nodeCount = context.sources.length + context.gains.length + context.filters.length + context.panners.length
    ;(audio.play as (name: string) => void)('not-a-sound')
    expect(context.sources.length + context.gains.length + context.filters.length + context.panners.length).toBe(nodeCount)
    audio.dispose()
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  }
})
