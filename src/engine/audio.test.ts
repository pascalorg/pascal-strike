// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { createAudio, type SoundName } from './audio'
import { SFX_MANIFEST, variantUrls } from './sfx-manifest'
// @ts-ignore Node's runtime modules are available under Bun; the project does not include Node globals.
import { readdirSync, readFileSync, statSync } from 'node:fs'

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
  readonly playbackRate = new FakeAudioParam()
  onended: (() => void) | null = null
  startTime = NaN
  stopTime = NaN

  start(time: number): void {
    this.startTime = time
  }

  stop(time?: number): void {
    this.stopTime = time ?? this.startTime
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

  async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    return new FakeBuffer(8) as unknown as AudioBuffer
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

const ALL_SOUNDS: SoundName[] = [
  'shot',
  'splat',
  'hit',
  'hitConfirm',
  'reload',
  'reloadStart',
  'reloadEnd',
  'pistolShot',
  'knifeSwing',
  'knifeHit',
  'weaponSwitch',
  'glassBreak',
  'shardTinkle',
  'respawn',
  'door',
  'footstep',
  'death',
  'dryFire',
]

test('manifest covers the API and every referenced sample exists within the size budget', () => {
  expect(Object.keys(SFX_MANIFEST).sort()).toEqual([...ALL_SOUNDS].sort())
  const encoded = readdirSync('public/sfx').filter((name: string) => /\.(?:ogg|m4a)$/.test(name))
  const masters = new Set(encoded.map((name: string) => name.replace(/\.(?:ogg|m4a)$/, '')))
  expect(masters.size).toBeLessThanOrEqual(28)
  expect(encoded.length).toBe(masters.size * 2)
  for (const entry of Object.values(SFX_MANIFEST)) {
    const count = entry.variants ?? 1
    for (let variant = 1; variant <= count; variant++) {
      for (const url of variantUrls(entry, variant)) {
        const path = `public${url}`
        expect(statSync(path).isFile()).toBe(true)
        expect(statSync(path).size).toBeLessThanOrEqual(120_000)
      }
    }
  }
})

test('literal audio play names in src have manifest entries', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((path: string) => path.endsWith('.ts') && !path.endsWith('audio.test.ts'))
  const used = new Set<string>()

  for (const path of files) {
    const source = readFileSync(`src/${path}`, 'utf8')
    const calls = source.matchAll(/\b(?:audio|rawAudio)\.play\s*\(/g)
    for (const call of calls) {
      const start = (call.index ?? 0) + call[0].length
      let depth = 0
      let quote = ''
      let argument = ''
      for (let index = start; index < source.length; index++) {
        const char = source[index]!
        if (quote) {
          argument += char
          if (char === quote && source[index - 1] !== '\\') quote = ''
          continue
        }
        if (char === "'" || char === '"' || char === '`') quote = char
        if (char === '(' || char === '[' || char === '{') depth++
        if (char === ')' || char === ']' || char === '}') {
          if (char === ')' && depth === 0) break
          depth--
        }
        if (char === ',' && depth === 0) break
        argument += char
      }
      const direct = argument.trim().match(/^['"]([A-Za-z]+)['"]$/)
      if (direct) expect(direct[1]! in SFX_MANIFEST).toBe(true)
      for (const literal of argument.matchAll(/['"]([A-Za-z]+)['"]/g)) {
        if (literal[1]! in SFX_MANIFEST) used.add(literal[1]!)
      }
    }
  }

  expect([...used].sort()).toEqual([
    'death',
    'door',
    'dryFire',
    'footstep',
    'glassBreak',
    'hit',
    'hitConfirm',
    'knifeHit',
    'knifeSwing',
    'pistolShot',
    'reload',
    'reloadEnd',
    'reloadStart',
    'respawn',
    'shot',
    'splat',
    'weaponSwitch',
  ])
  for (const name of used) expect(name in SFX_MANIFEST).toBe(true)
})

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

test('decoded samples play from buffers while failed samples use the synth fallback', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const contexts: FakeAudioContext[] = []
  const decoded = new FakeBuffer(12) as unknown as AudioBuffer

  class TestAudioContext extends FakeAudioContext {
    constructor() {
      super()
      contexts.push(this)
    }

    override async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
      return decoded
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { AudioContext: TestAudioContext },
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input)
      const ok = url.endsWith('/shot-1.ogg')
      return {
        ok,
        status: ok ? 200 : 404,
        async arrayBuffer() {
          return new ArrayBuffer(4)
        },
      }
    },
  })

  try {
    const audio = createAudio()
    await audio.resume()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const context = contexts[0]!
    audio.play('shot')
    const sample = context.sources.at(-1)!
    expect(sample.buffer).toBe(decoded)
    expect(sample.playbackRate.value).toBeGreaterThanOrEqual(0.94)
    expect(sample.playbackRate.value).toBeLessThanOrEqual(1.06)

    for (let index = 0; index < 24; index++) audio.play('shot')
    expect(sample.stopTime).toBe(context.currentTime)

    const sourceCount = context.sources.length
    audio.play('door')
    expect(context.sources.length).toBeGreaterThan(sourceCount)
    expect(context.sources.slice(sourceCount).some((source) => source.buffer !== decoded)).toBe(true)
    audio.dispose()
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: originalFetch,
    })
  }
})
