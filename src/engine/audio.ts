import { Vector3 } from 'three'
import { SFX_MANIFEST, variantUrls } from './sfx-manifest'

export type SoundName =
  | 'shot'
  | 'splat'
  | 'hit'
  | 'hitConfirm'
  | 'reload'
  | 'reloadStart'
  | 'reloadEnd'
  | 'pistolShot'
  | 'knifeSwing'
  | 'knifeHit'
  | 'weaponSwitch'
  | 'glassBreak'
  | 'shardTinkle'
  | 'respawn'
  | 'door'
  | 'footstep'
  | 'death'
  | 'dryFire'

const SOUND_NAMES: ReadonlySet<string> = new Set(Object.keys(SFX_MANIFEST))
const MAX_SAMPLE_VOICES = 24

export interface AudioListenerPose {
  position: Vector3
  forward: Vector3
}

export interface Audio {
  resume(): Promise<void>
  /** `gain` scales this one-shot (1 = normal); walking footsteps pass < 1. */
  play(name: SoundName, at?: Vector3, listener?: AudioListenerPose, gain?: number): void
  dispose(): void
}

export function createAudio(): Audio {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let noise: AudioBuffer | null = null
  let loadCycle = 0
  const buffers = new Map<string, AudioBuffer>()
  const pendingUrls = new Map<string, Promise<AudioBuffer | null>>()
  const sampleVoices: AudioBufferSourceNode[] = []

  const initialise = () => {
    if (context) return context
    const AudioContextClass = window.AudioContext
    context = new AudioContextClass()
    master = context.createGain()
    master.gain.value = 0.32
    master.connect(context.destination)
    noise = context.createBuffer(1, context.sampleRate, context.sampleRate)
    const channel = noise.getChannelData(0)
    let value = 0x9e3779b9
    for (let index = 0; index < channel.length; index++) {
      value ^= value << 13
      value ^= value >>> 17
      value ^= value << 5
      channel[index] = ((value >>> 0) / 2147483648) - 1
    }
    return context
  }

  const sampleKey = (name: SoundName, variant: number) => `${name}:${variant}`

  function decodeUrl(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    const pending = pendingUrls.get(url)
    if (pending) return pending
    const request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`SFX request failed: ${response.status}`)
        return response.arrayBuffer()
      })
      .then((data) => ctx.decodeAudioData(data))
      .catch(() => null)
    pendingUrls.set(url, request)
    return request
  }

  async function decodeVariant(
    ctx: AudioContext,
    name: SoundName,
    variant: number,
    cycle: number,
  ): Promise<void> {
    const entry = SFX_MANIFEST[name]
    for (const url of variantUrls(entry, variant)) {
      const buffer = await decodeUrl(ctx, url)
      if (buffer) {
        if (context === ctx && loadCycle === cycle) buffers.set(sampleKey(name, variant), buffer)
        return
      }
    }
  }

  function preloadSamples(ctx: AudioContext): void {
    const cycle = ++loadCycle
    const jobs: Promise<void>[] = []
    for (const name of Object.keys(SFX_MANIFEST) as SoundName[]) {
      const count = SFX_MANIFEST[name].variants ?? 1
      for (let variant = 1; variant <= count; variant++) {
        jobs.push(decodeVariant(ctx, name, variant, cycle))
      }
    }
    void Promise.all(jobs)
  }

  function destination(at?: Vector3, listener?: AudioListenerPose, volume = 1): AudioNode {
    const ctx = context!
    const gain = ctx.createGain()
    let attenuation = 1
    let pan = 0
    if (at && listener) {
      const dx = at.x - listener.position.x
      const dy = at.y - listener.position.y
      const dz = at.z - listener.position.z
      const distance = Math.hypot(dx, dy, dz)
      attenuation = Math.max(0.05, 1 / Math.max(1, distance))
      if (distance > 1e-5) {
        const rightX = -listener.forward.z
        const rightZ = listener.forward.x
        pan = Math.max(-1, Math.min(1, (dx * rightX + dz * rightZ) / distance))
      }
    }
    gain.gain.value = attenuation * Math.max(0, volume)
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    gain.connect(panner).connect(master!)
    return gain
  }

  function oscillator(
    output: AudioNode,
    start: number,
    duration: number,
    fromHz: number,
    toHz: number,
    volume: number,
    type: OscillatorType = 'sine',
    detune = 0,
  ): void {
    const ctx = context!
    const osc = ctx.createOscillator()
    const envelope = ctx.createGain()
    osc.type = type
    osc.detune.value = detune
    osc.frequency.setValueAtTime(fromHz, start)
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + duration)
    envelope.gain.setValueAtTime(volume, start)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    osc.connect(envelope).connect(output)
    osc.start(start)
    osc.stop(start + duration)
  }

  function noiseBurst(
    output: AudioNode,
    start: number,
    duration: number,
    volume: number,
    filterType: BiquadFilterType,
    frequency: number,
  ): void {
    const ctx = context!
    const source = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const envelope = ctx.createGain()
    source.buffer = noise
    filter.type = filterType
    filter.frequency.value = frequency
    filter.Q.value = 0.7
    envelope.gain.setValueAtTime(volume, start)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(filter).connect(envelope).connect(output)
    source.start(start)
    source.stop(start + duration)
  }

  function bandNoise(
    output: AudioNode,
    start: number,
    duration: number,
    volume: number,
    lowHz: number,
    highHz: number,
  ): void {
    const ctx = context!
    const source = ctx.createBufferSource()
    const highpass = ctx.createBiquadFilter()
    const lowpass = ctx.createBiquadFilter()
    const envelope = ctx.createGain()
    source.buffer = noise
    highpass.type = 'highpass'
    highpass.frequency.value = lowHz
    lowpass.type = 'lowpass'
    lowpass.frequency.value = highHz
    envelope.gain.setValueAtTime(volume, start)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(highpass).connect(lowpass).connect(envelope).connect(output)
    source.start(start)
    source.stop(start + duration)
  }

  function sweptNoise(
    output: AudioNode,
    start: number,
    duration: number,
    volume: number,
    fromHz: number,
    toHz: number,
  ): void {
    const ctx = context!
    const source = ctx.createBufferSource()
    const filter = ctx.createBiquadFilter()
    const envelope = ctx.createGain()
    source.buffer = noise
    filter.type = 'bandpass'
    filter.Q.value = 1.2
    filter.frequency.setValueAtTime(fromHz, start)
    filter.frequency.exponentialRampToValueAtTime(toHz, start + duration)
    envelope.gain.setValueAtTime(volume, start)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration)
    source.connect(filter).connect(envelope).connect(output)
    source.start(start)
    source.stop(start + duration)
  }

  function playSample(
    name: SoundName,
    at?: Vector3,
    listener?: AudioListenerPose,
    volume = 1,
  ): boolean {
    const entry = SFX_MANIFEST[name]
    const available: AudioBuffer[] = []
    const count = entry.variants ?? 1
    for (let variant = 1; variant <= count; variant++) {
      const buffer = buffers.get(sampleKey(name, variant))
      if (buffer) available.push(buffer)
    }
    if (available.length === 0) return false

    const ctx = context!
    while (sampleVoices.length >= MAX_SAMPLE_VOICES) {
      const oldest = sampleVoices.shift()
      try {
        oldest?.stop()
      } catch {
        // A source that ended between selection and stealing needs no further work.
      }
    }
    const source = ctx.createBufferSource()
    source.buffer = available[Math.floor(Math.random() * available.length)]!
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * entry.pitchJitter
    source.connect(destination(at, listener, volume * entry.gain))
    sampleVoices.push(source)
    source.onended = () => {
      const index = sampleVoices.indexOf(source)
      if (index >= 0) sampleVoices.splice(index, 1)
    }
    source.start(ctx.currentTime)
    return true
  }

  return {
    async resume() {
      const ctx = initialise()
      if (ctx.state !== 'running') await ctx.resume()
      if (buffers.size === 0 && pendingUrls.size === 0) preloadSamples(ctx)
    },
    play(name, at, listener, gain = 1) {
      // Runtime callers can still supply untyped input; unknown sounds are true no-ops.
      if (!SOUND_NAMES.has(name)) return
      const ctx = initialise()
      if (ctx.state !== 'running') return
      if (playSample(name, at, listener, gain)) return
      const output = destination(at, listener, gain)
      const time = ctx.currentTime
      switch (name) {
        case 'shot':
          // Thwip (air) + pitch drop (bolt) + a 60 ms low thump so the shot has weight.
          noiseBurst(output, time, 0.07, 0.42, 'highpass', 1800)
          oscillator(output, time, 0.09, 420, 115, 0.22)
          oscillator(output, time, 0.06, 130, 52, 0.5)
          noiseBurst(output, time, 0.05, 0.3, 'lowpass', 220)
          break
        case 'dryFire':
          // Dry, tiny and metallic: nothing but the sear and the empty hopper.
          noiseBurst(output, time, 0.018, 0.24, 'highpass', 2600)
          oscillator(output, time, 0.028, 240, 95, 0.07, 'square')
          break
        case 'splat':
          noiseBurst(output, time, 0.12, 0.35, 'lowpass', 900)
          oscillator(output, time, 0.08, 135, 70, 0.08, 'triangle')
          break
        case 'hit':
          oscillator(output, time, 0.055, 260, 170, 0.18, 'square')
          break
        case 'hitConfirm':
          oscillator(output, time, 0.045, 980, 720, 0.13, 'sine')
          break
        case 'reload':
          oscillator(output, time, 0.045, 680, 390, 0.12, 'square')
          oscillator(output, time + 0.18, 0.055, 460, 760, 0.13, 'square')
          break
        case 'reloadStart':
          // Two crisp magazine-release clicks, separated enough to read as distinct mechanics.
          noiseBurst(output, time, 0.018, 0.19, 'bandpass', 1800)
          oscillator(output, time, 0.022, 900, 760, 0.09, 'square')
          noiseBurst(output, time + 0.06, 0.018, 0.16, 'bandpass', 1600)
          oscillator(output, time + 0.06, 0.022, 900, 720, 0.075, 'square')
          break
        case 'reloadEnd':
          // A low magazine-seat impact under a short, strictly band-limited slide scrape.
          noiseBurst(output, time, 0.045, 0.32, 'bandpass', 900)
          oscillator(output, time, 0.065, 170, 72, 0.2, 'triangle')
          bandNoise(output, time + 0.025, 0.09, 0.18, 2000, 5000)
          break
        case 'pistolShot':
          // Short air snap, compact 180 Hz body, then a fast metallic ping.
          noiseBurst(output, time, 0.03, 0.38, 'highpass', 2400)
          oscillator(output, time, 0.05, 180, 68, 0.34)
          oscillator(output, time + 0.008, 0.11, 1200, 920, 0.1)
          break
        case 'knifeSwing':
          sweptNoise(output, time, 0.14, 0.25, 400, 1200)
          break
        case 'knifeHit':
          // A fixed 90 Hz thud anchors a low, loose burst that supplies the wet splat.
          oscillator(output, time, 0.06, 90, 58, 0.34, 'triangle')
          noiseBurst(output, time, 0.1, 0.34, 'lowpass', 1100)
          break
        case 'weaponSwitch':
          // Fifteen-millisecond clicks at either end of a 40 ms handling gesture.
          noiseBurst(output, time, 0.015, 0.1, 'bandpass', 1700)
          oscillator(output, time, 0.015, 720, 580, 0.045, 'square')
          noiseBurst(output, time + 0.025, 0.015, 0.085, 'bandpass', 1450)
          oscillator(output, time + 0.025, 0.015, 620, 500, 0.04, 'square')
          break
        case 'glassBreak': {
          bandNoise(output, time, 0.25, 0.42, 3000, 8000)
          const count = 8 + Math.floor(Math.random() * 5)
          for (let index = 0; index < count; index++) {
            const offset = Math.random() * 0.4
            const duration = 0.035 + Math.random() * 0.055
            const frequency = 2000 + Math.random() * 4000
            const detune = (Math.random() - 0.5) * 24
            oscillator(output, time + offset, duration, frequency, frequency * 0.92, 0.035, 'sine', detune)
          }
          break
        }
        case 'shardTinkle': {
          const frequency = 2800 + Math.random() * 2800
          const detune = (Math.random() - 0.5) * 20
          oscillator(output, time, 0.16, frequency, frequency * 0.94, 0.065, 'sine', detune)
          break
        }
        case 'respawn':
          oscillator(output, time, 0.18, 330, 440, 0.12)
          oscillator(output, time + 0.1, 0.2, 494, 660, 0.11)
          oscillator(output, time + 0.2, 0.24, 660, 880, 0.1)
          break
        case 'door':
          noiseBurst(output, time, 0.35, 0.14, 'bandpass', 420)
          break
        case 'footstep':
          noiseBurst(output, time, 0.08, 0.16, 'lowpass', 480)
          break
        case 'death':
          noiseBurst(output, time, 0.35, 0.3, 'lowpass', 650)
          oscillator(output, time, 0.45, 150, 42, 0.18, 'sawtooth')
          break
      }
    },
    dispose() {
      loadCycle++
      for (const source of sampleVoices) {
        try {
          source.stop()
        } catch {
          // Already-ended sources are harmless during teardown.
        }
      }
      sampleVoices.length = 0
      buffers.clear()
      pendingUrls.clear()
      void context?.close()
      context = null
      master = null
      noise = null
    },
  }
}
