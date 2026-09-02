/**
 * The landing screen: name, map, play. This is the first thing anyone sees of Pascal Strike,
 * so it gets the Pascal card treatment rather than a form.
 */
import { BUILTIN_MAPS } from '../config'
import type { MapSelection } from '../types'
import { appRoot, el } from './dom'

const NAME_KEY = 'ps.name'
/** Mirrors MAX_MAP_BYTES in storage/maps-upload; kept local so the lobby stays Supabase-free. */
const MAX_MAP_BYTES = 50 * 1024 * 1024

export interface LobbyOptions {
  /** Selectable maps; defaults to the built-ins from config. */
  maps?: MapSelection[]
  /** Room code read from `#r=`; when set the lobby switches to "joining" mode. */
  joinCode?: string | null
  /** Uploads a dropped GLB. Injected so the lobby has no hard dependency on Supabase. */
  uploader?: (file: File, onProgress: (p: number) => void) => Promise<MapSelection>
  mount?: HTMLElement
}

export interface LobbyResult {
  name: string
  map: MapSelection | null
  roomCode?: string
  /** Feedback while the caller connects ("Creating room…", or an error). */
  setStatus(message: string, kind?: 'info' | 'error' | 'ok'): void
  /** Re-enables Play after a failed connection. */
  setBusy(busy: boolean): void
  dispose(): void
}

