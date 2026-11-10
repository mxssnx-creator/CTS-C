import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
const directory=await mkdtemp(join(tmpdir(),'ctsc-runtime-')), password=randomBytes(24).toString('hex')
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
const origin=`http://127.0.0.1:${port}`
let child,logs=''
async function start(){
 child=spawn(process.execPath,['scripts/start-server.mjs'],{env:{...process.env,HOSTNAME:'127.0.0.1',PORT:String(port),NODE_ENV:'production',CTS_DATA_DIR:directory,CTS_ADMIN_PASSWORD:password,BINGX_X02_KEY:'',BINGX_X02_SECRET:'',BINGX_X02_API_KEY:'',BINGX_X02_API_SECRET:''},stdio:['ignore','pipe','pipe']})
 child.stdout.on('data',b=>logs=(logs+b).slice(-10000));child.stderr.on('data',b=>logs=(logs+b).slice(-10000))
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(origin+'/api/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,100))}throw new Error('Startup timeout '+logs)
}
async function stop(){if(!child||child.exitCode!==null)return;const exit=once(child,'exit');child.kill('SIGTERM');await exit}
async function login(){const r=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]}
async function action(cookie,body,extra={}){return fetch(origin+'/api/terminal',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)})}
try{
 await start()
 assert.equal((await fetch(origin+'/')).status,200)
 assert.equal((await fetch(origin+'/api/terminal')).status,401)
 const cookie=await login()
 const snapshot=await fetch(origin+'/api/terminal',{headers:{Cookie:cookie}});assert.equal(snapshot.status,200)
 const state=await snapshot.json();assert.equal(state.readiness.x02Configured,false);assert.equal(state.equity,null);assert.equal(state.openPositions.length,0);assert.equal(state.engine.catalogCount,252)
 assert.equal((await action(cookie,{action:'save-settings',settings:{mainEvalPosCount:7,volumeFactor:.01,symbolCount:100}})).status,200)
 assert.equal((await action(cookie,{action:'save-settings',settings:{mainEvalPosCount:0}})).status,400)
 assert.equal((await action(cookie,{action:'start-x02'})).status,400)
 assert.equal((await action(cookie,{action:'pause-x02'},{Origin:'https://attacker.invalid','Sec-Fetch-Site':'cross-site'})).status,403)
 const csv=await fetch(origin+'/api/terminal/export',{headers:{Cookie:cookie}});assert.equal(csv.status,200);assert.match(await csv.text(),/^timestamp,equity,drawdownPct,source/)
 assert.equal((await fetch(origin+'/api/market-data/candles?symbol=../invalid',{headers:{Cookie:cookie}})).status,400)
 if(process.env.CTS_TEST_NETWORK==='1'){
  const market=await fetch(origin+'/api/market-data?exchange=bingx&demo=true&symbol=BTC-USDT',{headers:{Cookie:cookie}});assert.equal(market.status,200);assert.ok((await market.json()).data.price>0)
  const candles=await fetch(origin+'/api/market-data/candles?exchange=bingx&demo=true&symbol=BTC-USDT&interval=5m',{headers:{Cookie:cookie}});assert.equal(candles.status,200);const bars=await candles.json();assert.ok(bars.data.length>=100);assert.equal(bars.source,'bingx:demo')
  const replay=await fetch(origin+'/api/terminal/replay',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({symbol:'BTC-USDT',interval:'5m',exchange:'bingx',demo:true})});assert.equal(replay.status,200);const study=await replay.json();assert.equal(study.executionEligible,false);assert.equal(study.configurations,252);assert.ok(study.trainingCandles>0&&study.holdoutCandles>0)
  console.log(JSON.stringify({marketApiPassed:true,source:bars.source,actualCandles:bars.data.length,replayConfigurations:study.configurations,ordersSubmitted:0}))
 }
 await stop();await start()
 const restored=await fetch(origin+'/api/terminal',{headers:{Cookie:cookie}});assert.equal(restored.status,200);assert.equal((await restored.json()).settings.mainEvalPosCount,'7')
 assert.equal((await fetch(origin+'/api/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}})).status,200)
 await stop();await start()
 assert.equal((await fetch(origin+'/api/terminal',{headers:{Cookie:cookie}})).status,401)
 console.log('Runtime passed: clean terminal, auth, settings persistence, x02 missing-credential block, CSRF, CSV, input validation, restart, durable logout. Zero exchange orders.')
}finally{await stop();await rm(directory,{recursive:true,force:true})}
