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
import { BUILTIN_MAPS, DOORS, MATCH, PLAYER, TEAMS } from '../config'
import { createAudio, type Audio, type AudioListenerPose, type SoundName } from '../engine/audio'
import { createEventBus } from '../engine/events'
import type { OptionalSoundName } from '../engine/sfx-manifest'
import { createInput } from '../engine/input'
import { createLoaders } from '../engine/loaders'
import { createRenderer, type Engine } from '../engine/renderer'
import { createGlassSystem, type GlassSystem } from '../map/glass'
import { createNavMeshHelper } from '../map/navmesh'
import { bindNetToRegistry, requestTeamSwap } from '../net/client'
import type { HostAuthority } from '../net/host'
import {
  BOTS_FILL_DEFAULT,
  botsFillFrom,
  botsFillIsSet,
  botsFillValue,
  GS,
  PS,
  HOST_STABLE_MS,
  RPCS,
  teamFrom,
  type DoorEvent,
  type DoorStates,
  type FellEvent,
  type GlassEvent,
  type GlassStates,
  type HitRejected,
  type TeamChoice,
  type TeamResult,
} from '../net/protocol'
import type { Room } from '../net/room'
import { createClock, createSnapshotSender } from '../net/sync'
import type { DamageEvent, DoorInfo, Hittable, MapSelection, MatchState, ShotEvent, TeamId, WeaponKind } from '../types'
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
  createOverviewCamera,
  createPauseMenu,
  createTeamScreen,
  statusSnapshot,
  type GameStatus,
  type OverviewCamera,
  type RosterMember,
  type TeamRoster,
  type TeamScreenMode,
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
/** How long the `respawn` RPC outranks a stale `alive: false` still on the wire. */
const RESPAWN_RPC_GRACE_MS = 600
/**
 * How long after our death the reliable `alive: true` may stand us up on its own. The host sends
 * the `respawn` RPC (which carries the spawn point) in the same breath as the state, so anything
 * shorter than the respawn delay plus a landing grace revives us at the corpse for a frame.
 */
const STATE_REVIVE_AFTER_MS = PLAYER.respawnDelayMs + 400
/**
 * Pointer lock is a user gesture's to grant, and the click that picked a team is a round trip
 * old by the time the host answers. If the browser refuses, fall back to the Esc menu, whose
 * "Play" button is a fresh gesture.
 */
const LOCK_FALLBACK_MS = 350

/**
 * How long the `?debug=1` panel keeps showing the host's last refusal. Long enough to read
 * while playing, short enough that a stale line never gets blamed for the next shot.
 */
const HIT_REJECTION_SHOW_MS = 2_000

