import { el } from './dom'

/** The lobby's map-building guide. Native dialog supplies focus trapping and modal semantics. */
export function createMapGuide() {
  const trigger = el('button', {
    type: 'button', class: 'ps-build-link', text: 'Build it in Pascal', 'aria-haspopup': 'dialog',
  })
  let closeGuide: (() => void) | undefined

  trigger.addEventListener('click', () => {
    if (closeGuide) return
    const close = el('button', { type: 'button', class: 'ps-btn ps-btn--ghost', text: 'Close', 'aria-label': 'Close map instructions' })
    const dialog = el('dialog', { class: 'ps-map-guide', 'aria-labelledby': 'ps-map-guide-title' }, [
      el('div', { class: 'ps-map-guide-header' }, [
        el('h2', { id: 'ps-map-guide-title', text: 'Build it in Pascal' }), close,
      ]),
      el('p', { class: 'ps-tagline', text: 'Turn your house into a paintball map.' }),
      el('ol', { class: 'ps-map-guide-steps' }, [
        el('li', {}, [
          el('h3', { text: 'Build your map' }),
          el('p', { text: 'Create a project in Pascal. Give both teams cover and connected routes to explore.' }),
        ]),
        el('li', {}, [
          el('h3', { text: 'Name your spawn zones' }),
          el('p', { text: 'Draw zones on open, walkable floor and give them these names:' }),
          el('div', { class: 'ps-map-guide-spawns' }, [
            el('div', { class: 'ps-map-guide-spawn ps-map-guide-spawn--a' }, [el('code', { text: 'Spawn A' }), el('span', { text: 'Orange team' })]),
            el('div', { class: 'ps-map-guide-spawn ps-map-guide-spawn--b' }, [el('code', { text: 'Spawn B' }), el('span', { text: 'Teal team' })]),
          ]),
          el('p', { text: 'Names decide the team, regardless of the zone color. You can use several zones with the same name for each team. Leave enough room for players to stand and move.' }),
          el('p', { class: 'ps-map-guide-note', text: 'Team spawns use zones. Pascal’s walkthrough start marker is separate. Without team zones, Strike picks starting positions automatically.' }),
        ]),
        el('li', {}, [
          el('h3', { text: 'Export and play' }),
          el('p', { text: 'Export a baked GLB from Pascal. Back here, choose “Private · invite friends” and drop the file onto the map picker. Create your room, then share the invite link.' }),
        ]),
      ]),
      el('a', { class: 'ps-btn ps-btn--primary ps-btn--block', href: 'https://editor.pascal.app', target: '_blank', rel: 'noopener noreferrer', text: 'Open Pascal editor ↗' }),
    ])
    let closed = false
    const cleanup = (restoreFocus = true) => {
      if (closed) return
      closed = true
      dialog.close()
      dialog.remove()
      closeGuide = undefined
      if (restoreFocus && trigger.isConnected) trigger.focus()
    }
    closeGuide = () => cleanup(false)
    close.addEventListener('click', () => cleanup())
    dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup() })
    dialog.addEventListener('close', () => cleanup())
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return
      const rect = dialog.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cleanup()
    })
    document.body.appendChild(dialog)
    dialog.showModal()
    close.focus()
  })

  return { trigger, dispose() { closeGuide?.() } }
}
