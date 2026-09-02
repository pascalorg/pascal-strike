import type { MoveInput } from '../types'

export interface Input {
  readonly move: MoveInput
  readonly fire: boolean
  readonly reload: boolean
  readonly scoreboard: boolean
  readonly locked: boolean
  consumeLook(): { dx: number; dy: number }
  requestLock(): void
  onLockChange(callback: (locked: boolean) => void): () => void
  /** Clear frame-edge inputs after the caller has consumed them. */
  update(): void
  dispose(): void
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>()
  const lockCallbacks = new Set<(locked: boolean) => void>()
  const move: MoveInput = { forward: 0, right: 0, jump: false, crouch: false }
  const look = { dx: 0, dy: 0 }
  const consumedLook = { dx: 0, dy: 0 }
  let fire = false
  let reload = false
  let locked = document.pointerLockElement === canvas

  const syncMove = () => {
    move.forward = Number(keys.has('KeyW') || keys.has('ArrowUp'))
      - Number(keys.has('KeyS') || keys.has('ArrowDown'))
    move.right = Number(keys.has('KeyD') || keys.has('ArrowRight'))
      - Number(keys.has('KeyA') || keys.has('ArrowLeft'))
    move.jump = keys.has('Space')
    move.crouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Tab') event.preventDefault()
    if (event.code === 'KeyR' && !event.repeat) reload = true
    keys.add(event.code)
    syncMove()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Tab') event.preventDefault()
    keys.delete(event.code)
    syncMove()
  }
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) fire = true
  }
  const onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) fire = false
  }
  const onMouseMove = (event: MouseEvent) => {
    if (!locked) return
    look.dx += event.movementX
    look.dy += event.movementY
  }
  const onBlur = () => {
    keys.clear()
    fire = false
    syncMove()
  }
  const onLock = () => {
    locked = document.pointerLockElement === canvas
    if (!locked) fire = false
    for (const callback of lockCallbacks) callback(locked)
  }
  const requestLock = () => {
    void canvas.requestPointerLock()
  }
  const onCanvasClick = () => requestLock()
  const onContextMenu = (event: Event) => event.preventDefault()

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onLock)
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('blur', onBlur)
  canvas.addEventListener('click', onCanvasClick)
  canvas.addEventListener('contextmenu', onContextMenu)

  return {
    move,
    get fire() { return fire },
    get reload() { return reload },
    get scoreboard() { return keys.has('Tab') },
    get locked() { return locked },
    consumeLook() {
      consumedLook.dx = look.dx
      consumedLook.dy = look.dy
      look.dx = 0
      look.dy = 0
      return consumedLook
    },
    requestLock,
    onLockChange(callback) {
      lockCallbacks.add(callback)
      return () => lockCallbacks.delete(callback)
    },
    update() {
      reload = false
    },
    dispose() {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onLock)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', onBlur)
      canvas.removeEventListener('click', onCanvasClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      lockCallbacks.clear()
    },
  }
}