const _hittables: Hittable[] = []
const _damageDir = new Vector3()
const _shotOrigin = new Vector3()
const _shotDir = new Vector3()
const _glassPoint = new Vector3()
const _glassDir = new Vector3()

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

  // Started before the renderer so the three seconds it needs to believe `isHost()` are spent
  // loading the map rather than making the first host wait (see `createHostGate`).
  const hostGate = createHostGate(room)

  const engine = await createRenderer(mount)
  const loaders = createLoaders(engine.renderer)
  // The sample loader already supports these manifest cues; they have no synth fallback.
  type GameAudio = Omit<Audio, 'play'> & {
    play(name: SoundName | OptionalSoundName, at?: Vector3, listener?: AudioListenerPose): void
  }
  const rawAudio = createAudio() as GameAudio
  let muted = false
  const audio: GameAudio = {
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
  const binding = bindNetToRegistry(room, registry, events)

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
  /** Clock time of the last `respawn` RPC for us — see the alive/RPC race in `updateHud`. */
  let revivedAt = 0
  let lastTeam: TeamId | null = null
  /**
   * The side the host just accepted, held until its reliable `team` state reaches us (~50 ms).
   * Without it the screen would flicker back to "Choosing…" between the answer and the state.
   */
  let pickedTeam: TeamId | null = null
  /** Circles the house behind the team screen; rebuilt with the session. */
  let overview: OverviewCamera | null = null
  let lockFallbackTimer = 0
  /** Last weapon published to the room / pushed into the HUD. */
  let lastWeapon: WeaponKind | null = null
  /** `warnIfNothingToHit` fires once per session, not once per round of ammunition. */
  let warnedNothingToHit = false
  /** The host's last refusal of one of our hits, for the debug panel. */
  let hitRejection: { reason: string; at: number } | null = null

  /**
   * Null only while a map change is in flight. The frame loop keeps running between
   * `dispose()` and the next `buildSession()`, and every consumer of the session (bots,
   * projectiles, doors, environment) must stop touching it in that window: a bot asking a
   * freed recast navmesh for a path hangs the main thread for good.
   */
  /**
   * Breakable glass belongs to the map, but `map-session.ts` is another package's file this
   * wave, so the system lives here beside the session and is rebuilt and freed with it.
   */
  let glass: GlassSystem | null = null
  let session: MapSession | null = await buildSession(selection)
  const localPlayer = makeLocalPlayer(session)
  overview = createOverviewCamera(engine.camera, session.map)

  // --- map session lifecycle ----------------------------------------------

  async function buildSession(next: MapSelection): Promise<MapSession> {
    const built = await createMapSession({
      engine,
      loaders,
      selection: next,
      audio,
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

    // --- glass (W4-A + W4-C) ---
    // A pane shatters where its shot was simulated by its owner, and nowhere else. Every client
    // simulates every paintball, but only the shooter's ball stops at players (`detectPlayers`),
    // so a ball on somebody else's screen flies on through a body and would break windows the
    // shooter never touched. Same rule as a hit, then: the owner (the host for its bots) breaks
    // it and broadcasts; everyone else shatters when the `glass` RPC lands, which also covers a
    // client that never saw the shot at all.
    const glassSystem = createGlassSystem(built.map, engine.scene)
    glass?.dispose()
    glass = glassSystem
    built.projectiles.onGlassHit((hit, shot) => {
      const mine = shot.by === room.me.id || (!!hostSide.authority && registry.get(shot.by)?.isBot)
      if (!mine) return
      const id = paneIdOf(built, hit.object)
      if (!id || glassSystem.isBroken(id)) return
      _glassDir.set(shot.dir[0], shot.dir[1], shot.dir[2])
      breakGlass(glassSystem, id, hit.point, _glassDir)
      void room.rpc.call(RPCS.glass, { id, by: shot.by } as GlassEvent, 'all')
    })
    // Late join / map change: adopt the panes that are already gone. Ageing the shards out by a
    // second means the house looks lived-in instead of exploding on the first frame.
    const broken = room.getGlobal<GlassStates>(GS.glass)
    if (Array.isArray(broken)) {
      for (const id of broken) glassSystem.break(id)
      glassSystem.update(1)
    }
    return built
  }

  /** `GlassPane.id` of the pane that mesh belongs to — `HitResult.object` is the pane itself. */
  function paneIdOf(current: MapSession, object: unknown): string | null {
    const panes = current.map.breakables
    if (!panes) return null
    for (const pane of panes) if (pane.mesh === object) return pane.id
    return null
  }

  /** Shatter one pane locally: shards, sound, and (on the host) the room state for late joiners. */
  function breakGlass(
    system: GlassSystem,
    id: string,
    point?: Vector3,
    dir?: Vector3,
  ): boolean {
    if (!system.break(id, point, dir)) return false
    audio.play('glassBreak', point, localPlayer.listener)
    if (hostSide.authority) room.setGlobal(GS.glass, system.states(), true)
    return true
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
        // A knife swing travels this path for its animation and sound alone: melee.ts has
        // already resolved the hit locally, and a ball at `speed: 0` would just drop out of
        // the blade. Everything else is a paintball, in the *live* session — a shot fired on
        // the frame a map change starts must not land in the house we just disposed.
        if (shot.weapon !== 'knife') {
          warnIfNothingToHit()
          session?.projectiles.spawn(shot, { detectPlayers: true })
        }
        void room.rpc.call(RPCS.shot, shot, 'others')
      },
      onFell: () => {
        if (hostSide.authority) hostSide.authority.respawnPlayer(room.me.id)
        else void room.rpc.call(RPCS.fell, { player: room.me.id } as FellEvent, 'host')
      },
      // Two audiences for one switch: our own HUD widget, and everybody else's copy of us —
      // `client.ts` reads `w` back into `PlayerEntity.weapon`, which is what mounts the model
      // in a remote's hands.
      onWeapon: (kind) => {
        publishWeapon(kind)
        hud.setWeapon(kind)
      },
    })
    // Until the host's first `respawn` lands, stand somewhere sane rather than at the origin.
    if (me.position.lengthSq() > 1e-6) player.place(me.position, me.yaw)
    else placeAtSpawn(player, current)
    lastTeam = me.team
    player.setTeam(me.team)
    return player
  }

  /**
   * The cheap standing alarm for "my paint goes straight through everybody".
   *
   * Every hit this client can ever detect comes from one array: the capsules
   * `remote-players.ts` builds, one per avatar. If we are shooting while that array is empty
   * and the registry still holds remote players, no shot of ours can hit anything — the avatars
   * (and with them the hittables) were never built for the bodies we can see. It is a state the
   * game must never be in, it is silent from the inside, and it is the exact shape of a whole
   * family of regressions, so it says so once and then keeps quiet.
   */
  function warnIfNothingToHit(): void {
    if (warnedNothingToHit || remotePlayers.hittables().length > 0) return
    let remotes = 0
    for (const entity of registry.list()) if (!entity.isLocal) remotes++
    if (remotes === 0) return
    warnedNothingToHit = true
    console.warn(
      `[game] firing with an empty hittable list while ${remotes} remote player(s) are in the ` +
        'registry: remote-players.ts built no avatar capsules for them, so every paintball will ' +
        'pass straight through. Hit detection is dead for this client.',
    )
  }

  /** Owner-written state, like the pose: nobody validates which weapon we claim to hold. */
  function publishWeapon(kind: WeaponKind): void {
    if (kind === lastWeapon) return
    lastWeapon = kind
    room.me.setState(PS.weapon, kind, true)
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
    // Door and pane ids are per map: the previous house's state must not leak into the new one.
    if (hostSide.authority) {
      room.setGlobal(GS.doors, {}, true)
      room.setGlobal(GS.glass, [], true)
    }
    // From here until the new session exists, nothing may touch the old one. Clearing
    // `session` freezes the update/render hooks, and the bot runner — which holds the recast
    // navmesh `dispose()` is about to free — is stopped *before* that free, not after.
    session = null
    // The panes belong to the house that is about to go; free the shards with it rather than
    // leaving them hanging in an empty scene while the next map loads.
    glass?.dispose()
    glass = null
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
    // The old house's bounds mean nothing to the orbit: rebuild it around the new one.
    overview = createOverviewCamera(engine.camera, built.map)
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
  // It is handed the DEBOUNCED room, so nothing below it can start on a one-second blip.

  const hostSide = createHostSide({
    room: hostGate.room,
    registry,
    events,
    clock,
    session: () => session,
    // A bot's gun is a gun we can see: it gets the same muzzle, flash and report as any other
    // player's, and the ball is simulated here because the host owns the bot.
    onBotShot: (shot) => presentShot(shot, true),
  })

  // --- net events ----------------------------------------------------------

  // Nothing goes on the wire while we are dead or still choosing a side: a spectator has no
  // body in the house, and a snapshot is what would give them one on everybody else's screen.
  const sender = createSnapshotSender(room, () =>
    localPlayer.dead || localPlayer.spectating ? null : localPlayer.snapshot(),
  )

  /**
   * Somebody else's shot, on our screen. Two callers reach it: the `shot` RPC (every remote
   * human, and every bot for a client) and the host's own bot runner — a bot is a remote player
   * like any other here, it just happens to be simulated in this tab.
   *
   * `ShotEvent.origin` is the shooter's eye, which is where *they* aimed from but not where we
   * can see a gun: paint leaving a head reads as exactly that. So the ball is *drawn* leaving
   * the avatar's muzzle (`visualOrigin`), the model flashes and the arms kick, and the report
   * and the puff come off the barrel. The simulated trajectory stays the shooter's own —
   * dropping it to the muzzle would drop every bot's aim by the half metre between eye and bore.
   *
   * `detectPlayers` is the only thing that differs: a shot off the wire was already resolved
   * against players by its owner, so ours is paint; a bot's shot is owned here and must decide
   * its own hits.
   */
  function presentShot(shot: ShotEvent, detectPlayers: boolean): void {
    if (!session) return
    const fromMuzzle = remotePlayers.muzzleFor(shot.by, _shotOrigin)
    if (!fromMuzzle) _shotOrigin.set(shot.origin[0], shot.origin[1], shot.origin[2])
    remotePlayers.fire(shot.by, shot.weapon)
    if (shot.weapon === 'knife') {
      // A swing has no projectile: the animation and the sound are the whole event.
      audio.play('knifeSwing', _shotOrigin, localPlayer.listener)
      return
    }
    session.projectiles.spawn(shot, {
      detectPlayers,
      visualOrigin: fromMuzzle ? _shotOrigin : undefined,
    })
    _shotDir.set(shot.dir[0], shot.dir[1], shot.dir[2])
    session.effects.remoteMuzzle(_shotOrigin, _shotDir, shot.team)
    audio.play(shot.weapon === 'pistol' ? 'pistolShot' : 'shot', _shotOrigin, localPlayer.listener)
  }

  events.on('shot', (shot) => {
    if (shot.by === room.me.id) return
    presentShot(shot, false)
  })

  /**
   * The host threw one of our hits away. Every rule in `validate()` answered with silence until
   * now, so a shooter could not tell a refused hit from a missed shot — the difference between
   * "hits feel broken" and a bug report that names the rule. Broadcast and filtered by id, the
   * way `teamResult` is.
   */
  const offHitRejected = room.rpc.register<HitRejected>(RPCS.hitRejected, (ev) => {
    if (!ev || ev.player !== room.me.id) return
    hitRejection = { reason: ev.reason, at: clock.now() }
    console.debug(`[hit] the host refused shot ${ev.shotId || '(no id)'}: ${ev.reason}`)
  })

  const lastDamagePart = new Map<string, DamageEvent['part']>()
  let lastHeadshotAt = -Infinity
  let tenLeftPlayed = false

  events.on('damage', (dmg) => {
    lastDamagePart.set(dmg.target, dmg.part)
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
    const part = lastDamagePart.get(kill.victim)
    lastDamagePart.delete(kill.victim)
    const now = performance.now()
    if (kill.killer === room.me.id && part === 'head' && now - lastHeadshotAt >= 3_000) {
      audio.play('announcerHeadshot')
      lastHeadshotAt = now
    }
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
    lastDamagePart.delete(ev.player)
    if (ev.player === room.me.id) {
      localPlayer.place(ev.position, ev.yaw)
      localPlayer.revive()
      deathAt = 0
      revivedAt = clock.now()
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
    // The authority, not `room.isHost()`: a client whose flag flickered must not write globals.
    if (!hostSide.authority || !session) return
    room.setGlobal(GS.doors, session.doors.openStates(), true)
  }

  const offDoorRpc = room.rpc.register<DoorEvent>(RPCS.door, (ev) => {
    if (!ev?.id || !session) return
    session.doors.setOpen(ev.id, ev.open === true)
    // The host remembers who did it: bots must not re-open what a player just closed.
    hostSide.noteDoor(ev)
    publishDoorStates()
  })

  const offGlassRpc = room.rpc.register<GlassEvent>(RPCS.glass, (ev) => {
    const system = glass
    if (!ev?.id || !system || system.isBroken(ev.id)) return
    // No impact point on the wire: the shards fall from the pane's own centre. Whoever
    // simulated the shot already broke it with the real one.
    const pane = session?.map.breakables?.find((p) => p.id === ev.id)
    breakGlass(system, ev.id, pane ? pane.mesh.getWorldPosition(_glassPoint) : undefined)
  })

  /** Runs after `frameUpdate`, so the ray uses this frame's camera pose. */
  function updateInteract(pressed: boolean): void {
    if (!session || localPlayer.dead || localPlayer.spectating) {
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
    // The overview owns the camera while the team screen is up; `frameUpdate` knows to keep its
    // hands off it, and reads this frame's pose for the audio listener.
    if (localPlayer.spectating) overview?.update(dt)
    localPlayer.frameUpdate(dt)
    binding.update()
    remotePlayers.update(now, localPlayer.listener.position)

    session.doors.update(dt)
    glass?.update(dt)
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
      if (boardOpen) board.show(registry.list(), match, binding.spectators())
      else board.hide()
    }
  })

  function updateHud(now: number): void {
    match = room.getGlobal<MatchState>(GS.match) ?? hostSide.authority?.match.state ?? match
    const me = registry.local

    // The host has put us on a side (our own pick, or a migration adopting one): the screen's
    // job is done and the respawn RPC is already on its way with a position.
    if (localPlayer.spectating && myTeam()) closeTeamScreen()
    // The reverse can only happen through a host that forgot us; the screen is the way back in.
    else if (!localPlayer.spectating && !myTeam() && !teamScreen.isOpen) openTeamScreen('join')

    if (me && !localPlayer.spectating) {
      if (me.hp !== lastHp) {
        lastHp = me.hp
        hud.setHp(me.hp)
      }
      if (me.team !== lastTeam) {
        lastTeam = me.team
        localPlayer.setTeam(me.team)
      }
      hud.setInvincible(me.alive && me.invincibleUntil > now)
      // The `respawn` RPC and the reliable `alive` state race on the wire, and the two used to
      // fight over the same HUD: an `alive: false` still in flight when the RPC landed froze
      // us again and restarted the countdown at 2.5. The RPC wins for a moment (it is the one
      // that carries the position); after that this is still what unfreezes us if it is lost.
      if (!me.alive && now - revivedAt > RESPAWN_RPC_GRACE_MS) {
        // Normally the `kill` RPC starts the clock; if only the state arrived (dropped RPC,
        // host migration) start it here instead of counting down from nothing.
        if (!deathAt) deathAt = now
        // `setRespawn(0)` means "hide the overlay", so the countdown is clamped to 1 ms
        // instead: it reads 0.0 for its last frames rather than sticking at 0.1.
        hud.setRespawn(Math.max(1, PLAYER.respawnDelayMs - (now - deathAt)))
        if (!localPlayer.dead) localPlayer.die()
      } else if (me.alive && localPlayer.dead && now - deathAt > STATE_REVIVE_AFTER_MS) {
        // The other side of the same race, and the one that was showing: the host writes
        // `alive: true` and calls the `respawn` RPC in the same breath, but the reliable state
        // arrives ~50 ms first. Reviving on it stood us up at the spot we died, and the next
        // snapshot went out from there — a flicker at the corpse on every other screen before
        // the RPC teleported us. So the RPC gets the whole respawn delay plus a grace to land,
        // and this stays what it was written for: the last resort when it never comes at all.
        localPlayer.revive()
        hud.setRespawn(0)
      }
    }

    const marker = localPlayer.marker
    if (localPlayer.weapon !== lastWeapon) {
      publishWeapon(localPlayer.weapon)
      hud.setWeapon(localPlayer.weapon)
    }
    if (marker.hopper !== lastHopper || marker.reloading !== lastReloading) {
      lastHopper = marker.hopper
      lastReloading = marker.reloading
      hud.setHopper(marker.hopper, marker.reloading)
    }
    hud.setSpread(localPlayer.spread)

    if (match) {
      hud.setScores(match.scores.a, match.scores.b, msLeft(match, now))
      if (match.phase !== lastPhase) {
        tenLeftPlayed = false
        lastDamagePart.clear()
        lastPhase = match.phase
        hud.setPhase(match.phase, match.round)
      }
      if (
        match.phase === 'live' && !tenLeftPlayed &&
        Math.max(match.scores.a, match.scores.b) >= MATCH.killTarget - 10
      ) {
        audio.play('announcerTenLeft')
        tenLeftPlayed = true
      }
      if (match.phase === 'ended' && endedRound !== match.round) {
        endedRound = match.round
        board.end(match, registry.list(), binding.spectators())
      }
      if (match.phase !== 'ended' && boardOpen) board.show(registry.list(), match, binding.spectators())
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

  // --- teams (W4-C, W5-A) --------------------------------------------------
  // Sides are host-authoritative like the rest of the rules: the screen asks, the host answers.
  // On the host itself there is no round trip — we hold the authority, so we call it directly.

  /**
   * Our side, or null while we are still choosing. The reliable `team` player state is the
   * truth (that is what every other client reads about us too); `pickedTeam` only covers the
   * few milliseconds between the host's answer and its state landing.
   */
  function myTeam(): TeamId | null {
    return teamFrom(room.me.getState(PS.team)) ?? pickedTeam
  }

  /**
   * The local entity always carries a side — `PlayerEntity.team` has nowhere to put "none" —
   * so while we are choosing it lies, and every count has to ask `myTeam()` about us instead.
   * Remote spectators are simply not in the registry (`net/client.ts`).
   */
  function teamOf(entity: { isLocal: boolean; team: TeamId }): TeamId | null {
    return entity.isLocal ? myTeam() : entity.team
  }

  function teamCounts(): { a: number; b: number } {
    const counts = { a: 0, b: 0 }
    for (const entity of registry.list()) {
      const team = teamOf(entity)
      if (team) counts[team]++
    }
    return counts
  }

  function roster(): TeamRoster {
    const out: TeamRoster = { a: [], b: [], choosing: [] }
    for (const entity of registry.list()) {
      const team = teamOf(entity)
      if (!team) continue
      out[team].push({
        id: entity.id,
        name: entity.name,
        isBot: entity.isBot,
        isLocal: entity.isLocal,
      })
    }
    for (const waiting of binding.spectators()) {
      out.choosing.push({ id: waiting.id, name: waiting.name, isBot: false, isLocal: waiting.isLocal })
    }
    return out
  }

  /**
   * A host that has just inherited the room does not have its authority up yet, and the very
   * first pick can land inside that window. Waiting for our own authority beats sending
   * ourselves an RPC that nobody is registered to answer.
   */
  async function waitForAuthority(): Promise<HostAuthority | null> {
    if (hostSide.authority || !room.isHost()) return hostSide.authority
    for (let i = 0; i < 40 && !hostSide.authority && room.isHost(); i++) await delay(100)
    return hostSide.authority
  }

  async function requestTeam(choice: TeamChoice): Promise<TeamResult> {
    const authority = await waitForAuthority()
    const result = authority
      ? authority.requestTeam(room.me.id, choice)
      : await requestTeamSwap(room, choice)
    // Tell everyone else too: their screens read the counts from the same broadcast path.
    if (authority) void room.rpc.call(RPCS.teamResult, result, 'others')
    if (result?.ok && result.player === room.me.id) {
      if (result.assigned) pickedTeam = result.assigned
      closeTeamScreen()
    }
    return result
  }

  // --- team screen ---------------------------------------------------------

  function openTeamScreen(mode: TeamScreenMode): void {
    if (mode === 'join') setSpectating(true)
    menu.close()
    teamScreen.open(mode)
  }

  function closeTeamScreen(): void {
    const wasOpen = teamScreen.isOpen
    teamScreen.close()
    setSpectating(false)
    if (wasOpen) requestLockSoon()
  }

  /**
   * Spectating is the state of having no body: no controller, no weapon, no capsule, no
   * snapshots, and the overview camera instead of the FPS one. The host says the same thing to
   * everyone else by leaving us `alive: false` until we pick.
   */
  function setSpectating(on: boolean): void {
    if (localPlayer.spectating === on) return
    localPlayer.setSpectating(on)
    hud.setVisible(!on)
    if (on) {
      overview?.reset()
      hud.setRespawn(0)
      return
    }
    // The `alive: false` the host wrote while we were choosing can still be in flight; the same
    // grace the respawn race uses keeps it from starting a death countdown on a fresh spawn.
    revivedAt = clock.now()
    deathAt = 0
    hud.setRespawn(0)
    hud.setHp(PLAYER.maxHp)
  }

  function requestLockSoon(): void {
    window.clearTimeout(lockFallbackTimer)
    input.requestLock()
    lockFallbackTimer = window.setTimeout(() => {
      // The browser refused the lock (the gesture that picked a team is a round trip old): the
      // menu's Play button is a fresh one.
      if (!input.locked && !menu.isOpen && !teamScreen.isOpen) menu.open()
    }, LOCK_FALLBACK_MS)
  }

  const teamScreen = createTeamScreen({
    mount,
    audio,
    roster,
    myTeam,
    onPick: requestTeam,
    onBack: () => {
      // Only reachable from the Esc menu's "Change team": there is no way past the join screen
      // but picking a side.
      teamScreen.close()
      menu.open()
    },
  })

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
    teams: teamCounts,
    myTeam,
    onChangeTeam: () => openTeamScreen(myTeam() ? 'change' : 'join'),
    botsFill: () => botsFillFrom(room.getGlobal<unknown>(GS.botsFill)),
    setBotsFill: (on) => {
      // The menu only offers this to the host; the authority kicks or refills on its next tick.
      if (hostSide.authority) hostSide.authority.setBotsFill(on)
      else if (hostGate.confirmed) room.setGlobal(GS.botsFill, botsFillValue(on), true)
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
  // First screen of the session: the team cards over the orbiting house if we have no side yet
  // (the usual case — the host only assigns one when you pick), the Play menu if we already do.
  if (myTeam()) menu.open()
  else openTeamScreen('join')

  const offLock = input.onLockChange((locked) => {
    if (locked) menu.close()
    // Losing the lock while the team screen is up is what the team screen is for.
    else if (!teamScreen.isOpen) menu.open()
  })
  const onKeyDown = (e: KeyboardEvent) => {
    // The team screen handles its own keys (capture phase) and swallows the ones it uses.
    if (teamScreen.isOpen) return
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
    myTeam: myTeam(),
    teamScreen: teamScreen.mode,
    choosing: binding.spectators().map((s) => s.name),
    hostConfirmed: hostGate.confirmed,
    hitRejection:
      hitRejection && clock.now() - hitRejection.at < HIT_REJECTION_SHOW_MS
        ? hitRejection.reason
        : null,
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
      offGlassRpc()
      offHitRejected()
      window.clearTimeout(lockFallbackTimer)
      hostSide.dispose()
      hostGate.stop()
      clock.stop()
      remotePlayers.dispose()
      localPlayer.dispose()
      glass?.dispose()
      session?.dispose()
      loaders.dispose()
      engine.dispose()
      input.dispose()
      rawAudio.dispose()
      hud.dispose()
      prompt.dispose()
      board.dispose()
      menu.dispose()
      teamScreen.dispose()
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
          else if (hostGate.confirmed) room.setGlobal(GS.botsFill, botsFillValue(on), true)
        }
        return botsFillFrom(room.getGlobal<unknown>(GS.botsFill))
      },
      /**
       * Pick a side exactly as the team screen's cards do ('a' | 'b' | 'auto'), and resolve
       * with the host's answer. The screen closes itself when the answer is yes — this is the
       * headless playtests' way through it, since a card click needs a pointer.
       */
      pickTeam: (team: TeamChoice) => requestTeam(team),
      /** Older name for the same call (the Esc menu's Team row, before W5-A). */
      team: (team: TeamChoice) => requestTeam(team),
      /** Open or close the team screen without a pointer; no argument reads its mode. */
      teamScreen: (mode?: TeamScreenMode | false) => {
        if (mode === false) closeTeamScreen()
        else if (mode) openTeamScreen(mode)
        return teamScreen.mode
      },
      /** Rosters and the "Choosing…" list, exactly as the screen shows them. */
      roster: () => roster(),
      /** Heads per team, bots included — what the menu's Team row shows. */
      teams: () => teamCounts(),
      menu: (open?: boolean) => {
        if (open === true) menu.open()
        else if (open === false) menu.close()
        return menu.isOpen
      },
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
      /** Broken panes here and in the room state — the glass equivalent of `doors()`. */
      glass: () => ({
        panes: session?.map.breakables?.length ?? 0,
        broken: glass?.states() ?? [],
        global: room.getGlobal<GlassStates>(GS.glass) ?? null,
      }),
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

/** How often the gate below samples `room.isHost()`. */
const HOST_POLL_MS = 1_000

interface HostGate {
  /** Has `room.isHost()` held one value long enough to act on it? */
  readonly confirmed: boolean
  /** The room with a debounced `isHost()` and `onHostChange` — hand this to the host side. */
  readonly room: Room
  stop(): void
}

/**
 * `room.isHost()` with the blips filtered out.
 *
 * A Playroom socket hiccup flipped a guest's `isHost()` true for about a second. That was enough
 * for it to start a whole authority — adopt the match, load the bot runner, write player states —
 * next to the real host, and for that second two clients owned the same room. Nothing downstream
 * can tell a blip from a migration, so the filter goes here: the value has to hold for
 * `HOST_STABLE_MS` of 1 Hz polling before anyone acts on it, in either direction. A real
 * migration then pays three quiet seconds, which nobody notices — the authority is idempotent and
 * adopts the published state when it does start — and a blip pays nothing at all.
 */
function createHostGate(room: Room): HostGate {
  let raw = room.isHost()
  let stableSince = Date.now()
  let confirmed = false
  const listeners = new Set<(isHost: boolean) => void>()

  const poll = () => {
    const now = Date.now()
    const value = room.isHost()
    if (value !== raw) {
      raw = value
      stableSince = now
      return
    }
    if (value === confirmed || now - stableSince < HOST_STABLE_MS) return
    confirmed = value
    const held = Math.round((now - stableSince) / 1000)
    console.info(
      `[host] isHost() has been ${value} for ${held} s — ${value ? 'taking' : 'dropping'} the authority`,
    )
    for (const cb of listeners) cb(confirmed)
  }
  const timer = window.setInterval(poll, HOST_POLL_MS)

  return {
    get confirmed() {
      return confirmed
    },
    room: {
      ...room,
      isHost: () => confirmed,
      onHostChange(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    stop() {
      window.clearInterval(timer)
      listeners.clear()
    },
  }
}

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

