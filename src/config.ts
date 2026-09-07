/**
 * Tuning constants and environment. Keep gameplay numbers here so balancing is one file.
 */
import type { TeamId, TeamInfo } from './types'

export const ENV = {
  playroomGameId: import.meta.env.VITE_PLAYROOM_GAME_ID as string | undefined,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseKey: import.meta.env.VITE_SUPABASE_KEY as string | undefined,
  supabaseMapsBucket: (import.meta.env.VITE_SUPABASE_MAPS_BUCKET as string | undefined) ?? 'maps',
}

export const TEAMS: Record<TeamId, TeamInfo> = {
  a: { id: 'a', name: 'Orange', color: '#f97316', colorHex: 0xf97316 },
  b: { id: 'b', name: 'Teal', color: '#14b8a6', colorHex: 0x14b8a6 },
}

export const BUILTIN_MAPS = [
  { id: 'pascal-house', name: 'Pascal House', url: '/maps/pascal-house.glb', tintTerrain: true },
  { id: 'fy-iceworld', name: 'fy_iceworld', url: '/maps/fy-iceworld.glb', tintTerrain: false },
] as const

export const MATCH = {
  teamSize: 3,
  maxPlayers: 6,
  killTarget: 30,
  durationMs: 5 * 60_000,
  warmupMs: 5_000,
  endScreenMs: 10_000,
}

export const PLAYER = {
  maxHp: 100,
  hitDamage: 34, // 3 hits
  respawnDelayMs: 2_500,
  invincibleMs: 3_000,
  // Capsule
  radius: 0.3,
  height: 1.75,
  crouchHeight: 1.15,
  eyeHeight: 1.6,
  crouchEyeHeight: 1.0,
  // Movement (m/s, m/s^2). Default movement is running; Shift walks (slow, precise).
  runSpeed: 5.5,
  walkSpeed: 2.8,
  crouchSpeed: 1.8,
  airControl: 0.35,
  accel: 45,
  decel: 55,
  jumpVelocity: 4.8,
  gravity: 20,
  /** Max step height the controller can climb without jumping. Pascal's v7 stair ends with a 0.50 m riser. */
  stepHeight: 0.52,
  /** Max slope angle (degrees) considered walkable ground. */
  maxSlopeDeg: 55,
  lookSensitivity: 0.0022,
  fov: 75,
}

export const WEAPON = {
  /** shots per second while holding fire (legacy; WEAPONS.rifle.fireRate is the live value) */
  fireRate: 12,
  /**
   * Gaussian spread sigma in degrees by motion state. Standing/walking/crouching is
   * precise; running and airborne pay a penalty. Blend by speed between walk and run.
   */
  spreadStandingDeg: 0.12,
  spreadWalkingDeg: 0.3,
  spreadRunningDeg: 1.6,
  spreadAirDeg: 2.8,
  /**
   * Extra sigma added right after a shot, decays with `spreadRecoveryPerSec`. Recovery
   * outpaces the fire rate (9/s × 0.25° < 4°/s) so sustained fire while standing stays
   * precise; the cap only matters while moving.
   */
  spreadPerShotDeg: 0.25,
  spreadRecoveryPerSec: 4.0,
  spreadBloomMaxDeg: 1.0,
  projectileSpeed: 95,
  projectileGravity: 9.8,
  projectileRadius: 0.025,
  /** metres before the projectile is discarded */
  maxRange: 80,
  hopperSize: 30,
  reloadMs: 1_400,
  /** Recoil kick in radians applied to pitch per shot, recovers quickly. */
  recoilPitch: 0.0045,
}

/**
 * Per-weapon tuning. Slot keys 1/2/3. `damageScale` multiplies DAMAGE[part]; the knife uses
 * `damage` flat (60 = two swings, one from behind). Spread values are gaussian sigmas in degrees.
 */
export const WEAPONS = {
  rifle: {
    slot: 1,
    label: 'Marker',
    auto: true,
    fireRate: 10,
    ammo: 30,
    reloadMs: 1_400,
    projectileSpeed: 95,
    damageScale: 1,
    spreadScale: 1,
    moveSpeedScale: 1,
  },
  pistol: {
    slot: 2,
    label: 'Pistol',
    auto: false,
    fireRate: 12,
    ammo: 12,
    reloadMs: 1_100,
    projectileSpeed: 110,
    damageScale: 1,
    /** Tighter than the rifle in every motion state. */
    spreadScale: 0.5,
    moveSpeedScale: 1.05,
  },
  knife: {
    slot: 3,
    label: 'Knife',
    auto: false,
    /** Swings per second. */
    fireRate: 2.2,
    ammo: Infinity,
    reloadMs: 0,
    projectileSpeed: 0,
    damageScale: 0,
    spreadScale: 0,
    moveSpeedScale: 1.12,
    /** Melee reach (m) from the eye along the look direction, and the hit cone half-angle. */
    range: 1.7,
    coneDeg: 25,
    damage: 60,
    backstabScale: 2,
  },
} as const

/** Damage per body part. 100 hp: head = 2 hits, torso = 3, limbs = 5. */
export const DAMAGE: Record<'head' | 'torso' | 'arm' | 'leg', number> = {
  head: 50,
  torso: 34,
  arm: 20,
  leg: 20,
}

export const ARMOR = {
  max: 50,
  absorption: 0.35,
}

export const TAGGING = {
  speedScale: 0.55,
  holdMs: 120,
  recoveryMs: 380,
}

export const DECALS = {
  maxCount: 400,
  minSize: 0.16,
  maxSize: 0.3,
  /** Push decal geometry off the surface to avoid z-fighting. */
  offset: 0.004,
}

export const DOORS = {
  /** Players toggle doors/windows with E when the crosshair is on one within this range (m). */
  interactRange: 2.5,
  /** Bots open a closed door on their path when within this distance of it (m). */
  botOpenRadius: 2.4,
  /** Playback speed of the baked 1 s clip. */
  openTimeScale: 3,
}

export const NET = {
  /** Local player snapshot send rate (Hz), unreliable channel. */
  snapshotHz: 20,
  /** Interpolation delay for remote players (ms). */
  interpDelayMs: 110,
  /** Host bot snapshot rate (Hz). */
  botSnapshotHz: 15,
}

export const BOTS = {
  aimSettleMs: 120,
  fireSpeedThreshold: 0.7,
  decisionHz: 8,
  viewDistance: 28,
  fovDeg: 130,
  /** Standard deviation of aim error in degrees. */
  aimErrorDeg: 2.6,
  reactionMs: 320,
  memoryMs: 4_000,
  burstShots: 4,
  burstPauseMs: 450,
  names: ['Pixel', 'Voxel', 'Bezier', 'Mesh', 'Shader', 'Quad', 'Splat', 'Lumen', 'Vertex', 'Brush'],
}

export const NAVMESH = {
  cs: 0.08, // 0.15 severed 0.25 m stair treads; 0.08 connects floors (+15 ms gen)
  ch: 0.1,
  /** Below the 0.3 m capsule on purpose: curved treads are only ~0.25 m² and 0.3 m erosion severs them. */
  walkableRadius: 0.22,
  walkableHeight: 1.7,
  walkableClimb: 0.52,
  walkableSlopeAngle: 50,
}

export const SPAWN = {
  /** Zone label regex → team. Case-insensitive. */
  zonePattern: /spawn/i,
  teamAPattern: /\b(a|1|orange|red)\b/i,
  teamBPattern: /\b(b|2|teal|blue)\b/i,
  /** Points sampled per spawn zone. */
  pointsPerZone: 12,
}
