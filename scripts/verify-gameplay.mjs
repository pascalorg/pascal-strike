/** Two real Playroom clients. Run against a built preview; creates a temporary game room. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5181'
const output = process.env.ARTIFACT_DIR || '/tmp/pascal-strike-gameplay'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu'] })
try {
  const a = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const b = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  for (const page of [a,b]) {
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', message => { if (/reject|did not count/i.test(message.text())) console.log(message.text()) })
  }
  await a.goto(`${base}/?debug=1&webgl=1`)
  await a.getByPlaceholder('Your name').fill('Gameplay Host')
  await a.getByRole('button', {name:'Play',exact:true}).click()
  await a.waitForFunction(()=>window.__ps?.registry, {}, {timeout:90000})
  await a.evaluate(()=>window.__ps.pickTeam('a'))
  const hash = await a.evaluate(()=>location.hash)
  await b.goto(`${base}/?debug=1&webgl=1${hash}`)
  await b.getByPlaceholder('Your name').fill('Gameplay Guest')
  await b.getByRole('button',{name:'Select Janette'}).click()
  await b.getByRole('button',{name:'Join match',exact:true}).click()
  await b.waitForFunction(()=>window.__ps?.registry, {}, {timeout:90000})
  await b.evaluate(()=>window.__ps.pickTeam('b'))
  await a.evaluate(()=>window.__ps.botsFill(false))
  await b.waitForTimeout(5000)
  const target = await b.evaluate(()=>window.__ps.registry.local.id)
  await a.waitForFunction(id=>window.__ps.engine.scene.getObjectByName(id)?.userData.characterStatus==='ready', target)
  await b.evaluate(()=>{window.__ps.menu(false);window.__ps.look(0,-240)})
  await b.locator('canvas').first().click({position:{x:720,y:450}})
  await b.waitForFunction(()=>!!document.pointerLockElement)
  await b.keyboard.press('p')
  await b.waitForFunction(()=>!document.pointerLockElement && !window.__ps.menu())
  await b.waitForTimeout(150)
  await b.screenshot({path:`${output}/pointer.png`})
  assert.equal(await b.locator('.ps-pointer-hint').isVisible(),true)
  const pitch = await b.evaluate(()=>window.__ps.registry.local.pitch)
  await a.bringToFront()
  const poses = []
  for(let i=0;i<20;i++) {
    poses.push(await a.evaluate(id=>window.__ps.engine.scene.getObjectByName(id).getObjectByName('DEF-spine002').quaternion.toArray(), target))
    await a.waitForTimeout(200)
  }
  const first = poses[0]
  const angles = poses.map(q=>2*Math.acos(Math.min(1,Math.abs(q.reduce((sum,v,i)=>sum+v*first[i],0)))))
  assert(Math.max(...angles)<.5, `Idle aim drifted ${Math.max(...angles)} radians`)
  assert.equal(await b.evaluate(()=>window.__ps.registry.local.pitch),pitch)
  console.log('P releases only the pointer; inactive-tab aim remains stable')

  // Submit individually validated hits through the same host authority as actual projectiles.
  async function hit(i) {
    return a.evaluate(({target,i})=>{
      const g=window.__ps,e=g.registry.get(target)
      return g.host().submitHit({by:g.room.me.id,target,shotId:`gameplay-check:${i}`,point:[e.position.x,e.position.y+1.2,e.position.z],normal:[0,0,1],part:'torso',weapon:'rifle'})
    },{target,i})
  }
  assert.equal(await b.locator('.ps-armor b').textContent(),'50')
  // Flat lawn, away from the house: acceleration must not be measured against a wall.
  await b.evaluate(()=>window.__ps.local().place([-5,.1,13],0))
  await a.waitForFunction(id=>Math.abs(window.__ps.registry.get(id).position.z-13)<1,target)
  await b.evaluate(()=>window.__ps.move(0,1))
  await b.waitForTimeout(800)
  const before = await b.evaluate(()=>window.__ps.registry.local.speed)
  assert(await hit(0))
  await b.waitForFunction(()=>window.__ps.registry.local.hp===78)
  await b.waitForTimeout(80)
  const tagged = await b.evaluate(()=>({speed:window.__ps.registry.local.speed,armor:window.__ps.registry.local.armor,until:window.__ps.registry.local.taggedUntil,now:performance.now()}))
  assert.equal(tagged.armor,38)
  assert(tagged.until>tagged.now)
  console.log('Movement speed before/after hit',before,tagged.speed)
  assert(before>4.5 && tagged.speed<before*.8, 'Tagging must reduce actual controller speed')
  await b.evaluate(()=>window.__ps.stop())
  assert.equal(await b.locator('.ps-armor b').textContent(),'38')
  await a.screenshot({path:`${output}/hit.png`})
  for(let i=1;i<4;i++){assert(await hit(i));await a.waitForTimeout(110)}
  await b.waitForFunction(()=>window.__ps.registry.local.hp===12)
  assert(await hit(4))
  await b.waitForFunction(()=>window.__ps.registry.local.alive===false)
  await a.waitForFunction(()=>document.querySelector('.ps-kill-confirm')?.textContent.includes('Gameplay Guest'))
  await a.waitForTimeout(250)
  await a.screenshot({path:`${output}/kill.png`})
  await b.waitForFunction(()=>window.__ps.registry.local.alive && window.__ps.registry.local.hp===100,{}, {timeout:10000})
  assert.equal(await b.locator('.ps-armor b').textContent(),'50')
  console.log('Five body hits kill; armor, hit feedback, elimination and armored respawn sync to both clients')
  await a.evaluate(()=>{window.__ps.menu(false);window.__ps.local().place([-5,.1,13],-Math.PI/2)})
  await b.evaluate(()=>window.__ps.local().place([-1,.1,13],Math.PI/2))
  await a.waitForTimeout(3500)
  // Aim at the torso; hold actual fire so weapon, projectile, authority and remote animation all run.
  await a.evaluate(()=>{window.__ps.look(0,55);window.__ps.fireFor(250)})
  await b.waitForFunction(()=>window.__ps.registry.local.hp<100)
  await a.waitForTimeout(350)
  console.log('Actual automatic projectiles damage the other client',await b.evaluate(()=>window.__ps.registry.local.hp))
  await a.screenshot({path:`${output}/shooting.png`})
  await a.evaluate(()=>window.__ps.stop())
  await b.bringToFront()
  await b.keyboard.press('p')
  await b.waitForFunction(()=>!!document.pointerLockElement)
  await b.waitForTimeout(200)
  await b.keyboard.press('Escape')
  await b.waitForFunction(()=>!document.pointerLockElement)
  await b.waitForFunction(()=>window.__ps.menu())
  console.log('Esc releases the pointer and opens the menu')
  assert.deepEqual(errors,[])
  console.log('No browser runtime errors')
} finally { await browser.close() }
