import type { MoveInput } from '../types'

export interface Input {
  readonly move: MoveInput
  readonly fire: boolean
  readonly reload: boolean
  /** E pressed this frame (edge): open/close the door or window under the crosshair. */
  readonly interact: boolean
  /**
   * Weapon slot picked this frame (edge, 1 = rifle, 2 = pistol, 3 = knife), 0 = no change.
   * Keys 1/2/3 select directly; the wheel cycles through the slots.
   */
  readonly weaponSlot: number
  readonly scoreboard: boolean
  readonly locked: boolean
  readonly pointerReleased: boolean
  releasePointer(): void
  consumeLook(): { dx: number; dy: number }
  /**
   * Re-sync the wheel's idea of the held slot (the weapon is owned by the player, not by the
   * input: a respawn or a forced switch must not leave the wheel cycling from a stale slot).
   */
  setWeaponSlot(slot: number): void
  requestLock(): void
  onLockChange(callback: (locked: boolean) => void): () => void
  /** Clear frame-edge inputs after the caller has consumed them. */
  update(): void
  dispose(): void
}

/** Slots the wheel cycles through, in order. */
const SLOT_COUNT = 3
/**
 * Wheel notches vary wildly between mice and trackpads (a mouse notch is ~120 px in Chrome, a
 * trackpad flick is dozens of events of a few px), so the delta is integrated and one event
 * can only ever move one slot: a single notch is a single weapon.
 */
const WHEEL_STEP = 40

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>()
  const lockCallbacks = new Set<(locked: boolean) => void>()
  const move: MoveInput = { forward: 0, right: 0, jump: false, crouch: false, walk: false }
  const look = { dx: 0, dy: 0 }
  const consumedLook = { dx: 0, dy: 0 }
  let fire = false
  let reload = false
  let interact = false
  let weaponSlot = 0
  let heldSlot = 1
  let wheelAccumulator = 0
  let locked = document.pointerLockElement === canvas
  let pointerReleased = false

  const selectSlot = (slot: number) => {
    if (slot < 1 || slot > SLOT_COUNT || slot === heldSlot) return
    heldSlot = slot
    weaponSlot = slot
  }

  const syncMove = () => {
    move.forward = Number(keys.has('KeyW') || keys.has('ArrowUp'))
      - Number(keys.has('KeyS') || keys.has('ArrowDown'))
    move.right = Number(keys.has('KeyD') || keys.has('ArrowRight'))
      - Number(keys.has('KeyA') || keys.has('ArrowLeft'))
    move.jump = keys.has('Space')
    move.crouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC')
    move.walk = keys.has('ShiftLeft') || keys.has('ShiftRight')
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.matches('input, textarea, select, [contenteditable=true]')) return
    if (event.code === 'KeyP' && !event.repeat) {
      event.preventDefault()
      if (locked) releasePointer()
      else if (pointerReleased) requestLock()
      return
    }
    if (event.code === 'Escape' && locked) {
      pointerReleased = false
      onBlur()
      document.exitPointerLock()
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (!locked) return
    if (event.code === 'Tab') event.preventDefault()
    if (event.code === 'KeyR' && !event.repeat) reload = true
    if (event.code === 'KeyE' && !event.repeat) interact = true
    if (!event.repeat) {
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
      if (digit) selectSlot(Number(digit[1]))
    }
    keys.add(event.code)
    syncMove()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Tab') event.preventDefault()
    keys.delete(event.code)
    syncMove()
  }
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 0 && locked) fire = true
  }
  const onMouseUp = (event: MouseEvent) => {
    if (event.button === 0) fire = false
  }
  const onWheel = (event: WheelEvent) => {
    if (!locked) return
    event.preventDefault()
    // deltaMode 1 = lines, 2 = pages; normalise both to pixels.
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)
    // A direction change starts a fresh notch, or a flick back the other way feels sticky.
    if (Math.sign(delta) !== Math.sign(wheelAccumulator)) wheelAccumulator = 0
    wheelAccumulator += delta
    if (Math.abs(wheelAccumulator) < WHEEL_STEP) return
    const step = wheelAccumulator > 0 ? 1 : -1
    wheelAccumulator = 0
    selectSlot(((heldSlot - 1 + step + SLOT_COUNT) % SLOT_COUNT) + 1)
  }
  const onMouseMove = (event: MouseEvent) => {
    if (!locked) return
    look.dx += event.movementX
    look.dy += event.movementY
  }
  const onBlur = () => {
    keys.clear()
    fire = false
    reload = interact = false
    weaponSlot = 0
    look.dx = look.dy = 0
    syncMove()
  }
  const onLock = () => {
    locked = document.pointerLockElement === canvas
    if (!locked) onBlur()
    else pointerReleased = false
    for (const callback of lockCallbacks) callback(locked)
  }
  const requestLock = () => {
    // Chrome answers with a promise, and rejects it when it refuses the lock (a click within a
    // second of Esc, a document it will not lock): swallow that, or every refusal is an
    // uncaught error in the console. The `pointerlockchange` that never comes is the signal.
    const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined
    request?.catch?.(() => {})
  }
  const releasePointer = () => {
    pointerReleased = true
    onBlur()
    if (document.pointerLockElement === canvas) document.exitPointerLock()
  }
  const onCanvasClick = () => requestLock()
  const onContextMenu = (event: Event) => event.preventDefault()

  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onLock)
  window.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)
  window.addEventListener('blur', onBlur)
  canvas.addEventListener('click', onCanvasClick)
  canvas.addEventListener('contextmenu', onContextMenu)

  return {
    move,
    get fire() { return fire },
    get reload() { return reload },
    get interact() { return interact },
    get weaponSlot() { return weaponSlot },
    get scoreboard() { return keys.has('Tab') },
    get locked() { return locked },
    get pointerReleased() { return pointerReleased },
    releasePointer,
    consumeLook() {
      consumedLook.dx = look.dx
      consumedLook.dy = look.dy
      look.dx = 0
      look.dy = 0
      return consumedLook
    },
    setWeaponSlot(slot) {
      if (slot >= 1 && slot <= SLOT_COUNT) heldSlot = slot
      wheelAccumulator = 0
    },
    requestLock,
    onLockChange(callback) {
      lockCallbacks.add(callback)
      return () => lockCallbacks.delete(callback)
    },
    update() {
      reload = false
      interact = false
      weaponSlot = 0
    },
    dispose() {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onLock)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('blur', onBlur)
      canvas.removeEventListener('click', onCanvasClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      lockCallbacks.clear()
    },
  }
}
