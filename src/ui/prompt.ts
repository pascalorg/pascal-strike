/**
 * The interaction hint under the crosshair (W3-D): "E · Open door", "E · Close window".
 *
 * Styled inline rather than in `ui/styles.css` because W1-C owns that file; the values are the
 * Pascal tokens it defines (mono 12 px, muted foreground, card background, border, radius).
 * `set()` is called every frame, so it early-outs when the text has not changed.
 */
import { appRoot, el } from './dom'

export interface InteractPrompt {
  el: HTMLElement
  /** The action, e.g. "Open door". `null` hides the pill. */
  set(action: string | null): void
  /** What is currently shown (null when hidden) — read by the headless playtests. */
  readonly action: string | null
  dispose(): void
}

export function createPrompt(mount: HTMLElement = appRoot()): InteractPrompt {
  const key = el('b', { text: 'E' })
  key.style.cssText = [
    'font-family:var(--font-mono)',
    'font-size:11px',
    'font-weight:600',
    'line-height:1',
    'color:var(--fg)',
    'background:var(--card-2)',
    'border:1px solid var(--border-strong)',
    'border-radius:4px',
    'padding:3px 6px',
  ].join(';')

  const dot = el('span', { text: '·' })
  dot.style.color = 'var(--muted-2)'

  const label = el('span', { text: '' })

  const root = el('div', { class: 'ps-prompt' }, [key, dot, label])
  root.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    // 46 px below the crosshair centre: clear of the 44 px reticle, still inside the eye line.
    'transform:translate(-50%,52px)',
    'display:flex',
    'align-items:center',
    'gap:7px',
    'font-family:var(--font-mono)',
    'font-size:12px',
    'line-height:1',
    'letter-spacing:0.01em',
    'white-space:nowrap',
    'color:var(--muted)',
    'background:rgba(13,13,15,0.72)',
    'border:1px solid var(--border)',
    'border-radius:999px',
    'padding:6px 12px 6px 7px',
    'backdrop-filter:blur(6px)',
    '-webkit-backdrop-filter:blur(6px)',
    'pointer-events:none',
    'user-select:none',
    'opacity:0',
    'z-index:6',
    'transition:opacity var(--t-fast),transform var(--t-fast)',
  ].join(';')
  mount.appendChild(root)

  let current: string | null = null

  return {
    el: root,
    get action() {
      return current
    },
    set(action) {
      if (action === current) return
      current = action
      if (action === null) {
        root.style.opacity = '0'
        root.style.transform = 'translate(-50%,52px)'
        return
      }
      label.textContent = action
      root.style.opacity = '1'
      root.style.transform = 'translate(-50%,46px)'
    },
    dispose() {
      root.remove()
    },
  }
}
