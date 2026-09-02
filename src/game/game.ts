/**
 * The orchestrator (W2): map + player + weapons + net + bots + HUD, wired together.
 *
 * Everything below is glue. The rules live on the host (`net/host.ts`), the physics in
 * `player/controller.ts`, the transport in `net/*` — this file only decides who talks to whom
 * and in which order each frame:
 *
 *   fixed step : local controller → bot runner (host only)
 *   frame      : look/camera/marker → net interpolation → avatars → projectiles → doors → HUD
 */
import { Vector3 } from 'three'
import { BUILTIN_MAPS, DOORS, PLAYER, TEAMS } from '../config'
import { createAudio, type Audio } from '../engine/audio'
import { createEventBus } from '../engine/events'
import { createInput } from '../engine/input'
import { createLoaders } from '../engine/loaders'
import { createRenderer, type Engine } from '../engine/renderer'
import { createNavMeshHelper } from '../map/navmesh'
import { bindNetToRegistry } from '../net/client'
import {
  BOTS_FILL_DEFAULT,
  botsFillFrom,
  botsFillIsSet,
  botsFillValue,
  GS,
  RPCS,
  type DoorEvent,
  type DoorStates,
  type FellEvent,
} from '../net/protocol'
import type { Room } from '../net/room'
import { createClock, createSnapshotSender } from '../net/sync'
import type { DoorInfo, Hittable, MapSelection, MatchState, TeamId } from '../types'
import { createHud } from '../ui/hud'
import { createPrompt } from '../ui/prompt'
import { createScoreboard } from '../ui/scoreboard'
import { createEntityRegistry } from './entities'
import { createHostSide } from './host-side'
import { createLocalPlayer, type LocalPlayer } from './local-player'
import { createMapSession, type MapSession } from './map-session'
import { msLeft } from './match'
import {
  createDebugPanel,
  createLoadingOverlay,
  createPauseMenu,
  statusSnapshot,
  type GameStatus,
} from './overlays'
import { createRemotePlayers } from './remote-players'

export interface GameOptions {
  room: Room
  /** Map the host picked in the lobby; joiners pass null and wait for the room state. */
  map: MapSelection | null
  /**
   * "Fill empty slots with bots" from the lobby. Like `map`, only the room creator passes it;
   * a joiner leaves it undefined and adopts whatever the room already says.
   */
  botsFill?: boolean
  mount: HTMLElement
  debug?: boolean
}

export interface Game {
  engine: Engine
  dispose(): void
}

const MAP_POLL_MS = 500
const HUD_POLL_MS = 100

const _hittables: Hittable[] = []
const _damageDir = new Vector3()
const _shotOrigin = new Vector3()

