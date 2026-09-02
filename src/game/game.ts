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
import { BUILTIN_MAPS, PLAYER } from '../config'
import { createAudio, type Audio } from '../engine/audio'
import { createEventBus } from '../engine/events'
import { createInput } from '../engine/input'
import { createLoaders } from '../engine/loaders'
import { createRenderer, type Engine } from '../engine/renderer'
import { createNavMeshHelper } from '../map/navmesh'
import { bindNetToRegistry } from '../net/client'
import { GS, RPCS, type FellEvent } from '../net/protocol'
import type { Room } from '../net/room'
import { createClock, createSnapshotSender } from '../net/sync'
import type { Hittable, MapSelection, MatchState, TeamId } from '../types'
import { createHud } from '../ui/hud'
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
  mount: HTMLElement
  debug?: boolean
}

export interface Game {
  engine: Engine
  dispose(): void
}

const MAP_POLL_MS = 500
const HUD_POLL_MS = 100

const _actors: Vector3[] = []
const _hittables: Hittable[] = []
const _damageDir = new Vector3()
const _shotOrigin = new Vector3()

export async function startGame(opts: GameOptions): Promise<Game> {
  const { room, mount } = opts
  const debugMode = opts.debug ?? new URLSearchParams(location.search).get('debug') === '1'

  const loading = createLoadingOverlay(mount)
  loading.set(0, 'Waiting for the host to pick a map')
  const selection = await resolveMapSelection(room, opts.map)

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
  const board = createScoreboard({ mount, now: () => clock.now(), localId: room.me.id })
  hud.setRoom(room.roomCode, room.inviteUrl)
  hud.setFps(debugMode ? 0 : null)

  const remotePlayers = createRemotePlayers(engine.scene, registry)

  // Declared before the first `buildSession`/`makeLocalPlayer` call: both close over them.
  let match: MatchState | null = null
  let disposed = false
  let deathAt = 0
  let lastTeam: TeamId | null = null

  let session = await buildSession(selection)
  let localPlayer = makeLocalPlayer(session)

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
    built.projectiles.onPlayerHit((hit) => {
      // My shots and (on the host) my bots' shots both land here; the host validates either way.
      const authority = hostSide.authority
      if (authority) authority.submitHit(hit)
      else if (hit.by === room.me.id) void room.rpc.call(RPCS.hit, hit, 'host')
    })
    return built
  }

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
        current.projectiles.spawn(shot, { detectPlayers: true })
        void room.rpc.call(RPCS.shot, shot, 'others')
      },
      onFell: () => {
        if (hostSide.authority) hostSide.authority.respawnPlayer(room.me.id)
        else void room.rpc.call(RPCS.fell, { player: room.me.id } as FellEvent, 'host')
      },
    })
    // Until the host's first `respawn` lands, stand somewhere sane rather than at the origin.
    if (me.position.lengthSq() > 1e-6) player.place(me.position, me.yaw)
    else {
      const spawn = current.leastCrowdedSpawn(me.team, EMPTY_POSITIONS)
      if (spawn) player.place(spawn.position, spawn.yaw)
    }
    lastTeam = me.team
    player.setTeam(me.team)
    return player
  }

  let changing: Promise<void> | null = null
  async function changeMap(next: MapSelection): Promise<void> {
    if (disposed || next.url === session.selection.url) return
    loading.show()
    loading.set(0, `Loading ${next.name}`)
    remotePlayers.clear()
    localPlayer.dispose()
    session.dispose()
    session = await buildSession(next)
    localPlayer = makeLocalPlayer(session)
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
    if (shot.by === room.me.id) return
    session.projectiles.spawn(shot, { detectPlayers: false })
    _shotOrigin.set(shot.origin[0], shot.origin[1], shot.origin[2])
    audio.play('shot', _shotOrigin, localPlayer.listener)
  })

  events.on('damage', (dmg) => {
    if (dmg.by === room.me.id && dmg.target !== room.me.id) hud.hitMarker()
    if (dmg.target === room.me.id) {
      hud.setHp(dmg.hp)
      hud.damageFrom(viewSpaceDirection(dmg.point), registry.get(dmg.by)?.team ?? 'b')
      audio.play('hit')
    } else {
      remotePlayers.flashHit(dmg.target)
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
      remotePlayers.kill(kill.victim)
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
    localPlayer.fixedUpdate(dt)
    hostSide.bots?.update(dt)
  })

  const offRender = engine.onRender((_alpha, dt) => {
    const now = clock.now()
    fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.08

    localPlayer.frameUpdate(dt)
    binding.update(now)
    remotePlayers.update(now, localPlayer.listener.position)

    _actors.length = 0
    _actors.push(localPlayer.position)
    for (const p of remotePlayers.positions()) _actors.push(p)
    session.doors.update(dt, _actors)

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
    if (now - lastMapPoll > MAP_POLL_MS) {
      lastMapPoll = now
      const wanted = room.getGlobal<MapSelection>(GS.map)
      if (wanted?.url && wanted.url !== session.selection.url && !changing) {
        changing = changeMap(wanted).finally(() => {
          changing = null
        })
      }
    }

    if (input.scoreboard !== boardOpen) {
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
        hud.setRespawn(Math.max(50, PLAYER.respawnDelayMs - (now - (deathAt || now))))
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
      if (!session.nav) return
      navHelper = createNavMeshHelper(session.nav)
      if (navHelper) engine.scene.add(navHelper)
      return
    }
    navHelper.visible = !navHelper.visible
  }
  function toggleCollider(): void {
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
      hostSide.dispose()
      clock.stop()
      remotePlayers.dispose()
      localPlayer.dispose()
      session.dispose()
      loaders.dispose()
      engine.dispose()
      input.dispose()
      rawAudio.dispose()
      hud.dispose()
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
      menu: (open: boolean) => (open ? menu.open() : menu.close()),
      move: (forward: number, right: number, jump = false, crouch = false) =>
        localPlayer.debug.setMove(forward, right, jump, crouch),
      look: (dx: number, dy: number) => localPlayer.debug.look(dx, dy),
      fire: (on: boolean) => localPlayer.debug.setFire(on),
      fireFor: (ms: number) => {
        localPlayer.debug.setFire(true)
        window.setTimeout(() => localPlayer.debug.setFire(false), ms)
      },
      reload: () => localPlayer.debug.reload(),
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

