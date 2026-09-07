/** Refresh bundled assets from the pinned manifests. Run from the repository root. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('../public/characters/', import.meta.url)
const roster = JSON.parse(await readFile(new URL('roster.json', root)))
const sources = {}
async function download(path, url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`${response.status}: ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(new URL(path, root), buffer)
  sources[path] = { url: response.url, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
  console.log(`${path}: ${buffer.length} bytes`)
}
for (const character of roster) {
  const response = await fetch(character.source)
  if (!response.ok) throw new Error(`${response.status}: ${character.source}`)
  const manifest = await response.json()
  await writeFile(new URL(`${character.id}.manifest.json`, root), JSON.stringify(manifest, null, 2) + '\n')
  await download(`${character.id}.glb`, `${manifest.urls.model}?quality=medium&morphs=none`)
}
for (const gender of ['man', 'woman']) {
  await download(`${gender}-animations.glb`, `https://characterstudio.wawasensei.dev/api/models/animations/${gender}.glb`)
}
await writeFile(new URL('sources.json', root), JSON.stringify(sources, null, 2) + '\n')
