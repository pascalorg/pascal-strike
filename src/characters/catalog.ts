import type { CharacterSelection } from '../types'

export const STUDIO_ORIGIN = new URL(import.meta.env.VITE_CHARACTER_STUDIO_URL || 'https://characterstudio.wawasensei.dev').origin
export const DEFAULT_CHARACTERS: CharacterSelection[] = [
  { id: 'wawa', name: 'Wawa', gender: 'man', manifestUrl: '/characters/wawa.manifest.json' },
  { id: 'brian', name: 'Brian', gender: 'man', manifestUrl: '/characters/brian.manifest.json' },
  { id: 'janette', name: 'Janette', gender: 'woman', manifestUrl: '/characters/janette.manifest.json' },
  { id: 'nova', name: 'Nova', gender: 'woman', manifestUrl: '/characters/nova.manifest.json' },
]

export function defaultCharacter(seed = ''): CharacterSelection {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return DEFAULT_CHARACTERS[hash % DEFAULT_CHARACTERS.length]
}

/** Only pinned Studio manifests may enter via storage, network state or postMessage. */
export function parseCharacter(value: unknown): CharacterSelection | null {
  if (!value || typeof value !== 'object') return null
  const c = value as Record<string, unknown>
  const preset = DEFAULT_CHARACTERS.find(p => p.id === c.id)
  if (preset) return preset
  if (typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) ||
      typeof c.name !== 'string' || !['man', 'woman'].includes(c.gender as string) ||
      typeof c.manifestUrl !== 'string') return null
  try {
    const url = new URL(c.manifestUrl)
    if (url.origin !== STUDIO_ORIGIN || !/^\/api\/models\/b\/[a-zA-Z0-9_-]+\.json$/.test(url.pathname) || url.search || url.hash) return null
    return { id: c.id, name: c.name.slice(0, 32) || 'My character', gender: c.gender as 'man' | 'woman', manifestUrl: url.href }
  } catch { return null }
}

export function readCharacter(): CharacterSelection {
  try { return parseCharacter(JSON.parse(localStorage.getItem('ps.character') || 'null')) ?? DEFAULT_CHARACTERS[0] }
  catch { return DEFAULT_CHARACTERS[0] }
}

export function saveCharacter(character: CharacterSelection): void {
  try { localStorage.setItem('ps.character', JSON.stringify(character)) } catch { /* Selection still works without storage. */ }
}
