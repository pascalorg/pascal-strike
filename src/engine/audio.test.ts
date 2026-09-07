// @ts-ignore Bun provides this runtime module; the project intentionally has no @types/bun dependency.
import { expect, test } from 'bun:test'
import { createAudio, type SoundName } from './audio'
import { SFX_MANIFEST, variantUrls, type OptionalSoundName } from './sfx-manifest'
// @ts-ignore Node's runtime modules are available under Bun; the project does not include Node globals.
import { readdirSync, readFileSync, statSync } from 'node:fs'
// @ts-ignore Bun supplies Node's crypto module without an @types/node dependency.
import { createHash } from 'node:crypto'

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

const OPTIONAL_SOUNDS: OptionalSoundName[] = ['deny']

const ALL_SOUNDS: SoundName[] = [
  'shot',
  'splat',
  'hit',
  'hitConfirm',
  'killConfirm',
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
  'jump',
  'land',
  'death',
  'dryFire',
]

test('manifest covers the API and every referenced sample exists within the size budget', () => {
  expect(Object.keys(SFX_MANIFEST).sort()).toEqual([...ALL_SOUNDS, ...OPTIONAL_SOUNDS].sort())
  const encoded = readdirSync('public/sfx').filter((name: string) => /\.(?:ogg|m4a)$/.test(name))
  const masters = new Set(encoded.map((name: string) => name.replace(/\.(?:ogg|m4a)$/, '')))
  expect(masters.size).toBeLessThanOrEqual(34)
  expect(encoded.length).toBe(masters.size * 2)
  const referenced = new Set<string>()
  for (const entry of Object.values(SFX_MANIFEST)) {
    const count = entry.variants ?? 1
    for (let variant = 1; variant <= count; variant++) {
      for (const url of variantUrls(entry, variant)) {
        const path = `public${url}`
        referenced.add(url.slice('/sfx/'.length))
        expect(statSync(path).isFile()).toBe(true)
        expect(statSync(path).size).toBeLessThanOrEqual(150_000)
      }
    }
  }
  expect([...referenced].sort()).toEqual(encoded.sort())
})

test('Sonniss variants retain distinct gameplay cues and requested mix levels', () => {
  expect(SFX_MANIFEST.shot.variants).toBe(3)
  expect(SFX_MANIFEST.shot.gain).toBe(0.9)
  expect(SFX_MANIFEST.pistolShot.gain).toBe(0.9)
  expect(SFX_MANIFEST.splat.gain).toBe(0.8)
  expect(SFX_MANIFEST.deny.gain).toBe(0.6)
  expect(SFX_MANIFEST.hit.gain).toBe(0.55)
  expect(SFX_MANIFEST.death.gain).toBe(0.7)
  expect(SFX_MANIFEST.respawn.gain).toBe(0.3)
  expect(SFX_MANIFEST.hit.urls).not.toEqual(SFX_MANIFEST.hitConfirm.urls)
  expect(SFX_MANIFEST.knifeHit.urls).not.toEqual(SFX_MANIFEST.splat.urls)
  expect(SFX_MANIFEST.weaponSwitch.urls).not.toEqual(SFX_MANIFEST.dryFire.urls)
  expect(SFX_MANIFEST.reload.urls).toEqual(SFX_MANIFEST.reloadEnd.urls)
  expect(SFX_MANIFEST.jump.gain).toBe(0.25)
  expect(SFX_MANIFEST.land.gain).toBe(0.4)
  expect(SFX_MANIFEST.land.variants).toBe(2)
  expect(variantUrls(SFX_MANIFEST.shot, 3)).toEqual(['/sfx/shot-3.ogg', '/sfx/shot-3.m4a'])
})