export async function startGame(opts: GameOptions): Promise<Game> {
  const { room, mount } = opts
  const debugMode = opts.debug ?? new URLSearchParams(location.search).get('debug') === '1'

  const loading = createLoadingOverlay(mount)
  loading.set(0, 'Waiting for the host to pick a map')
  const selection = await resolveMapSelection(room, opts.map)
  // Same rule as the map: the creator publishes its lobby answer, everyone else adopts the
  // room's. Never overwrite a value that is already there — a joiner must not reset the host.
  if (room.isHost() && !botsFillIsSet(room.getGlobal<unknown>(GS.botsFill))) {
    room.setGlobal(GS.botsFill, botsFillValue(opts.botsFill ?? BOTS_FILL_DEFAULT), true)
  }

  const engine = await createRenderer(mount)
  const loaders = createLoaders(engine.renderer)
  const rawAudio = createAudio()
  let muted = false
  const audio: Audio = {
    resume: () => rawAudio.resume(),
    play: (name, at, listener) => {
      if (!muted) rawAudio.play(name, at, listener)
    },
    dispose: () => rawAudio.dispose(),
  }
  const input = createInput(engine.renderer.domElement as HTMLCanvasElement)
  const events = createEventBus()
  const registry = createEntityRegistry()
  const clock = createClock(room)
  const binding = bindNetToRegistry(room, registry, events, clock)

  const hud = createHud(mount)
  const prompt = createPrompt(mount)
  const board = createScoreboard({ mount, now: () => clock.now(), localId: room.me.id })
  hud.setRoom(room.roomCode, room.inviteUrl)
  hud.setFps(debugMode ? 0 : null)

  const remotePlayers = createRemotePlayers(engine.scene, registry)

  // Declared before the first `buildSession`/`makeLocalPlayer` call: both close over them.
  let match: MatchState | null = null
  let disposed = false
  let deathAt = 0
  let lastTeam: TeamId | null = null

  /**
   * Null only while a map change is in flight. The frame loop keeps running between
   * `dispose()` and the next `buildSession()`, and every consumer of the session (bots,
   * projectiles, doors, environment) must stop touching it in that window: a bot asking a
   * freed recast navmesh for a path hangs the main thread for good.
   */
  let session: MapSession | null = await buildSession(selection)
  const localPlayer = makeLocalPlayer(session)

  // --- map session lifecycle ----------------------------------------------

  async function buildSession(next: MapSelection): Promise<MapSession> {
    const built = await createMapSession({
      engine,
      loaders,
      selection: next,
      audio,
      effects: {
        hitMarker: () => hud.hitMarker(),
        damageVignette: (team) => hud.damageFrom(null, team),
      },
      onProgress: (progress, label) => loading.set(progress, label),
    })
    built.doors.onToggle((door) => audio.play('door', door.center, localPlayer.listener))
    // Late join / map change: adopt the house as it is. `instant` jumps each clip to its end
    // pose, so nothing swings (or whooshes) on the first frame.
    const states = room.getGlobal<DoorStates>(GS.doors)
    if (states) {
      for (const door of built.map.doors) {
        if (states[door.id] === true) built.doors.setOpen(door.id, true, true)
      }
    }
    built.projectiles.onPlayerHit((hit) => {
      // My shots and (on the host) my bots' shots both land here; the host validates either way.
      const authority = hostSide.authority
      if (authority) authority.submitHit(hit)
      else if (hit.by === room.me.id) void room.rpc.call(RPCS.hit, hit, 'host')
    })
    return built
  }

  /** Built once and kept across map changes — `setSession` swaps the world under it. */
  function makeLocalPlayer(current: MapSession): LocalPlayer {
    const me = registry.upsert({ id: room.me.id, isLocal: true })
    const player = createLocalPlayer({
      engine,
      input,
      audio,
      session: current,
      entity: me,
      now: () => clock.now(),
      onShot: (shot) => {
        // Always the *live* session: a shot fired on the frame a map change starts must not
        // land in the house we just disposed.
        session?.projectiles.spawn(shot, { detectPlayers: true })
        void room.rpc.call(RPCS.shot, shot, 'others')
      },
      onFell: () => {
        if (hostSide.authority) hostSide.authority.respawnPlayer(room.me.id)
        else void room.rpc.call(RPCS.fell, { player: room.me.id } as FellEvent, 'host')
      },
    })
    // Until the host's first `respawn` lands, stand somewhere sane rather than at the origin.
    if (me.position.lengthSq() > 1e-6) player.place(me.position, me.yaw)
    else placeAtSpawn(player, current)
    lastTeam = me.team
    player.setTeam(me.team)
    return player
  }

  /** Put the local player on a spawn point of `current` (boot, and after a map change). */
  function placeAtSpawn(player: LocalPlayer, current: MapSession): void {
    const spawn = current.leastCrowdedSpawn(registry.local?.team ?? 'a', EMPTY_POSITIONS)
    if (spawn) player.place(spawn.position, spawn.yaw)
  }

  /** The map we are actually standing in — `session` is null for the length of a change. */
  let loadedUrl = selection.url
  let changing: Promise<void> | null = null
  async function changeMap(next: MapSelection): Promise<void> {
    if (disposed || !session || next.url === loadedUrl) return
    const previous = session
    loading.show()
    loading.set(0, `Loading ${next.name}`)
    // Door ids are per map: the previous house's state must not leak into the new one.
    if (room.isHost()) room.setGlobal(GS.doors, {}, true)
    // From here until the new session exists, nothing may touch the old one. Clearing
    // `session` freezes the update/render hooks, and the bot runner — which holds the recast
    // navmesh `dispose()` is about to free — is stopped *before* that free, not after.
    session = null
    hostSide.suspend()
    remotePlayers.clear()
    if (navHelper) {
      engine.scene.remove(navHelper)
      navHelper = null
    }
    previous.dispose()

    // A failed load leaves `session` null (nothing to fall back to — the old house is gone),
    // but `loadedUrl` still points at it, so the map poll retries on the next tick.
    const built = await buildSession(next)
    if (disposed) {
      built.dispose()
      return
    }
    session = built
    loadedUrl = next.url
    localPlayer.setSession(built)
    placeAtSpawn(localPlayer, built)
    // Old-map coordinates mean nothing in the new house: the host puts everyone (bots
    // included) back on a spawn point of the map that just loaded, and only then does the
    // rebuilt runner pick the bots up — at their new spawns, on the new navmesh.
    hostSide.authority?.respawnAll()
    hostSide.reload()
    loading.hide()
  }

  // --- host side (rules + bots), only while we are the host ----------------
  // Built after the session exists: the authority ticks once on creation and its spawn
  // provider reads `session`. The callbacks above only touch `hostSide` from later frames.

  const hostSide = createHostSide({
    room,
    registry,
    events,
    clock,
    audio,
    session: () => session,
    listener: () => localPlayer.listener,
  })

  // --- net events ----------------------------------------------------------

  const sender = createSnapshotSender(room, () => (localPlayer.dead ? null : localPlayer.snapshot()))

  events.on('shot', (shot) => {
    if (shot.by === room.me.id || !session) return
    session.projectiles.spawn(shot, { detectPlayers: false })
    _shotOrigin.set(shot.origin[0], shot.origin[1], shot.origin[2])
    audio.play('shot', _shotOrigin, localPlayer.listener)
  })

  events.on('damage', (dmg) => {
    // W3-B: the host names the body part, so the feedback can differ per part — a headshot
    // marker for the shooter, a heavier paint splash for the victim, paint on the victim's body.
    const byTeam = registry.get(dmg.by)?.team ?? 'b'
    if (dmg.by === room.me.id && dmg.target !== room.me.id) {
      hud.hitMarker(dmg.part, registry.local?.team)
    }
    if (dmg.target === room.me.id) {
      hud.setHp(dmg.hp)
      hud.paintHit(viewSpaceDirection(dmg.point), byTeam, dmg.part)
      audio.play('hit')
    } else {
      remotePlayers.flashHit(dmg.target)
      remotePlayers.splat(dmg.target, dmg.point, TEAMS[byTeam].colorHex)
    }
  })

  events.on('kill', (kill) => {
    const killer = registry.get(kill.killer)
    const victim = registry.get(kill.victim)
    hud.killFeed({
      killer: kill.killer,
      victim: kill.victim,
      killerTeam: kill.killerTeam,
      victimTeam: kill.victimTeam,
      killerName: killer?.name,
      victimName: victim?.name,
      killerBot: killer?.isBot,
      victimBot: victim?.isBot,
    })
    if (kill.victim === room.me.id) {
      localPlayer.die()
      deathAt = clock.now()
      audio.play('death')
    } else {
      remotePlayers.kill(kill.victim, TEAMS[kill.killerTeam].colorHex)
      if (victim) audio.play('death', victim.position, localPlayer.listener)
    }
  })

  events.on('respawn', (ev) => {
    if (ev.player === room.me.id) {
      localPlayer.place(ev.position, ev.yaw)
      localPlayer.revive()
      deathAt = 0
      hud.setRespawn(0)
      hud.setHp(PLAYER.maxHp)
      audio.play('respawn')
      return
    }
    remotePlayers.spawn(ev.player)
  })

  // --- doors and windows (W3-D) --------------------------------------------
  // Openables are peer-decided: whoever presses E broadcasts the new state to everyone (ALL,
  // so we apply our own call too) and the host mirrors the result into the room state for
  // late joiners. No prediction, no host round trip — a 1 s clip hides the latency.

  let interactPressed = false
  let interactTarget: DoorInfo | null = null

  function publishDoorStates(): void {
    if (!room.isHost() || !session) return
    room.setGlobal(GS.doors, session.doors.openStates(), true)
  }

  const offDoorRpc = room.rpc.register<DoorEvent>(RPCS.door, (ev) => {
    if (!ev?.id || !session) return
    session.doors.setOpen(ev.id, ev.open === true)
    // The host remembers who did it: bots must not re-open what a player just closed.
    hostSide.noteDoor(ev)
    publishDoorStates()
  })

  /** Runs after `frameUpdate`, so the ray uses this frame's camera pose. */
  function updateInteract(pressed: boolean): void {
    if (!session || localPlayer.dead) {
      interactTarget = null
      prompt.set(null)
      return
    }
    const eye = localPlayer.listener
    interactTarget = session.doors.findInteractable(eye.position, eye.forward, DOORS.interactRange)
    if (!interactTarget) {
      prompt.set(null)
      return
    }
    const open = session.doors.isOpen(interactTarget.id)
    prompt.set(`${open ? 'Close' : 'Open'} ${interactTarget.kind ?? 'door'}`)
    if (!pressed) return
    const payload: DoorEvent = { id: interactTarget.id, open: !open, by: room.me.id }
    void room.rpc.call(RPCS.door, payload, 'all')
  }

  // --- frame ---------------------------------------------------------------

  let lastMapPoll = 0
  let lastHudPoll = 0
  let lastHp = -1
  let lastHopper = -1
  let lastReloading = false
  let lastPhase: string | null = null
  let endedRound = -1
  let boardOpen = false
  let fps = 60

  const offUpdate = engine.onUpdate((dt) => {
    // No session means a map change is in flight: the old world is disposed and the next one
    // is still loading. Simulating anything against it (bots above all) is what used to hang.
    if (!session) return
    localPlayer.fixedUpdate(dt)
    hostSide.bots?.update(dt)
  })

  const offRender = engine.onRender((_alpha, dt) => {
    const now = clock.now()
    fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.08

    // Before the session guard: this is also how a change that failed to load gets retried.
    if (now - lastMapPoll > MAP_POLL_MS) {
      lastMapPoll = now
      const wanted = room.getGlobal<MapSelection>(GS.map)
      if (wanted?.url && wanted.url !== loadedUrl && !changing) {
        changing = changeMap(wanted).finally(() => {
          changing = null
        })
      }
    }

    if (!session) {
      // Frozen for the duration of the map change (the loading overlay covers the screen).
      // Input still has to be drained, or the whole transition arrives as one look jump.
      input.consumeLook()
      input.update()
      return
    }

    // `frameUpdate` ends with `input.update()`, which clears the edge — read E before it.
    if (input.locked && input.interact) interactPressed = true
    localPlayer.frameUpdate(dt)
    binding.update(now)
    remotePlayers.update(now, localPlayer.listener.position)

    session.doors.update(dt)
    updateInteract(interactPressed)
    interactPressed = false

    _hittables.length = 0
    for (const h of remotePlayers.hittables()) _hittables.push(h)
    _hittables.push(localPlayer.hittable())
    session.projectiles.update(dt, _hittables)
    session.effects.update(dt)
    session.environment.update(localPlayer.position)

    if (now - lastHudPoll > HUD_POLL_MS) {
      lastHudPoll = now
      updateHud(now)
    }

    // While the round is over the end screen owns the board: `board.show()` would paint the
    // winner banner away and `board.hide()` cannot take it back (the end screen is not
    // dismissible). `updateHud` refuses to refresh the board in that phase for the same
    // reason — the two must agree, or Tab erases the result.
    if (match?.phase !== 'ended' && input.scoreboard !== boardOpen) {
      boardOpen = input.scoreboard
      if (boardOpen) board.show(registry.list(), match)
      else board.hide()
    }
  })

  function updateHud(now: number): void {
    match = room.getGlobal<MatchState>(GS.match) ?? hostSide.authority?.match.state ?? match
    const me = registry.local

    if (me) {
      if (me.hp !== lastHp) {
        lastHp = me.hp
        hud.setHp(me.hp)
      }
      if (me.team !== lastTeam) {
        lastTeam = me.team
        localPlayer.setTeam(me.team)
      }
      hud.setInvincible(me.alive && me.invincibleUntil > now)
      if (!me.alive) {
        // `setRespawn(0)` means "hide the overlay", so the countdown is clamped to 1 ms
        // instead: it reads 0.0 for its last frames rather than sticking at 0.1.
        const left = PLAYER.respawnDelayMs - (now - (deathAt || now))
        hud.setRespawn(Math.max(1, left))
        if (!localPlayer.dead) localPlayer.die()
      } else if (localPlayer.dead) {
        // Reliable state beat the respawn RPC (or it was dropped) — unfreeze anyway.
        localPlayer.revive()
        hud.setRespawn(0)
      }
    }

    const marker = localPlayer.marker
    if (marker.hopper !== lastHopper || marker.reloading !== lastReloading) {
      lastHopper = marker.hopper
      lastReloading = marker.reloading
      hud.setHopper(marker.hopper, marker.reloading)
    }
    hud.setSpread(localPlayer.spread)

    if (match) {
      hud.setScores(match.scores.a, match.scores.b, msLeft(match, now))
      if (match.phase !== lastPhase) {
        lastPhase = match.phase
        hud.setPhase(match.phase, match.round)
      }
      if (match.phase === 'ended' && endedRound !== match.round) {
        endedRound = match.round
        board.end(match, registry.list())
      }
      if (match.phase !== 'ended' && boardOpen) board.show(registry.list(), match)
    }
    if (debugMode) {
      hud.setFps(fps)
      debugPanel.update()
    }
  }

  /** Direction (view space, x = right, y = forward) from the local player to a world point. */
  function viewSpaceDirection(point: [number, number, number]): [number, number] | null {
    _damageDir.set(point[0], point[1], point[2]).sub(localPlayer.position)
    const sin = Math.sin(localPlayer.yaw)
    const cos = Math.cos(localPlayer.yaw)
    const forward = -_damageDir.x * sin - _damageDir.z * cos
    const right = _damageDir.x * cos - _damageDir.z * sin
    const length = Math.hypot(forward, right)
    if (length < 1e-4) return null
    return [right / length, forward / length]
  }

  // --- menu, debug overlays ------------------------------------------------

  const menu = createPauseMenu({
    mount,
    room,
    isHost: () => room.isHost(),
    onResume: () => input.requestLock(),
    onMap: (next) => {
      if (hostSide.authority) hostSide.authority.setMap(next)
      else room.setGlobal(GS.map, next, true)
    },
    botsFill: () => botsFillFrom(room.getGlobal<unknown>(GS.botsFill)),
    setBotsFill: (on) => {
      // The menu only offers this to the host; the authority kicks or refills on its next tick.
      if (hostSide.authority) hostSide.authority.setBotsFill(on)
      else if (room.isHost()) room.setGlobal(GS.botsFill, botsFillValue(on), true)
    },
    onAudio: (on) => {
      muted = !on
      if (on) void audio.resume()
    },
    onLeave: () => {
      game.dispose()
      room.leave()
      location.href = `${location.origin}${location.pathname}`
    },
  })
  menu.open()

  const offLock = input.onLockChange((locked) => (locked ? menu.close() : menu.open()))
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Escape' && !document.pointerLockElement) {
      e.preventDefault()
      if (menu.isOpen) menu.close()
      else menu.open()
    }
    if (!debugMode || menu.isOpen) return
    if (e.code === 'KeyN') toggleNav()
    if (e.code === 'KeyC') toggleCollider()
  }
  document.addEventListener('keydown', onKeyDown)
  const onFirstClick = () => void audio.resume()
  document.addEventListener('pointerdown', onFirstClick, { once: true })

  let navHelper: ReturnType<typeof createNavMeshHelper> = null
  function toggleNav(): void {
    if (!navHelper) {
      if (!session?.nav) return
      navHelper = createNavMeshHelper(session.nav)
      if (navHelper) engine.scene.add(navHelper)
      return
    }
    navHelper.visible = !navHelper.visible
  }
  function toggleCollider(): void {
    if (!session) return
    const mesh = session.map.collider.mesh
    if (!mesh.parent) engine.scene.add(mesh)
    mesh.visible = !mesh.visible
  }

  const status = (): GameStatus => ({
    backend: engine.backend,
    fps,
    room,
    clockOffset: clock.offset,
    now: clock.now(),
    registry,
    session,
    match,
    local: localPlayer,
    bots: !!hostSide.bots,
    botsFill: botsFillFrom(room.getGlobal<unknown>(GS.botsFill)),
    menuOpen: menu.isOpen,
    locked: input.locked,
  })
  const debugPanel = createDebugPanel(mount, debugMode, status)

  loading.hide()
  engine.start()

  const game: Game = {
    engine,
    dispose() {
      if (disposed) return
      disposed = true
      offUpdate()
      offRender()
      offLock()
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onFirstClick)
      sender.stop()
      binding.stop()
      offDoorRpc()
      hostSide.dispose()
      clock.stop()
      remotePlayers.dispose()
      localPlayer.dispose()
      session?.dispose()
      loaders.dispose()
      engine.dispose()
      input.dispose()
      rawAudio.dispose()
      hud.dispose()
      prompt.dispose()
      board.dispose()
      menu.dispose()
      debugPanel.dispose()
      loading.dispose()
    },
  }

  /**
   * Debug handle — also the input path the headless playtests drive, since pointer lock cannot
   * be granted to an automated browser. Deliberately untyped: `dev/sandbox.ts` owns the
   * `window.__ps` global declaration for its own, different shape.
   */
  Object.assign(window as unknown as Record<string, unknown>, {
    __ps: {
      game,
      room,
      registry,
      events,
      clock,
      hud,
      board,
      engine,
      session: () => session,
      local: () => localPlayer,
      host: () => hostSide.authority,
      bots: () => hostSide.bots,
      /** Read the room's bot fill, or (as host) flip it — the Esc menu without the pointer. */
      botsFill: (on?: boolean) => {
        if (typeof on === 'boolean') {
          if (hostSide.authority) hostSide.authority.setBotsFill(on)
          else if (room.isHost()) room.setGlobal(GS.botsFill, botsFillValue(on), true)
        }
        return botsFillFrom(room.getGlobal<unknown>(GS.botsFill))
      },
      menu: (open: boolean) => (open ? menu.open() : menu.close()),
      move: (forward: number, right: number, jump = false, crouch = false, walk = false) =>
        localPlayer.debug.setMove(forward, right, jump, crouch, walk),
      look: (dx: number, dy: number) => localPlayer.debug.look(dx, dy),
      fire: (on: boolean) => localPlayer.debug.setFire(on),
      fireFor: (ms: number) => {
        localPlayer.debug.setFire(true)
        window.setTimeout(() => localPlayer.debug.setFire(false), ms)
      },
      reload: () => localPlayer.debug.reload(),
      interact: () => {
        interactPressed = true
      },
      doors: () => ({
        states: session?.doors.openStates() ?? null,
        target: interactTarget && { id: interactTarget.id, kind: interactTarget.kind ?? 'door' },
        prompt: prompt.action,
        global: room.getGlobal<DoorStates>(GS.doors) ?? null,
      }),
      stop: () => localPlayer.debug.clear(),
      teleport: (x: number, y: number, z: number) =>
        localPlayer.place(new Vector3(x, y, z), localPlayer.yaw),
      state: () => statusSnapshot(status()),
    },
  })

  return game
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_POSITIONS: Vector3[] = []

/** The host publishes the map; joiners wait for it (Playroom replays global state on join). */
async function resolveMapSelection(
  room: Room,
  preferred: MapSelection | null,
): Promise<MapSelection> {
  const claim = (): MapSelection => {
    const fallback = preferred ?? { ...BUILTIN_MAPS[0] }
    room.setGlobal(GS.map, fallback, true)
    return fallback
  }
  const existing = room.getGlobal<MapSelection>(GS.map)
  if (existing?.url) return existing
  if (room.isHost()) return claim()
  for (let i = 0; i < 300; i++) {
    await delay(100)
    const value = room.getGlobal<MapSelection>(GS.map)
    if (value?.url) return value
    if (room.isHost()) return claim()
  }
  throw new Error('The host never published a map')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

