/**
 * The pistol and the knife: the marker's design language (matte white polymer, charcoal
 * furniture, one thin team-colour accent) compressed into a sidearm and a blade.
 *
 * Same conventions as `weapon-model.ts`: real-world scale, origin at the grip under the
 * trigger, −Z is forward. Both are built from the shared `ModelKit`, so they recolour and
 * dispose through the marker's material list.
 */
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three'
import type { ModelBuild, ModelKit } from './weapon-model'

/** Bore line above the origin, shared with the rifle so hands mount the same way. */
const BORE_Y = 0.026

/**
 * Compact sidearm: chamfered white slide, charcoal frame and grip, a short under-barrel rail
 * and a small translucent paint reservoir canted off the sight line on the left flank (the
 * side the first-person camera actually sees).
 */
export function buildPistol(kit: ModelKit, root: Group, flash: Group): ModelBuild {
  const { add, detail } = kit

  // --- slide: the wide/short + narrow/tall pair that reads as a chamfer -----
  add(root, new BoxGeometry(0.040, 0.044, 0.172), kit.white, [0, BORE_Y + 0.012, -0.046])
  add(root, new BoxGeometry(0.030, 0.054, 0.166), kit.white, [0, BORE_Y + 0.012, -0.046])
  add(root, new BoxGeometry(0.0385, 0.010, 0.166), kit.whiteShade, [0, BORE_Y + 0.032, -0.046])
  if (detail) {
    // Cocking serrations at the back of the slide.
    for (let i = 0; i < 4; i++) {
      add(root, new BoxGeometry(0.0415, 0.026, 0.005), kit.charcoalLight, [0, BORE_Y + 0.012, 0.010 - i * 0.011])
    }
    add(root, new BoxGeometry(0.0425, 0.0030, 0.120), kit.line, [0, BORE_Y - 0.004, -0.060])
  }

  // --- frame, dust cover, trigger group ------------------------------------
  add(root, new BoxGeometry(0.036, 0.030, 0.120), kit.charcoal, [0, BORE_Y - 0.026, -0.062])
  add(root, new BoxGeometry(0.030, 0.020, 0.055), kit.charcoalLight, [0, BORE_Y - 0.044, -0.078])
  add(root, new BoxGeometry(0.016, 0.010, 0.062), kit.charcoal, [0, -0.038, -0.016])
  add(root, new BoxGeometry(0.016, 0.026, 0.010), kit.charcoal, [0, -0.026, -0.044])
  if (detail) add(root, new BoxGeometry(0.007, 0.020, 0.007), kit.charcoalLight, [0, -0.022, -0.016], [-0.2, 0, 0])

  // --- grip ----------------------------------------------------------------
  const gripRake: readonly [number, number, number] = [-0.22, 0, 0]
  add(root, new BoxGeometry(0.040, 0.104, 0.048), kit.charcoal, [0, -0.062, 0.026], gripRake)
  add(root, new BoxGeometry(0.030, 0.108, 0.056), kit.charcoal, [0, -0.062, 0.026], gripRake)
  if (detail) add(root, new BoxGeometry(0.037, 0.062, 0.036), kit.charcoalLight, [0, -0.072, 0.030], gripRake)
  add(root, new BoxGeometry(0.042, 0.005, 0.028), kit.accent, [0, -0.014, 0.022], gripRake)

  // --- sights ---------------------------------------------------------------
  add(root, new BoxGeometry(0.026, 0.011, 0.012), kit.charcoal, [0, BORE_Y + 0.044, 0.024])
  add(root, new BoxGeometry(0.007, 0.013, 0.008), kit.charcoal, [0, BORE_Y + 0.044, -0.118])
  if (detail) add(root, new BoxGeometry(0.008, 0.008, 0.010), kit.black, [0, BORE_Y + 0.046, 0.024])

  // --- muzzle ----------------------------------------------------------------
  add(root, new BoxGeometry(0.042, 0.046, 0.013), kit.charcoal, [0, BORE_Y + 0.012, -0.1345])
  add(root, new TorusGeometry(0.013, 0.004, 8, 18), kit.accent, [0, BORE_Y + 0.012, -0.1405])
  if (detail) {
    add(root, new CylinderGeometry(0.009, 0.009, 0.020, 12), kit.black, [0, BORE_Y + 0.012, -0.1380], [Math.PI / 2, 0, 0])
  }

  // --- team accent strips ---------------------------------------------------
  for (const side of [-1, 1]) {
    add(root, new BoxGeometry(0.004, 0.007, 0.120), kit.accent, [side * 0.0205, BORE_Y + 0.020, -0.050])
  }

  // --- small translucent paint reservoir -----------------------------------
  add(root, new BoxGeometry(0.028, 0.022, 0.048), kit.charcoal, [-0.012, BORE_Y + 0.030, -0.052], [0, 0, 0.30])
  const reservoir = new Group()
  reservoir.position.set(-0.026, BORE_Y + 0.038, -0.052)
  reservoir.rotation.set(-0.12, 0, 0.34)
  root.add(reservoir)
  add(reservoir, new CylinderGeometry(0.019, 0.017, 0.052, 16, 1, true), kit.tank, [0, 0, 0])
  const paintLevel = add(reservoir, new CylinderGeometry(0.015, 0.014, 0.046, 12), kit.paint, [0, 0, 0])
  add(reservoir, new CylinderGeometry(0.016, 0.020, 0.006, 16), kit.charcoal, [0, 0.028, 0])
  add(reservoir, new CylinderGeometry(0.014, 0.013, 0.012, 10), kit.charcoal, [0, -0.028, 0])
  if (detail) add(reservoir, new TorusGeometry(0.0195, 0.0025, 8, 16), kit.accent, [0, 0.025, 0], [Math.PI / 2, 0, 0])

  const muzzle = new Object3D()
  muzzle.position.set(0, BORE_Y + 0.012, -0.146)
  root.add(muzzle)
  muzzle.add(flash)
  kit.muzzleFlash(flash)
  flash.scale.setScalar(0.8)

  return {
    muzzle,
    length: 0.22,
    setPaintLevel(level) {
      const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level
      paintLevel.visible = clamped > 0.001
      paintLevel.scale.y = clamped
      paintLevel.position.y = -0.023 + 0.023 * clamped
    },
  }
}