export function showLobby(opts: LobbyOptions = {}): Promise<LobbyResult> {
  const mount = opts.mount ?? appRoot()
  const joinCode = opts.joinCode ?? null
  const joining = !!joinCode
  const maps: MapSelection[] = opts.maps ?? BUILTIN_MAPS.map((m) => ({ ...m }))
  let selected: MapSelection | null = maps[0] ?? null

  const note = el('div', { class: 'ps-note' })
  const mapsGrid = el('div', { class: 'ps-maps' })
  const progress = el('i')
  const progressBar = el('div', { class: 'ps-progress', style: 'display:none' }, [progress])

  const nameInput = el('input', {
    class: 'ps-input',
    type: 'text',
    maxlength: 16,
    placeholder: 'Your name',
    value: localStorage.getItem(NAME_KEY) ?? '',
    autocomplete: 'off',
    spellcheck: false,
  })

  const playBtn = el('button', { class: 'ps-btn ps-btn--primary ps-btn--block' }, [
    joining ? 'Join match' : 'Play',
  ])
  const codeInput = el('input', {
    class: 'ps-input',
    placeholder: 'ABC123',
    maxlength: 12,
    autocomplete: 'off',
    spellcheck: false,
  })
  const codeJoin = el('button', { class: 'ps-btn' }, ['Join'])
  const codeRow = el('div', { class: 'ps-code-row' }, [codeInput, codeJoin])
  const codeToggle = el('button', { class: 'ps-btn ps-btn--ghost' }, ['Join with code'])

  const renderMaps = () => {
    mapsGrid.replaceChildren()
    for (const map of maps) {
      const custom = !BUILTIN_MAPS.some((b) => b.id === map.id)
      const card = el(
        'button',
        {
          class: 'ps-map',
          type: 'button',
          'aria-pressed': String(selected?.id === map.id),
        },
        [
          el('span', { class: 'ps-map-name', text: map.name }),
          el('span', {
            class: 'ps-map-meta',
            text: custom ? 'Custom · uploaded' : 'Built-in · Pascal export',
          }),
        ],
      )
      card.addEventListener('click', () => {
        selected = map
        renderMaps()
      })
      mapsGrid.appendChild(card)
    }
    if (opts.uploader) {
      mapsGrid.appendChild(drop)
      mapsGrid.appendChild(progressBar)
    }
  }

  const drop = el('label', { class: 'ps-drop' }, [
    el('span', { html: '<b>Drop a Pascal GLB</b> &nbsp;·&nbsp; or click to browse' }),
  ])
  const fileInput = el('input', { type: 'file', accept: '.glb', style: 'display:none' })
  drop.appendChild(fileInput)

  const setNote = (message: string, kind: 'info' | 'error' | 'ok' = 'info') => {
    note.className = `ps-note${kind === 'error' ? ' ps-note--error' : kind === 'ok' ? ' ps-note--ok' : ''}`
    note.textContent = message
  }

  const handleFile = async (file: File | null | undefined) => {
    if (!file || !opts.uploader) return
    if (!/\.glb$/i.test(file.name)) return setNote('That is not a .glb file.', 'error')
    if (file.size > MAX_MAP_BYTES) return setNote('That map is over the 50 MB limit.', 'error')
    progressBar.style.display = ''
    progress.style.width = '4%'
    setNote(`Uploading ${file.name}…`)
    try {
      const map = await opts.uploader(file, (p) => {
        progress.style.width = `${Math.round(p * 100)}%`
      })
      maps.push(map)
      selected = map
      renderMaps()
      setNote(`${map.name} is ready — everyone in your room will load it.`, 'ok')
    } catch (err) {
      setNote((err as Error)?.message ?? 'Upload failed.', 'error')
    } finally {
      window.setTimeout(() => {
        progressBar.style.display = 'none'
      }, 600)
    }
  }

  fileInput.addEventListener('change', () => void handleFile(fileInput.files?.[0]))
  for (const type of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(type, (e) => {
      e.preventDefault()
      drop.classList.add('is-over')
    })
  }
  for (const type of ['dragleave', 'drop'] as const) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'))
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    void handleFile(e.dataTransfer?.files?.[0])
  })

  renderMaps()

  const card = el('div', { class: 'ps-card' }, [
    joining
      ? el('div', { class: 'ps-join-chip' }, [
          el('span', { class: 'ps-dot' }),
          `Joining room ${joinCode}`,
        ])
      : null,
    el('h1', { class: 'ps-title', html: 'Pascal <em>Strike</em>' }),
    el('p', {
      class: 'ps-tagline',
      html: 'Build it in Pascal. <b>Paint it here.</b><br>3v3 paintball deathmatch in your own houses.',
    }),
    el('div', { class: 'ps-field' }, [
      el('label', { class: 'ps-label', text: 'Call sign' }),
      nameInput,
    ]),
    joining
      ? el('div', { class: 'ps-field' }, [
          el('label', { class: 'ps-label', text: 'Map' }),
          el('div', { class: 'ps-map-meta', text: 'The host picks the map for this room.' }),
        ])
      : el('div', { class: 'ps-field' }, [
          el('label', { class: 'ps-label', text: 'Map' }),
          mapsGrid,
        ]),
    el('div', { class: 'ps-actions' }, [
      playBtn,
      note,
      joining
        ? null
        : el('div', { class: 'ps-secondary' }, [codeToggle, el('span', { class: 'ps-map-meta', text: '3v3 · bots fill empty slots' })]),
      joining ? null : codeRow,
    ]),
    el('div', { class: 'ps-foot' }, [
      el('span', { text: 'Desktop only · WASD + mouse' }),
      el('span', { text: 'A Pascal showcase' }),
    ]),
  ])

  const screen = el('div', { class: 'ps-screen' }, [
    el('div', { class: 'ps-brand' }, [
      el('img', { src: '/brand/pascal-logo-full.svg', alt: 'Pascal' }),
      el('span', { text: 'Strike' }),
    ]),
    card,
  ])

  mount.appendChild(screen)
  window.setTimeout(() => nameInput.focus(), 60)

  return new Promise<LobbyResult>((resolve) => {
    const result: LobbyResult = {
      name: '',
      map: null,
      setStatus: setNote,
      setBusy(busy) {
        playBtn.toggleAttribute('disabled', busy)
        playBtn.replaceChildren()
        if (busy) playBtn.appendChild(el('span', { class: 'ps-spinner' }))
        playBtn.appendChild(
          document.createTextNode(busy ? 'Connecting…' : joining ? 'Join match' : 'Play'),
        )
      },
      dispose() {
        screen.remove()
      },
    }

    const finish = (roomCode?: string) => {
      const name = (nameInput.value || '').trim().slice(0, 16) || 'Player'
      localStorage.setItem(NAME_KEY, name)
      result.name = name
      result.map = joining || roomCode ? null : selected
      result.roomCode = roomCode ?? joinCode ?? undefined
      result.setBusy(true)
      setNote(roomCode || joining ? 'Joining room…' : 'Creating room…')
      resolve(result)
    }

    playBtn.addEventListener('click', () => finish())
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish()
    })
    codeToggle.addEventListener('click', () => {
      codeRow.classList.toggle('is-open')
      if (codeRow.classList.contains('is-open')) codeInput.focus()
    })
    const joinByCode = () => {
      const code = codeInput.value.trim().replace(/^R/i, '')
      if (!code) return setNote('Enter the room code your friend sent you.', 'error')
      finish(code)
    }
    codeJoin.addEventListener('click', joinByCode)
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinByCode()
    })
  })
}
