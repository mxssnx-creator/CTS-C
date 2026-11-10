import type {Candle,Direction,SignalState} from './types'

/** Causal OHLCV calculations. Channels and confirmation baselines exclude the current bar. */
export function technicalSignal(state:SignalState,bar:Candle,type:string,period:number):Direction|undefined{
  const s=state.technical??={count:0,bars:[],fast:bar.close,slow:bar.close,trSum:0,plusSum:0,minusSum:0,dxSum:0,dxCount:0}
  const prior=s.bars.at(-1),fast=s.fast,slow=s.slow,atr=s.atr
  const channelReady=s.bars.length>=period
  const channel=s.bars.slice(-period)
  const upper=channelReady?Math.max(...channel.map(b=>b.high)):Infinity,lower=channelReady?Math.min(...channel.map(b=>b.low)):-Infinity
  const averageVolume=channelReady?channel.reduce((sum,b)=>sum+b.volume,0)/channel.length:0
  if(prior){
    const tr=Math.max(bar.high-bar.low,Math.abs(bar.high-prior.close),Math.abs(bar.low-prior.close))
    const up=bar.high-prior.high,down=prior.low-bar.low,plus=up>down&&up>0?up:0,minus=down>up&&down>0?down:0
    if(s.atr===undefined){
      s.trSum+=tr;s.plusSum+=plus;s.minusSum+=minus
      if(s.count===period){s.atr=s.trSum/period;s.plus=s.plusSum/period;s.minus=s.minusSum/period}
    }else{s.atr=(s.atr*(period-1)+tr)/period;s.plus=(s.plus!*(period-1)+plus)/period;s.minus=(s.minus!*(period-1)+minus)/period}
    if(s.atr!==undefined){
      const denominator=s.plus!+s.minus!,dx=denominator?100*Math.abs(s.plus!-s.minus!)/denominator:0
      if(s.adx===undefined){s.dxSum+=dx;s.dxCount++;if(s.dxCount===period)s.adx=s.dxSum/period}
      else s.adx=(s.adx*(period-1)+dx)/period
    }
  }
  s.fast+=2/(period+1)*(bar.close-s.fast);s.slow+=2/(2*period+1)*(bar.close-s.slow)
  let signal:Direction|undefined
  if(channelReady&&prior){
    const long=s.fast>s.slow&&s.slow>slow&&bar.close>s.fast,short=s.fast<s.slow&&s.slow<slow&&bar.close<s.fast
    if(type==='Trend'){if(long)signal='long';else if(short)signal='short'}
    if(type==='Trend_ADX'&&s.adx!==undefined&&s.adx>=20){if(long&&s.plus!>s.minus!)signal='long';else if(short&&s.minus!>s.plus!)signal='short'}
    if(type==='Trend_Efficiency'){
      const closes=[...channel.map(b=>b.close),bar.close],distance=closes.slice(1).reduce((sum,c,i)=>sum+Math.abs(c-closes[i]),0)
      const efficiency=distance?Math.abs(bar.close-closes[0])/distance:0
      if(efficiency>=.3){if(long)signal='long';else if(short)signal='short'}
    }
    // Adapted from CTS-G trend fade / reversal-break research. No imported training claims.
    if(type==='Trend_Fade'||type==='Break_Reversal'){
      const priorCloses=s.bars.map(b=>b.close),sample=priorCloses.slice(-31),returns=sample.slice(1).map((c,i)=>Math.log(c/sample[i]))
      const mean=returns.reduce((sum,v)=>sum+v,0)/Math.max(1,returns.length),sigma=Math.sqrt(returns.reduce((sum,v)=>sum+(v-mean)**2,0)/Math.max(1,returns.length))
      if(sigma>0&&returns.length>=Math.min(30,period)){
        if(type==='Trend_Fade'){
          const spread=(s.fast-s.slow)/bar.close,turn=[...priorCloses.slice(-3),bar.close],falling=turn.slice(1).every((c,i)=>c<turn[i]),rising=turn.slice(1).every((c,i)=>c>turn[i])
          if(Math.abs(spread)/sigma>=1.5){if(spread>0&&falling)signal='short';else if(spread<0&&rising)signal='long'}
        }else if(s.bars.length>=60){
          const context=bar.close/s.bars.at(-60)!.close-1,priorChannel=s.bars.slice(-period-1,-1)
          if(bar.close>upper&&prior.close<=Math.max(...priorChannel.map(b=>b.high))&&context/sigma<=-6)signal='long'
          else if(bar.close<lower&&prior.close>=Math.min(...priorChannel.map(b=>b.low))&&context/sigma>=6)signal='short'
        }
      }
    }
    if(type==='Break'||type==='Break_Volume'){
      const volumeReady=type!=='Break_Volume'||(averageVolume>0&&bar.volume>=1.5*averageVolume)
      if(volumeReady){if(bar.close>upper&&long)signal='long';else if(bar.close<lower&&short)signal='short'}
    }
    if(type==='Break_ATR'&&atr!==undefined&&atr>0){
      if(prior.close<=fast+2*atr&&bar.close>fast+2*atr&&long)signal='long'
      else if(prior.close>=fast-2*atr&&bar.close<fast-2*atr&&short)signal='short'
    }
    if(type==='Break_Retest'){
      const pending=s.retest
      if(pending&&s.count<=pending.expires){
        if(pending.direction==='long'&&bar.low<=pending.level&&bar.close>pending.level&&long)signal='long'
        else if(pending.direction==='short'&&bar.high>=pending.level&&bar.close<pending.level&&short)signal='short'
        if(signal)s.retest=undefined
      }else s.retest=undefined
      if(!s.retest&&!signal){if(bar.close>upper&&long)s.retest={direction:'long',level:upper,expires:s.count+period};else if(bar.close<lower&&short)s.retest={direction:'short',level:lower,expires:s.count+period}}
    }
  }
  const retained=type==='Break_Reversal'?Math.max(period+1,60):type==='Trend_Fade'?Math.max(period+1,31):period
  s.bars.push({...bar});if(s.bars.length>retained)s.bars.shift();s.count++;state.count++
  return signal
}
