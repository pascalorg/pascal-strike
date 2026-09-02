import fs from 'node:fs';
const buf = fs.readFileSync(process.argv[2]);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const g = json;
console.log('asset', JSON.stringify(g.asset));
console.log('extensionsUsed', g.extensionsUsed);
console.log('scenes', g.scenes?.length, 'nodes', g.nodes?.length, 'meshes', g.meshes?.length, 'materials', g.materials?.length, 'textures', g.textures?.length, 'images', g.images?.length, 'animations', g.animations?.length);
console.log('scene extras', JSON.stringify(g.scenes?.[0]?.extras));
console.log('asset extras', JSON.stringify(g.asset?.extras));
// print node tree
const nodes = g.nodes || [];
const children = new Set(); nodes.forEach(n => (n.children||[]).forEach(c => children.add(c)));
function pr(i, d) {
  const n = nodes[i];
  const mesh = n.mesh !== undefined ? ` mesh=${n.mesh}(${g.meshes[n.mesh].name||''} prims=${g.meshes[n.mesh].primitives.length})` : '';
  const ex = n.extras ? ' extras=' + JSON.stringify(n.extras) : '';
  const t = n.translation ? ' t=' + n.translation.map(v=>+v.toFixed(2)) : '';
  const s = n.scale ? ' s=' + n.scale.map(v=>+v.toFixed(2)) : '';
  console.log('  '.repeat(d) + `[${i}] ${n.name||''}${mesh}${t}${s}${ex}`);
  (n.children||[]).forEach(c => pr(c, d+1));
}
const roots = g.scenes[0].nodes;
console.log('--- tree ---');
roots.forEach(r => pr(r, 0));
console.log('--- materials ---');
(g.materials||[]).forEach((m,i)=>console.log(i, m.name, JSON.stringify(m.extras||''), m.alphaMode||'', m.pbrMetallicRoughness?.baseColorTexture?'tex':'', m.emissiveTexture?'emissiveTex':''));
console.log('--- images ---');
(g.images||[]).forEach((im,i)=>console.log(i, im.name, im.mimeType, im.uri ? 'uri' : 'bufferView'));
// vertex count
let tris=0, verts=0;
for (const m of g.meshes||[]) for (const p of m.primitives) { if (p.indices!==undefined) tris += g.accessors[p.indices].count/3; verts += g.accessors[p.attributes.POSITION].count; }
console.log('tris', tris, 'verts', verts);
// bounds from accessor min/max of all POSITION (local only)