test('fine-tuned samples meet duration, decoded peak, and pistol RMS requirements', () => {
  const report = JSON.parse(readFileSync('public/sfx/measurements.json', 'utf8'))
  const durations: Record<string, number> = {
    'shot-1': 0.22, 'shot-2': 0.24, 'shot-3': 0.2, 'pistol-shot': 0.17,
    'dry-fire': 0.07, 'weapon-switch': 0.12, 'reload-end': 0.16,
    'splat-1': 0.12, 'splat-3': 0.12, 'body-hit': 0.16, death: 0.45,
    'hit-confirm': 0.12, 'glass-1': 0.9, 'glass-2': 0.9,
    jump: 0.15, 'land-1': 0.22, 'land-2': 0.22,
    'shard-tinkle': 0.4, 'door-handle': 0.42, 'respawn-chime': 0.65,
  }
  for (const [stem, duration] of Object.entries(durations)) {
    const sound = report.sounds[stem]
    expect(Math.abs(sound.master.duration - duration)).toBeLessThanOrEqual(1 / 44100)
    expect(sound.master.peak_dbfs).toBe(-1)
    for (const ext of ['ogg', 'm4a']) {
      const measured = sound.encoded[ext]
      const bytes = readFileSync(`public/sfx/${stem}.${ext}`)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(measured.sha256)
      expect(measured.channels).toBe(1)
      expect(measured.sample_rate).toBe(44100)
      expect(Math.abs(measured.peak_dbfs + 1)).toBeLessThanOrEqual(0.15)
      expect(Number.isFinite(measured.high_rms_dbfs)).toBe(true)
    }
  }
  for (const ext of ['ogg', 'm4a']) {
    for (const marker of ['shot-1', 'shot-2', 'shot-3']) {
      const delta = report.sounds['pistol-shot'].encoded[ext].rms_dbfs
        - report.sounds[marker].encoded[ext].rms_dbfs
      expect(delta).toBeGreaterThanOrEqual(1)
      expect(delta).toBeLessThanOrEqual(2)
    }
  }
})

test('Kenney footsteps are preserved byte-for-byte with the original playback settings', () => {
  const hashes = [
    ['b125dce1c08c9de58585687c198f617c61f75076815f294c73d33326a075a484', '0a841203858afd1d2677998b98d0c09c3d6666b0dfe3ae90f3cb03c6f1461f87'],
    ['2afec663a41604d421cc03d07b74c99e9f25b086b5e5504e0a2e28c87cc33f37', '9ed87a706fb91ff8d63d94c282798c9f282ccbb3b058db4e20a3596a548b96e6'],
    ['29ac0f8421ba5848173ac81e4f39d037979f1a1c9d305f5f230cd30723540832', 'c858799666e4f8b9ec04c4f98ea5f532843fdd6d121ea2a598e39d452b3bcfd8'],
    ['226b72bd6dcf0ca9b2024291d434b9d06a7fade28eb4836fbd09117dc4530656', '80c49b900b5ceeb0d94f3a1b1dd9135f809b5656539829ffa83bce8df77620d0'],
  ]
  hashes.forEach((pair, index) => {
    ;['m4a', 'ogg'].forEach((ext, format) => {
      const bytes = readFileSync(`public/sfx/footstep-${index + 1}.${ext}`)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pair[format])
    })
  })
  expect(SFX_MANIFEST.footstep).toEqual({
    urls: ['/sfx/footstep-1.ogg', '/sfx/footstep-1.m4a'],
    gain: 0.23, pitchJitter: 0.06, variants: 4,
  })
})

test('literal audio play names in src have manifest entries', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((path: string) => path.endsWith('.ts') && !path.endsWith('audio.test.ts'))
  const used = new Set<string>()

  for (const path of files) {
    const source = readFileSync(`src/${path}`, 'utf8')
    const calls = source.matchAll(/\b(?:audio|rawAudio)(?:\?\.|\.)play\s*\(/g)
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
    'deny',
    'door',
    'dryFire',
    'footstep',
    'glassBreak',
    'hit',
    'hitConfirm',
    'jump',
    'killConfirm',
    'knifeHit',
    'knifeSwing',
    'land',
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

test('every existing API sound retains finite sub-second synth fallback sources and envelopes', () => {
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
    for (const name of ALL_SOUNDS) {
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
  const requested: string[] = []

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
      requested.push(url)
      const ok = url.endsWith('/shot-1.ogg') || url.endsWith('/deny.m4a')
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

    // Optional manifest entries are runtime-ready; SoundName deliberately stays unchanged.
    for (const name of OPTIONAL_SOUNDS) {
      ;(audio.play as (name: string) => void)(name)
      expect(context.sources.at(-1)!.buffer).toBe(decoded)
      expect(context.sources.at(-1)!.playbackRate.value).toBe(1)
      expect(context.gains.at(-1)!.gain.value).toBe(SFX_MANIFEST[name].gain)
    }
    expect(requested).toContain('/sfx/deny.ogg')
    expect(requested).toContain('/sfx/deny.m4a')

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
