/**
 * GLB loading stack (W1-A): GLTFLoader + meshopt + KTX2/basisu.
 *
 * Pascal exports use EXT_meshopt_compression, KHR_mesh_quantization and KHR_texture_basisu,
 * so all three pieces are mandatory. The basis transcoder lives in `public/decoders/`.
 */
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { WebGPURenderer } from 'three/webgpu'

export interface Loaders {
  gltf: GLTFLoader
  ktx2: KTX2Loader
  dispose(): void
}

/** `renderer` must already be initialised (`await renderer.init()`) — detectSupport reads its caps. */
export function createLoaders(renderer: WebGPURenderer): Loaders {
  const ktx2 = new KTX2Loader().setTranscoderPath('/decoders/').detectSupport(renderer)

  const gltf = new GLTFLoader()
  gltf.setKTX2Loader(ktx2)
  gltf.setMeshoptDecoder(MeshoptDecoder)

  return {
    gltf,
    ktx2,
    dispose() {
      ktx2.dispose()
      gltf.setKTX2Loader(null)
      gltf.setMeshoptDecoder(null)
    },
  }
}

/**
 * Load a GLB from a URL or from raw bytes (a dropped `File` → `await file.arrayBuffer()`).
 */
export function loadGltf(loaders: Loaders, source: string | ArrayBuffer): Promise<GLTF> {
  if (typeof source === 'string') {
    return loaders.gltf.loadAsync(source)
  }
  return new Promise<GLTF>((resolve, reject) => {
    loaders.gltf.parse(source, '', resolve, reject)
  })
}

export type { GLTF }
