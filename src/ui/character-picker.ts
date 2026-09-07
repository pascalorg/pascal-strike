import { DEFAULT_CHARACTERS, parseCharacter, readCharacter, saveCharacter, STUDIO_ORIGIN } from '../characters/catalog'
import { loadCharacterAsset } from '../characters/assets'
import type { CharacterSelection } from '../types'
import { el } from './dom'
import { createCharacterPreview } from './character-preview'

export function createCharacterPicker() {
  let selected = readCharacter()
  let custom = DEFAULT_CHARACTERS.some(c => c.id === selected.id) ? null : selected
  let disposed = false
  let closeCreator: (() => void) | undefined
  let request = 0
  const status = el('div', { class: 'ps-character-status', role: 'status', 'aria-live': 'polite', text: 'Loading character…' })
  const stage = el('div', { class: 'ps-character-stage' })
  const title = el('h2', { class: 'ps-character-name', text: selected.name })
  const cards = el('div', { class: 'ps-character-options', role: 'group', 'aria-label': 'Choose your character' })
  const create = el('button', { type: 'button', class: 'ps-btn ps-btn--block ps-create-character', text: '+ Create my character' })
  const node = el('section', { class: 'ps-character-picker', 'aria-label': 'Your character' }, [
    el('div', { class: 'ps-character-eyebrow', text: 'YOUR PLAYER' }),
    stage,
    el('div', { class: 'ps-character-caption' }, [title, el('span', { text: 'Drag to rotate', class: 'ps-map-meta' })]),
    cards, create, status,
    el('a', { class: 'ps-studio-credit', href: STUDIO_ORIGIN, target: '_blank', rel: 'noopener', text: 'Made with Character Studio ↗' }),
  ])
  const preview = createCharacterPreview(stage)
  void preview.then(p => { if (disposed) p.dispose() }).catch(() => {})
  async function select(character: CharacterSelection) {
    const current = ++request
    selected = character; saveCharacter(character); title.textContent = character.name; renderCards()
    status.textContent = 'Loading character…'
    try {
      const p = await preview
      if (disposed || current !== request) return
      await p.show(character)
      if (!disposed && current === request) status.textContent = 'Ready to play'
    } catch { if (!disposed && current === request) status.textContent = 'Preview unavailable. Choose a character again to retry.' }
  }
  function renderCards() {
    cards.replaceChildren()
    for (const character of [...DEFAULT_CHARACTERS, ...(custom ? [custom] : [])]) {
      const button = el('button', { type: 'button', class: 'ps-character-option', 'aria-pressed': String(selected.id === character.id), 'aria-label': `Select ${character.name}` }, [
        DEFAULT_CHARACTERS.includes(character)
          ? el('img', { src: `/characters/${character.id}.png`, alt: '', loading: 'lazy' })
          : el('span', { class: 'ps-character-custom-icon', text: '★' }),
        el('span', { text: character.name }),
      ])
      button.addEventListener('click', () => void select(character))
      cards.appendChild(button)
    }
  }
  create.addEventListener('click', () => {
    const dialog = el('dialog', { class: 'ps-studio-dialog', 'aria-labelledby': 'ps-studio-title' })
    const note = el('div', { class: 'ps-studio-note', role: 'status', text: 'Opening Character Studio…' })
    const close = el('button', { type: 'button', class: 'ps-btn ps-btn--ghost', text: 'Close', 'aria-label': 'Close character creator' })
    const iframe = el('iframe', { title: 'Character Studio creator', allow: 'clipboard-write', referrerpolicy: 'strict-origin-when-cross-origin' })
    iframe.src = `${STUDIO_ORIGIN}/embed?${new URLSearchParams({ origin: location.origin, gender: selected.gender })}`
    dialog.append(el('div', { class: 'ps-studio-header' }, [el('h2', { id: 'ps-studio-title', text: 'Create my character' }), close]), note, iframe)
    document.body.appendChild(dialog)
    let closed = false, importing = false
    const timeout = window.setTimeout(() => { note.textContent = 'Studio is taking longer to load. You can close this window and try again.' }, 30000)
    const cleanup = () => {
      if (closed) return
      closed = true; window.clearTimeout(timeout)
      window.removeEventListener('message', message)
      dialog.close(); dialog.remove(); closeCreator = undefined
      create.focus()
    }
    const message = async (event: MessageEvent) => {
      if (closed || event.origin !== STUDIO_ORIGIN || event.source !== iframe.contentWindow || !event.data || typeof event.data !== 'object') return
      const data = event.data
      if (data.type === 'cs.v1.ready') { window.clearTimeout(timeout); note.textContent = 'Customize your player, then choose Done to bring them into the game.' }
      if (data.type === 'cs.v1.error') { window.clearTimeout(timeout); note.textContent = typeof data.message === 'string' ? data.message : 'Studio could not save. Please try again.' }
      if (data.type !== 'cs.v1.character.exported' || importing) return
      const character = parseCharacter({ id: data.bakeId, name: data.name || 'My character', gender: data.gender, manifestUrl: data.manifestUrl })
      if (!character) { note.textContent = 'Studio returned an unsupported character. Please try exporting again.'; return }
      importing = true; note.textContent = 'Preparing your character and animations for the game…'
      try {
        await loadCharacterAsset(character)
        if (closed || disposed) return
        custom = character; void select(character); cleanup()
      } catch (error) {
        note.textContent = `${error instanceof Error ? error.message : 'Could not load your character.'} Choose Done again to retry.`
      }
      finally { importing = false }
    }
    window.addEventListener('message', message)
    close.addEventListener('click', cleanup)
    dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup() })
    closeCreator = cleanup
    dialog.showModal(); close.focus()
  })
  void select(selected)
  return { node, get selection() { return selected }, dispose() {
    disposed = true; request++; closeCreator?.(); void preview.then(p => p.dispose()).catch(() => {}); node.remove()
  } }
}
