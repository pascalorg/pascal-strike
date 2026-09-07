import { readGraphicsPreference, saveGraphicsPreference, type Graphics, type GraphicsPreference } from '../engine/graphics'
import { el } from './dom'

export function createGraphicsSettings(graphics?: Graphics) {
  const select = el('select', { class: 'ps-input', 'aria-label': 'Graphics quality' },
    ['auto', 'low', 'medium', 'high'].map(value => el('option', { value, text: value === 'auto' ? 'Auto (recommended)' : value[0].toUpperCase() + value.slice(1) })))
  const hint = el('span', { class: 'ps-map-meta' })
  const refresh = () => {
    select.value = graphics?.preference ?? readGraphicsPreference()
    hint.textContent = select.value === 'auto'
      ? `Adjusts for your device and sustained low FPS.${graphics ? ` Currently ${graphics.quality}.` : ''}`
      : 'Low favors frame rate; High adds finer shadows and visual effects.'
  }
  refresh()
  select.addEventListener('change', () => {
    const value = select.value as GraphicsPreference
    if (graphics) graphics.set(value)
    else saveGraphicsPreference(value)
    refresh()
  })
  const off = graphics?.onChange(refresh)
  return {
    node: el('div', { class: 'ps-field' }, [el('label', { class: 'ps-label' }, ['Graphics', select]), hint]),
    dispose() { off?.() },
  }
}