/**
 * Paint-dipped combat knife: charcoal handle with a finger guard, brushed white blade with a
 * fuller, and the team colour sitting on the cutting edge with a couple of drips — the blade
 * has been dunked in the same paint the markers fire.
 */
export function buildKnife(kit: ModelKit, root: Group, flash: Group): ModelBuild {
  const { add, detail } = kit

  // --- handle ---------------------------------------------------------------
  add(root, new BoxGeometry(0.028, 0.032, 0.104), kit.charcoal, [0, -0.004, 0.034])
  add(root, new BoxGeometry(0.021, 0.038, 0.100), kit.charcoal, [0, -0.004, 0.034])
  if (detail) {
    for (let i = 0; i < 4; i++) {
      add(root, new BoxGeometry(0.030, 0.006, 0.008), kit.charcoalLight, [0, -0.019, 0.006 + i * 0.020])
    }
  }
  add(root, new BoxGeometry(0.030, 0.034, 0.012), kit.charcoalLight, [0, -0.004, 0.090])
  add(root, new BoxGeometry(0.020, 0.006, 0.005), kit.accent, [0, 0.012, 0.094])

  // --- guard ----------------------------------------------------------------
  add(root, new BoxGeometry(0.052, 0.013, 0.016), kit.charcoalLight, [0, -0.002, -0.024])
  add(root, new BoxGeometry(0.020, 0.020, 0.014), kit.charcoal, [0, -0.002, -0.024])

  // --- blade ----------------------------------------------------------------
  add(root, new BoxGeometry(0.026, 0.009, 0.156), kit.white, [0, 0.003, -0.110])
  add(root, new BoxGeometry(0.033, 0.004, 0.148), kit.whiteShade, [0, 0.001, -0.108])
  if (detail) {
    // Fuller: a shallow groove running most of the blade.
    add(root, new BoxGeometry(0.007, 0.0035, 0.104), kit.line, [0, 0.0075, -0.106])
  }
  // Four-sided cone = a clean pyramidal point without a custom geometry.
  add(root, new ConeGeometry(0.016, 0.058, 4), kit.white, [0, 0.003, -0.213], [-Math.PI / 2, 0, Math.PI / 4])

  // --- paint on the edge ----------------------------------------------------
  add(root, new BoxGeometry(0.030, 0.005, 0.142), kit.paint, [0, -0.0035, -0.106])
  add(root, new ConeGeometry(0.012, 0.030, 4), kit.paint, [0, -0.002, -0.198], [-Math.PI / 2, 0, Math.PI / 4])
  if (detail) {
    add(root, new SphereGeometry(0.006, 8, 6), kit.paint, [0.004, -0.008, -0.070])
    add(root, new SphereGeometry(0.004, 8, 6), kit.paint, [-0.003, -0.009, -0.148])
  }

  // The knife never fires: the node exists so the model API stays uniform (effects and the
  // view model ask every weapon where its business end is).
  const muzzle = new Object3D()
  muzzle.position.set(0, 0.003, -0.240)
  root.add(muzzle)
  muzzle.add(flash)

  return {
    muzzle,
    length: 0.30,
    setPaintLevel() {
      /* No reservoir: the blade carries its paint on the edge. */
    },
  }
}
