/** Exercise the real standalone report, including decompression, filters and mobile layout. */
import assert from 'node:assert/strict'
import {readFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium} from 'playwright-core'
const report=resolve(process.argv[2]||''),summary=JSON.parse(await readFile(resolve(process.argv[3]||''),'utf8'))
const number=v=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(v),pf=r=>!r?.closes?'—':!r.loss&&r.profit>0?'∞':new Intl.NumberFormat('en-US',{maximumFractionDigits:4}).format(r.loss?r.profit/r.loss:1),stages=['base','main','real','live']
assert.equal(summary.completedJobs,950);assert.equal(summary.types.length,19)
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
let verifiedNumericCells=0
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(pathToFileURL(report).href)
 await page.waitForFunction(()=>document.querySelector('#controls')?.disabled===false)
 assert.equal(await page.locator('#matrix tbody tr').count(),228)
 assert.equal(await page.locator('#hourly tbody tr').count(),24)
 assert.equal(await page.locator('#families tbody tr').count(),19)
 assert.equal(await page.locator('#heatmap tbody tr').count(),19)
 for(let p=0;p<summary.summaries.length;p++){
  const scope=summary.summaries[p],metrics=new Map(),cover=new Map()
  for(const row of scope.indicationStrategies){const [t,s,,c,e]=JSON.parse(row.key),k=JSON.stringify([t,c,e,s]),v=metrics.get(k)||{closes:0,profit:0,loss:0};v.closes+=row.closes;v.profit+=row.profit;v.loss+=row.loss;metrics.set(k,v)}
  for(const row of scope.indicationStrategyCoverage){const [t,s,,c,e]=JSON.parse(row.key),k=JSON.stringify([t,c,e,s]),v=cover.get(k)||{sets:0,enough:0};v.sets+=row.sets;v.enough+=row.enough;cover.set(k,v)}
  await page.locator('#policy').selectOption(String(p))
  for(const type of summary.types){
   await page.locator('#type').selectOption(type);assert.equal(await page.locator('#matrix tbody tr').count(),12);assert.equal(await page.locator('.chart svg').count(),6)
   const live=scope.groups.find(r=>r.key===JSON.stringify(['live','type',type]));assert.equal(await page.locator('#cards .card').nth(1).locator('b').textContent(),pf(live))
   const rows=await page.locator('#matrix tbody tr').evaluateAll(rows=>rows.map(r=>Array.from(r.cells).map(c=>c.textContent)))
   for(const row of rows)for(const [i,stage]of stages.entries()){
    const key=JSON.stringify([type,row[1].toLowerCase(),row[2],stage]),m=metrics.get(key),c=cover.get(key),rate=c?.sets?new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(100*c.enough/c.sets)+'%':'—'
    assert.equal(row[i+3],pf(m)+' / '+number(m?.closes||0)+' / '+rate,'matrix '+p+'/'+key)
    verifiedNumericCells++
   }
  }
  await page.locator('#type').selectOption('*')
  const ranges=summary.settings.catalog.strategyEnabledRanges||['Micro','Minimal','Short','Normal','Long','Wide']
  for(const range of ranges){
   await page.locator('#range').selectOption(range)
   const actual=await page.locator('#matrix tbody tr').evaluateAll(rows=>rows.map(r=>Array.from(r.cells).map(c=>c.textContent)))
   assert.equal(actual.length,228)
   for(const row of actual)for(const [i,stage]of stages.entries()){
    const type=row[0].replaceAll(' ','_'),key=JSON.stringify([type,stage,range,row[1].toLowerCase(),row[2]])
    const m=scope.indicationStrategies.find(r=>r.key===key),c=scope.indicationStrategyCoverage.find(r=>r.key===key)
    const rate=c?.sets?new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(100*c.enough/c.sets)+'%':'—'
    assert.equal(row[i+3],pf(m)+' / '+number(m?.closes||0)+' / '+rate,'range matrix '+p+'/'+key)
    verifiedNumericCells++
   }
  }
  await page.locator('#range').selectOption('*')
 }
 await page.locator('#type').selectOption('*');await page.locator('#policy').selectOption('0')
 for(const stage of ['base','main','real','live'])await page.locator('#stage').selectOption(stage)
 for(const dimension of ['range','coordination','exitMode','source','tpStep','slRatio','direction','symbol'])await page.locator('#dimension').selectOption(dimension)
 await page.locator('#range').selectOption('Micro');await page.locator('#exit').selectOption('trailing-only');assert.equal(await page.locator('#matrix tbody tr').count(),76)
 await page.locator('#range').selectOption('*');await page.locator('#exit').selectOption('*')
 const download=page.waitForEvent('download');await page.locator('#csv').click();assert.equal((await download).suggestedFilename(),'CTS-C-indication-strategy-matrix.csv')
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 if(process.env.CTS_UI_OUTPUT){await mkdir(process.env.CTS_UI_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'report-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'report-desktop.png'),fullPage:true})}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({reportBrowserPassed:true,policies:4,indicationFamilies:19,matrixRows:228,verifiedNumericCells,hourlyRows:24,charts:6,csv:true,mobileWidth:390,errors}))
}finally{await browser.close()}
