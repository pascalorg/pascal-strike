/**
 * Custom maps: hash the GLB, put it in the public Supabase bucket under its own hash, share
 * the public URL through Playroom. Content-addressed names make re-uploads free and immutable.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ENV } from '../config'
import type { MapSelection } from '../types'

export const MAX_MAP_BYTES = 50 * 1024 * 1024

export class MapUploadError extends Error {
  code: 'NO_CONFIG' | 'TOO_BIG' | 'NOT_GLB' | 'UPLOAD_FAILED'
  constructor(code: MapUploadError['code'], message: string) {
    super(message)
    this.name = 'MapUploadError'
    this.code = code
  }
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (client) return client
  if (!ENV.supabaseUrl || !ENV.supabaseKey) {
    throw new MapUploadError(
      'NO_CONFIG',
      'Map uploads need VITE_SUPABASE_URL and VITE_SUPABASE_KEY in .env',
    )
  }
  client = createClient(ENV.supabaseUrl, ENV.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}

export function isConfigured(): boolean {
  return !!(ENV.supabaseUrl && ENV.supabaseKey)
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export function mapNameFromFile(file: File): string {
  return file.name.replace(/\.glb$/i, '').replace(/[-_]+/g, ' ').trim() || 'Custom map'
}

/**
 * Upload a dropped GLB and return the selection everyone else will load.
 * `onProgress` reports 0..1; supabase-js has no upload progress events, so the steps are
 * coarse (hashing, uploading, done) rather than fake-smooth.
 */
export async function uploadMap(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<MapSelection> {
  if (!/\.glb$/i.test(file.name)) {
    throw new MapUploadError('NOT_GLB', 'Only .glb files exported from Pascal are supported.')
  }
  if (file.size > MAX_MAP_BYTES) {
    throw new MapUploadError('TOO_BIG', `That file is ${(file.size / 1e6).toFixed(1)} MB — the limit is 50 MB.`)
  }

  const supabase = getSupabase()
  const bucket = ENV.supabaseMapsBucket
  onProgress?.(0.05)

  const buffer = await file.arrayBuffer()
  onProgress?.(0.2)
  const hash = await sha256Hex(buffer)
  onProgress?.(0.35)

  const path = `${hash}.glb`
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: 'model/gltf-binary',
    upsert: false,
    cacheControl: '31536000',
  })

  if (error && !isDuplicate(error)) {
    throw new MapUploadError('UPLOAD_FAILED', error.message || 'Upload failed')
  }
  onProgress?.(0.9)

  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  if (!data?.publicUrl) throw new MapUploadError('UPLOAD_FAILED', 'No public URL for the upload')
  onProgress?.(1)

  return { url: data.publicUrl, name: mapNameFromFile(file), id: hash }
}

/** A duplicate is a success: the bytes are already there under the same hash. */
function isDuplicate(error: { message?: string; statusCode?: string; status?: number } | null): boolean {
  if (!error) return false
  const status = Number(error.statusCode ?? error.status ?? 0)
  if (status === 409) return true
  return /already exists|duplicate/i.test(error.message ?? '')
}
