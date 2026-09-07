/** Real GLB loading, independent instance state, fill/muzzle contracts, and both renderers. */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.BASE_URL || 'http://localhost:5180'
const output = process.env.ARTIFACT_DIR || '/tmp/pascal-strike-weapons'
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu']})
try {
  for(const backend of ['webgl','webgpu']) {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
    page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())})
    await page.goto(`${base}/?dev=weapons${backend==='webgl'?'&webgl=1':''}`)
    await page.waitForFunction(()=>window.__psWeapons)
    for(const kind of ['rifle','pistol','knife']) {
      await page.evaluate(kind=>window.__psWeapons.select(kind),kind)
      await page.waitForTimeout(200)
      const result=await page.evaluate(async kind=>{
        const {createWeaponModel}=await import('/src/weapons/weapon-model.ts')
        const primary=window.__psWeapons.models[kind]
        const second=createWeaponModel({kind,team:'b',quality:'first'});await second.ready
        function paint(model){const mats=[];model.object.traverse(n=>{if(n.isMesh)for(const m of Array.isArray(n.material)?n.material:[n.material])if(m.name.startsWith('TeamPaint'))mats.push(m)});return mats}
        const a=paint(primary),b=paint(second);const original=a[0].color.getHex()
        second.setTeam('b');primary.setPaintLevel(.35);second.setPaintLevel(.8)
        const fill=primary.object.getObjectByName('PaintLevel_export'),otherFill=second.object.getObjectByName('PaintLevel_export')
        primary.muzzle.updateWorldMatrix(true,false)
        const muzzle=primary.muzzle.getWorldPosition(primary.object.position.clone()).toArray()
        const result={ready:primary.object.userData.weaponStatus,cloneReady:second.object.userData.weaponStatus,independent:a.every(m=>!b.includes(m)),unchanged:a[0].color.getHex()===original,fill:fill?.scale.y,otherFill:otherFill?.scale.y,muzzle}
        second.dispose();primary.setPaintLevel(1)
        const third=createWeaponModel({kind,team:'a',quality:'third'});await third.ready
        result.recreated=third.object.userData.weaponStatus;third.dispose()
        return result
      },kind)
      assert.equal(result.ready,'ready');assert.equal(result.cloneReady,'ready');assert.equal(result.recreated,'ready')
      assert(result.independent && result.unchanged);assert(result.muzzle.every(Number.isFinite));assert(kind==='knife' ? result.muzzle[1]>.2 : result.muzzle[2]<-.2)
      if(kind!=='knife'){assert.equal(result.fill,.35);assert.equal(result.otherFill,.8)}
      await page.screenshot({path:`${output}/${kind}-${backend}.png`})
    }
    const hands=await page.evaluate(async()=>{
      const {createFirstPersonArms}=await import('/src/characters/first-person.ts')
      const {DEFAULT_CHARACTERS}=await import('/src/characters/catalog.ts')
      const results=[]
      for(const character of DEFAULT_CHARACTERS){
        const arms=await createFirstPersonArms(character)
        const count=()=>{let total=0;arms.object.traverse(n=>{if(n.isSkinnedMesh&&n.visible)total+=n.geometry.index.count});return total}
        const full=count();arms.setSupportHand(false);const single=count();arms.setSupportHand(true)
        arms.object.updateMatrixWorld(true)
        const hand=arms.object.getObjectByName('DEF-handR'),index=arms.object.getObjectByName('DEF-f_index01R')
        const wrist=hand.getWorldPosition(arms.object.position.clone()),gun=index.quaternion.clone()
        arms.setWeapon('knife');arms.object.updateMatrixWorld(true)
        const curl=gun.angleTo(index.quaternion),drift=wrist.distanceTo(hand.getWorldPosition(arms.object.position.clone()))
        arms.setWeapon('pistol');const restoredPose=gun.angleTo(index.quaternion)
        results.push({full,single,restored:count(),curl,drift,restoredPose});arms.dispose()
      }
      return results
    })
    for(const hand of hands){assert(hand.single>0&&hand.single<hand.full);assert.equal(hand.restored,hand.full);assert(hand.curl>.1);assert(hand.drift<.00001);assert(hand.restoredPose<.00001)}
    assert.deepEqual(errors,[])
    console.log(`${backend}: all three GLBs render, mounts/fills work, team materials are independent, disposal preserves cached assets`)
    await page.close()
  }
} finally {await browser.close()}
