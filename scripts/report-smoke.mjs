/** Exercise the real standalone report, including decompression, filters and mobile layout. */
import assert from 'node:assert/strict'
import {readFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {chromium} from 'playwright-core'
const report=resolve(process.argv[2]||''),summary=JSON.parse(await readFile(resolve(process.argv[3]||''),'utf8'))
assert.equal(summary.completedJobs,950);assert.equal(summary.types.length,19)
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 await page.goto(pathToFileURL(report).href)
 await page.waitForFunction(()=>document.querySelector('#controls')?.disabled===false)
 assert.equal(await page.locator('#matrix tbody tr').count(),228)
 assert.equal(await page.locator('#hourly tbody tr').count(),24)
 for(let p=0;p<summary.summaries.length;p++){
  await page.locator('#policy').selectOption(String(p))
  for(const type of summary.types){await page.locator('#type').selectOption(type);assert.equal(await page.locator('#matrix tbody tr').count(),12);assert.equal(await page.locator('.chart svg').count(),6)}
 }
 await page.locator('#type').selectOption('*');await page.locator('#policy').selectOption('2')
 for(const stage of ['base','main','real','live'])await page.locator('#stage').selectOption(stage)
 for(const dimension of ['range','coordination','exitMode','source','tpStep','slRatio','direction','symbol'])await page.locator('#dimension').selectOption(dimension)
 await page.locator('#range').selectOption('Micro');await page.locator('#exit').selectOption('trailing-only');assert.equal(await page.locator('#matrix tbody tr').count(),76)
 await page.locator('#range').selectOption('*');await page.locator('#exit').selectOption('*')
 const download=page.waitForEvent('download');await page.locator('#csv').click();assert.equal((await download).suggestedFilename(),'CTS-C-indication-strategy-matrix.csv')
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 if(process.env.CTS_UI_OUTPUT){await mkdir(process.env.CTS_UI_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'report-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'report-desktop.png'),fullPage:true})}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({reportBrowserPassed:true,policies:4,indicationFamilies:19,matrixRows:228,hourlyRows:24,charts:6,csv:true,mobileWidth:390,errors}))
}finally{await browser.close()}
