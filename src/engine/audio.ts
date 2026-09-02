import { Vector3 } from 'three'

export type SoundName =
  | 'shot'
  | 'splat'
  | 'hit'
  | 'hitConfirm'
  | 'reload'
  | 'respawn'
  | 'door'
  | 'footstep'
  | 'death'
  | 'dryFire'

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
  ): void {
    const ctx = context!
    const osc = ctx.createOscillator()
    const envelope = ctx.createGain()
    osc.type = type
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

  return {
    async resume() {
      const ctx = initialise()
      if (ctx.state !== 'running') await ctx.resume()
    },
    play(name, at, listener, gain = 1) {
      const ctx = initialise()
      if (ctx.state !== 'running') return
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
      void context?.close()
      context = null
      master = null
      noise = null
    },
  }
}
