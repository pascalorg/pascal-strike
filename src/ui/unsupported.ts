/** Touch devices and browsers with neither WebGPU nor WebGL2 get this instead of the game. */
import { appRoot, el } from './dom'

export type UnsupportedReason = 'mobile' | 'gpu' | 'unknown'

export interface UnsupportedScreen {
  el: HTMLElement
  dispose(): void
}

const COPY: Record<UnsupportedReason, { title: string; body: string }> = {
  mobile: {
    title: 'Play on <em>desktop</em>',
    body: 'Pascal Strike needs a mouse and keyboard — pointer lock, WASD, and a real GPU. Open this link on your computer and you are in.',
  },
  gpu: {
    title: 'No <em>GPU</em> here',
    body: 'This browser exposes neither WebGPU nor WebGL2. Try the latest Chrome, Edge or Firefox on a desktop machine.',
  },
  unknown: {
    title: 'Not <em>supported</em>',
    body: 'This browser cannot run Pascal Strike. Try the latest Chrome, Edge or Firefox on a desktop machine.',
  },
}

export function showUnsupported(
  reason: UnsupportedReason = 'unknown',
  mount: HTMLElement = appRoot(),
): UnsupportedScreen {
  const copy = COPY[reason]
  const screen = el('div', { class: 'ps-screen' }, [
    el('div', { class: 'ps-brand' }, [
      el('img', { src: '/brand/pascal-logo-full.svg', alt: 'Pascal' }),
      el('span', { text: 'Strike' }),
    ]),
    el('div', { class: 'ps-card ps-unsupported' }, [
      el('h1', { class: 'ps-title', html: copy.title }),
      el('p', { text: copy.body }),
      el('div', { class: 'ps-foot', style: 'justify-content:center' }, [
        el('span', { text: 'Build it in Pascal. Paint it here.' }),
      ]),
    ]),
  ])
  mount.appendChild(screen)
  return { el: screen, dispose: () => screen.remove() }
}

/** True for touch-only devices — the game is desktop only by design. */
export function isTouchOnly(): boolean {
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches
}
