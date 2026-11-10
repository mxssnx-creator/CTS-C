import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {chromium} from 'playwright-core'
import {TradingEngine} from '../core/engine.ts'
import {StateStore} from '../core/store.ts'

const directory=await mkdtemp(join(tmpdir(),'ctsc-browser-')),password=randomBytes(24).toString('hex')
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r))
const origin=`http://127.0.0.1:${port}`
const engine=new TradingEngine({symbols:['BTC-USDT'],stageLastN:{base:2,main:2,real:2},stageMinPF:{base:0,main:0,real:0},catalog:{strategyTpSteps:[3],strategySlRatios:[1],strategyExitModes:['fixed'],strategyIndicationTypes:['MA_Cross']}})
engine.processCandles('BTC-USDT',Array.from({length:900},(_,i)=>{const price=100+8*Math.sin(i/9);return {timestamp:1700000040000+i*60000,open:price,high:price,low:price,close:price,volume:1}}))
const store=new StateStore(join(directory,'cts-c.sqlite'));store.saveEngineJSON(engine.serializeState(),[{type:'fixture',reason:'Isolated deterministic UI fixture; zero exchange activity'}],engine.settings);store.close()
const transport=join(directory,'fixture-market.mjs')
await writeFile(transport,`const original=globalThis.fetch;globalThis.fetch=async(input,options={})=>{const u=new URL(String(input));if(!u.hostname.endsWith('bingx.com'))return original(input,options);if((options.method||'GET')!=='GET')throw Error('Exchange writes forbidden in UI test');if(u.pathname.endsWith('/quote/klines')){const interval=u.searchParams.get('interval')||'5m';const ms=Number(interval.slice(0,-1))*({m:60000,h:3600000,d:86400000}[interval.slice(-1)]);const end=Number(u.searchParams.get('endTime')||Date.now());const last=Math.floor(end/ms)*ms;const n=Number(u.searchParams.get('limit')||200);const data=Array.from({length:n},(_,i)=>{const time=last-(n-1-i)*ms;const close=100+8*Math.sin(time/ms/9);return {time,open:close,high:close+.2,low:close-.2,close,volume:100}});return Response.json({code:0,data})}if(u.pathname.includes('/quote/'))return Response.json({code:0,data:['BTC','ETH','SOL','XRP','BCH'].map(s=>({symbol:s+'-USDT',price:'100',time:Date.now()}))});throw Error('Private exchange request forbidden in UI test')};`)
let child,browser,logs=''
try{
 child=spawn(process.execPath,['scripts/start-server.mjs'],{env:{...process.env,NODE_OPTIONS:`--import=${transport}`,HOSTNAME:'127.0.0.1',CTS_HOST:'127.0.0.1',PORT:String(port),NODE_ENV:'production',CTS_DATA_DIR:directory,CTS_ADMIN_PASSWORD:password,BINGX_X02_KEY:'',BINGX_X02_SECRET:'',BINGX_X02_API_KEY:'',BINGX_X02_API_SECRET:'',BINGX_X01_KEY:'',BINGX_X01_SECRET:'',BINGX_X01_API_KEY:'',BINGX_X01_API_SECRET:''},stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',b=>logs=(logs+b).slice(-10000));child.stderr.on('data',b=>logs=(logs+b).slice(-10000))
 for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(origin+'/api/health')).ok)break}catch{}if(i===199)throw Error('Browser server startup timeout');await new Promise(r=>setTimeout(r,100))}
 const executablePath=process.env.CTS_CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)
 browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.goto(origin)
 await page.getByLabel('Workspace password').fill(password);await page.getByRole('button',{name:'Open workspace'}).click()
 await page.getByRole('heading',{name:'Stage diagnostics'}).waitFor()
 assert.ok(await page.getByRole('heading',{name:'Paper equity by close sequence'}).isVisible())
 await page.getByRole('button',{name:'Strategy lab',exact:true}).click()
 const main=page.getByLabel('Main completed samples',{exact:true})
 await main.fill('7');await page.getByLabel('Axis budget ratio',{exact:true}).fill('1.5');await page.getByLabel('TP distance factor',{exact:true}).fill('1.2');await page.getByRole('button',{name:'Save configuration',exact:true}).click()
 await page.getByText('Strategy configuration saved to x02.',{exact:true}).waitFor()
 const saved=(await (await page.request.get(origin+'/api/terminal')).json()).settings;assert.equal(saved.mainEvalPosCount,'7');assert.equal(saved.axisVolumeRatio,'1.5');assert.equal(saved.strategyTpFactor,'1.2');await page.getByRole('heading',{name:'Coordination versus Normal'}).waitFor()
 await main.fill('9');await page.waitForTimeout(5500);assert.equal(await main.inputValue(),'9')
 await page.getByRole('button',{name:'Discard unsaved strategy changes'}).click();assert.equal(await main.inputValue(),'7')
 await page.getByLabel('Import strategy configuration JSON').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"apiSecret":"forbidden"}')})
 await page.getByRole('alert').filter({hasText:'unsupported fields'}).waitFor()
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export JSON',exact:true}).first().click();await download
 await page.getByLabel('Completed candles').selectOption('500')
 await page.getByRole('button',{name:'Run replay',exact:true}).click()
 await page.getByText('Training / holdout',{exact:true}).waitFor({timeout:30000})
 assert.match(await page.getByRole('table').last().innerText(),/Training/)
 await page.getByRole('button',{name:'Positions',exact:true}).click();await page.getByRole('heading',{name:'Position ledger'}).waitFor()
 await page.getByRole('button',{name:'Activity',exact:true}).click();await page.getByRole('heading',{name:'Event stream'}).waitFor()
 await page.getByRole('button',{name:'Connections',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Verify & start x02'}).isEnabled(),false)
 await page.getByLabel('Trading connection',{exact:true}).selectOption('bingx-x01');await page.getByRole('heading',{name:'X01 execution control',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Verify & start x01 mainnet'}).isEnabled(),false)
 await page.getByRole('button',{name:'Strategy lab',exact:true}).click();await page.getByLabel('Main completed samples',{exact:true}).fill('6');await page.getByRole('button',{name:'Save configuration',exact:true}).click();await page.getByText('Strategy configuration saved to x01.',{exact:true}).waitFor()
 assert.equal((await (await page.request.get(origin+'/api/terminal?connection=bingx-x01')).json()).settings.mainEvalPosCount,'6')
 assert.equal((await (await page.request.get(origin+'/api/terminal?connection=bingx-x02')).json()).settings.mainEvalPosCount,'7')
 await page.getByLabel('Trading connection',{exact:true}).selectOption('bingx-x02');await page.getByLabel('Main completed samples',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('input[type=number]')!==null)

 await page.getByRole('button',{name:'Integrations',exact:true}).click();await page.getByLabel('Search integrations').fill('unmatched');await page.getByText('No integration matches this search.').waitFor()
 await page.getByRole('button',{name:'Command center',exact:true}).click()
 if(process.env.CTS_UI_OUTPUT){await mkdir(process.env.CTS_UI_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'desktop.png'),fullPage:true})}
 await page.setViewportSize({width:390,height:844})
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page must not overflow horizontally')
 if(process.env.CTS_UI_OUTPUT)await page.screenshot({path:join(process.env.CTS_UI_OUTPUT,'mobile.png'),fullPage:true})
 await page.reload();await page.getByRole('heading',{name:'Stage diagnostics'}).waitFor()
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Workspace password').waitFor()
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({browserPassed:true,views:6,settingsSave:true,connectionIsolation:true,factorsRoundTrip:true,unsavedDraft:true,importExport:true,replayUiApiData:true,mobileWidth:390,errors,syntheticFixture:true,exchangeWrites:0}))
}finally{
 await browser?.close()
 if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit}
 await rm(directory,{recursive:true,force:true})
}
