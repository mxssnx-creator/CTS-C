#!/usr/bin/env node
// Optional offline Lightweight Charts export. It does not connect to an exchange.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--help') || args.length < 2) {
  console.log('Usage: node integrations/research/chart.mjs candles.json chart.html [path/to/lightweight-charts.standalone.production.js]')
  process.exit(args.includes('--help') ? 0 : 2)
}
const [input, output, library = 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'] = args
const bundle = JSON.parse(await readFile(input, 'utf8'))
if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.candles) || !bundle.candles.length || !bundle.origin) {
  throw new Error('Expected validated bridge candle bundle; run bridge.py validate first')
}
const data = bundle.candles.map(c => ({ time: c.timestamp / 1000, open: c.open, high: c.high, low: c.low, close: c.close }))
if (data.some((c, i) => !Number.isInteger(c.time) || ![c.open, c.high, c.low, c.close].every(Number.isFinite) || (i && c.time <= data[i - 1].time))) {
  throw new Error('Chart requires ascending unique candles with finite OHLC values')
}
const script = await readFile(resolve(library), 'utf8')
const notice = await readFile(resolve(dirname(library), '../NOTICE'), 'utf8').catch(() => '')
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const json = JSON.stringify(data).replaceAll('<', '\\u003c')
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CTS-C research chart</title>
<style>body{background:#07111d;color:#c9d6e5;font:14px system-ui;margin:24px}#chart{height:65vh}a{color:#36d1b4}pre{white-space:pre-wrap;font-size:11px;color:#8798ad}</style>
<h1>${escape(bundle.symbol)} · research</h1><p>Source: ${escape(bundle.origin)}. This export contains market candles, not verified CTS execution markers.</p><div id="chart"></div>
<p>Charts by <a href="https://www.tradingview.com/">TradingView Lightweight Charts™</a></p><pre>${escape(notice || 'Copyright (c) TradingView, Inc. Lightweight Charts is licensed under Apache License 2.0. See the installed package NOTICE and LICENSE.')}</pre>
<script>${script.replaceAll('</script', '<\\/script')}</script><script>
const chart = LightweightCharts.createChart(document.getElementById('chart'), {autoSize:true,layout:{background:{color:'#07111d'},textColor:'#b7c7db',attributionLogo:true},grid:{vertLines:{color:'#152338'},horzLines:{color:'#152338'}}});
const series = chart.addSeries(LightweightCharts.CandlestickSeries, {upColor:'#25cfa3',downColor:'#f27b89',borderVisible:false,wickUpColor:'#25cfa3',wickDownColor:'#f27b89'});
series.setData(${json});chart.timeScale().fitContent();</script></html>`
await mkdir(dirname(resolve(output)), { recursive: true })
await writeFile(output, html)
console.log(JSON.stringify({ output: resolve(output), origin: bundle.origin, orderPlacement: false }))
