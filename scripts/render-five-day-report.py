#!/usr/bin/env python3
"""Render summary.json from scripts/simulation-50.ts into line-by-line 4-hour text, CSV and a self-contained HTML report.

Standard library only. No external assets, network access or account credentials.
Usage: render-five-day-report.py <summary.json> <output-directory>
"""
import csv
import html
import json
import sys
from pathlib import Path

STAGES = ["base", "main", "real", "exec", "live"]
DIMENSIONS = ["range", "coordination", "direction", "exitMode", "tpStep", "slRatio", "source", "type"]
STAGE_COLUMNS = [
    "closes", "wins", "winRatePct", "profit", "loss", "netPnl", "cost", "notional",
    "entries", "additions", "profitFactor", "pfState", "modeledOrderActions",
]
COVERAGE_COLUMNS = ["sets", "enough", "enoughSamplesPct", "qualified", "admissionReady", "validatedSets", "validatedSamples", "unfinished"]


def pf_text(row):
    if not row.get("closes"):
        return "-"
    state = row.get("pfState")
    if state == "no-losses":
        return "inf"
    return f"{row.get('profitFactor', 1):.4f}"


def win_rate(row):
    closes = row.get("closes", 0)
    return f"{100 * row.get('wins', 0) / closes:.2f}" if closes else "-"


def fmt(value, digits=4):
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def stage_fields(row):
    return {
        "closes": row.get("closes", 0),
        "wins": row.get("wins", 0),
        "winRatePct": win_rate(row),
        "profit": fmt(row.get("profit", 0.0)),
        "loss": fmt(row.get("loss", 0.0)),
        "netPnl": fmt(row.get("netPnl", 0.0)),
        "cost": fmt(row.get("cost", 0.0)),
        "notional": fmt(row.get("notional", 0.0), 2),
        "entries": row.get("entries", 0),
        "additions": row.get("additions", 0),
        "profitFactor": pf_text(row),
        "pfState": row.get("pfState", "-"),
        "modeledOrderActions": row.get("modeledOrderActions", 0),
    }


def coverage_fields(c):
    if not c or not c.get("sets"):
        return {"sets": 0, "enough": 0, "enoughSamplesPct": "n/a", "qualified": 0, "admissionReady": 0,
                "validatedSets": 0, "validatedSamples": 0, "unfinished": 0}
    pct = c.get("enoughSamplesPct")
    return {
        "sets": c.get("sets", 0), "enough": c.get("enough", 0),
        "enoughSamplesPct": f"{pct:.2f}" if pct is not None else "n/a",
        "qualified": c.get("qualified", 0), "admissionReady": c.get("admissionReady", 0),
        "validatedSets": c.get("validatedSets", 0), "validatedSamples": c.get("validatedSamples", 0),
        "unfinished": c.get("unfinished", 0),
    }


def engine_label(profile):
    return profile["name"]


def build_records(summary):
    """Yield one flat record per reported line: bucket, engine, scope, stage and all metrics."""
    for engine in summary["summaries"]:
        name = engine["profile"]["name"]
        frozen = bool(engine["profile"].get("frozenPrehistory"))
        for bucket in engine["buckets"]:
            window = {"bucket": bucket["bucket"] + 1, "startUtc": bucket["startUtc"], "endUtc": bucket["endUtc"]}
            for stage in STAGES:
                row = bucket["stages"][stage]
                yield {**window, "engine": name, "frozenPrehistory": frozen, "scope": "stage", "dimension": "stage", "value": stage,
                       "stage": stage, **stage_fields(row), **coverage_fields(bucket["coverage"][stage])}
        # Group rows are keyed by [bucket, stage, dimension, value]; the bucket is the zero-based position.
        for group in engine["bucketGroups"]:
            key = json.loads(group["key"])
            if len(key) != 4:
                continue
            bucket_index, stage, dim, value = key
            if dim not in DIMENSIONS:
                continue
            if group["closes"] == 0 and group["entries"] == 0 and group["additions"] == 0:
                continue
            yield {"bucket": bucket_index + 1, "startUtc": engine_bucket_start(engine, bucket_index), "endUtc": engine_bucket_end(engine, bucket_index),
                   "engine": name, "frozenPrehistory": frozen, "scope": "group", "dimension": dim, "value": value, "stage": stage,
                   **stage_fields(group), **coverage_fields({})}


def engine_bucket_start(engine, index):
    return engine["buckets"][index]["startUtc"]


def engine_bucket_end(engine, index):
    return engine["buckets"][index]["endUtc"]


def text_line(record):
    parts = [
        f"B{record['bucket']:02d}",
        f"{record['startUtc']}..{record['endUtc']}",
        f"engine={record['engine']}",
        f"scope={record['scope']}",
        f"stage={record['stage']}" if record["scope"] == "stage" else f"stage={record['stage']} {record['dimension']}={record['value']}",
        f"closes={record['closes']}",
        f"wins={record['wins']}",
        f"winRate={record['winRatePct']}%",
        f"profit={record['profit']}",
        f"loss={record['loss']}",
        f"netPnl={record['netPnl']}",
        f"cost={record['cost']}",
        f"notional={record['notional']}",
        f"entries={record['entries']}",
        f"additions={record['additions']}",
        f"PF={record['profitFactor']}({record['pfState']})",
        f"modeledOrderActions={record['modeledOrderActions']}",
    ]
    if record["scope"] == "stage":
        parts += [
            f"sets={record['sets']}",
            f"enoughSamples={record['enough']}/{record['sets']}({record['enoughSamplesPct']}%)",
            f"qualified={record['qualified']}",
            f"admissionReady={record['admissionReady']}",
            f"validatedSets={record['validatedSets']}",
            f"validatedSamples={record['validatedSamples']}",
            f"unfinished={record['unfinished']}",
        ]
    return " | ".join(parts)


def write_text(records, path):
    with open(path, "w", encoding="utf-8") as handle:
        last = None
        for record in records:
            bucket_header = (record["bucket"], record["engine"])
            if bucket_header != last:
                last = bucket_header
                if record["scope"] == "stage" and record["stage"] == STAGES[0]:
                    handle.write(f"\n=== B{record['bucket']:02d} {record['startUtc']}..{record['endUtc']} UTC | engine {record['engine']}"
                                 f"{' (frozen prehistory subset)' if record['frozenPrehistory'] else ''} ===\n")
            handle.write(text_line(record) + "\n")


CSV_FIELDS = ["bucket", "startUtc", "endUtc", "engine", "frozenPrehistory", "scope", "dimension", "value", "stage"] + STAGE_COLUMNS + COVERAGE_COLUMNS


def write_csv(records, path):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            writer.writerow(record)


def table(headers, rows, numeric_from=None):
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = []
    for row in rows:
        cells = "".join(f"<td>{html.escape(str(v))}</td>" for v in row)
        body.append(f"<tr>{cells}</tr>")
    return f"<div class=\"scroll\"><table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table></div>"


def build_html(summary, records):
    settings = summary.get("settings", {})
    fee = summary.get("feeEvidence", {})
    manifest = summary.get("manifest", {})
    engines = summary["summaries"]
    perf_rows = []
    for engine in engines:
        perf = engine.get("performance", {})
        perf_rows.append([engine["profile"]["name"], engine.get("configurationsAcrossSymbols"), f"{perf.get('maxWorkerRssKiB', 0) / 1024:.0f}", f"{perf.get('summedJobWallMs', 0) / 1000:.0f}"])

    sections = []
    # 1. Overview
    overview = [
        ["Generated (UTC)", summary.get("completedAt", summary.get("generatedAt"))],
        ["Symbols", len(manifest.get("symbols", []))],
        ["Indication types", len(summary.get("types", []))],
        ["Completed symbol/indication jobs", summary.get("completedJobs")],
        ["Prehistory (warmup) minutes", settings.get("warmup")],
        ["Scored window hours", settings.get("hours")],
        ["Reporting bucket hours", (settings.get("bucketMinutes") or 240) / 60],
        ["Fee source", fee.get("feeSource", "verified x02 commission read")],
        ["Maker / taker / slippage share", f"{fee.get('fees', {}).get('makerFeePct')}% / {fee.get('fees', {}).get('takerFeePct')}% / {fee.get('fees', {}).get('slippagePctOfFees')}% of fees"],
        ["Orders submitted", summary.get("ordersSubmitted")],
        ["Actual exchange execution PF", summary.get("actualExchangeExecutionPF") or "unavailable (no-write simulation)"],
        ["Automatic promotion", summary.get("automaticPromotion")],
    ]
    sections.append("<section><h2>Run</h2>" + table(["Field", "Value"], overview) + "</section>")
    sections.append("<section><h2>Engines and resources</h2>" + table(["Engine", "Configurations (all symbols)", "Peak worker RSS MiB", "Summed job wall seconds"], perf_rows) + "</section>")
    sections.append(f"<section><h2>Methodology</h2><p>{html.escape(summary.get('methodology', ''))}</p></section>")

    # 2. Whole-window stage totals per engine
    stage_rows = []
    for engine in engines:
        for stage in STAGES:
            row = stage_fields(engine["stages"][stage])
            stage_rows.append([engine["profile"]["name"], stage] + [row[c] for c in STAGE_COLUMNS])
    sections.append("<section><h2>Five-day totals by engine and stage</h2>" + table(["Engine", "Stage"] + STAGE_COLUMNS, stage_rows) + "</section>")

    # 3. Four-hour timeline
    timeline_rows = []
    for record in records:
        if record["scope"] == "stage":
            timeline_rows.append([f"B{record['bucket']:02d}", record["startUtc"], record["endUtc"], record["engine"], record["stage"],
                                  record["closes"], record["winRatePct"], record["profit"], record["loss"], record["netPnl"], record["cost"], record["profitFactor"],
                                  record["entries"], record["additions"], record["sets"], f"{record['enough']}/{record['sets']} ({record['enoughSamplesPct']}%)", record["qualified"], record["unfinished"]])
    sections.append("<section><h2>Every 4-hour bucket, stage line by stage line</h2>"
                    "<p class=\"note\">Each row is one bucket, one engine and one stage. Coverage columns count the sets alive at the bucket end.</p>"
                    + table(["Bucket", "Start UTC", "End UTC", "Engine", "Stage", "Closes", "Win %", "Profit", "Loss", "Net PnL", "Cost", "PF", "Entries", "Additions", "Sets", "Enough samples", "Qualified", "Unfinished"], timeline_rows) + "</section>")

    # 4. Whole-window dimension breakdowns per engine (groups keys are [stage, dimension, value]).
    for dim, label in [("type", "Indication type"), ("range", "Range"), ("coordination", "Coordination"), ("direction", "Direction"),
                       ("exitMode", "Exit mode"), ("tpStep", "TP step"), ("slRatio", "SL ratio"), ("source", "Source")]:
        rows = []
        for engine in engines:
            for group in engine["groups"]:
                stage, group_dim, value = json.loads(group["key"])
                if group_dim != dim or not group["closes"]:
                    continue
                rows.append([engine["profile"]["name"], stage, value] + [stage_fields(group)[c] for c in STAGE_COLUMNS])
        if rows:
            sections.append(f"<section><h2>{html.escape(label)} breakdown</h2><p class=\"note\">Rows with no closes are omitted here; the text file lists every bucket line.</p>"
                            + table(["Engine", "Stage", label] + STAGE_COLUMNS, rows) + "</section>")

    # 5. Coverage and empty-result diagnostics
    coverage_rows = []
    for engine in engines:
        for group in engine["coverageGroups"]:
            key = json.loads(group["key"])
            if len(key) != 3 or key[1] not in ("coordination", "range", "type", "exitMode"):
                continue
            pct = group.get("enoughSamplesPct")
            coverage_rows.append([engine["profile"]["name"], key[0], key[1], key[2], group["sets"], group["enough"],
                                  f"{pct:.2f}" if pct is not None else "n/a"])
    sections.append("<section><h2>Coverage of created sets</h2><p class=\"note\">Enough-sample percentages divide sets with their own required samples by all created sets. A zero count means no sets were created, not 0%.</p>"
                    + table(["Engine", "Stage", "Dimension", "Value", "Sets", "Enough samples", "Enough %"], coverage_rows) + "</section>")

    body = "".join(sections)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CTS-C five-day simulation report</title>
<style>
:root{{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--line:#d9d9d3;--card:#ffffff;--accent:#2b5c8a}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#16171a;--fg:#ececea;--muted:#9a9a94;--line:#33353b;--card:#1f2024;--accent:#8ab4e0}}}}
:root[data-theme="dark"]{{--bg:#16171a;--fg:#ececea;--muted:#9a9a94;--line:#33353b;--card:#1f2024;--accent:#8ab4e0}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}
main{{padding:16px;max-width:1400px;margin:0 auto}}
h1{{font-size:22px;margin:4px 0 12px}} h2{{font-size:17px;margin:0 0 8px;color:var(--accent)}}
section{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 14px}}
.scroll{{overflow-x:auto;max-height:70vh}} table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{padding:5px 7px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}}
th{{position:sticky;top:0;background:var(--card);color:var(--muted);font-weight:600}}
td:first-child,th:first-child{{text-align:left}}
.note{{color:var(--muted);margin:0 0 8px}}
input{{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);width:min(360px,100%);margin-bottom:10px}}
nav a{{margin-right:12px;color:var(--accent)}}
</style></head>
<body><main>
<h1>CTS-C five-day simulation: 30 symbols, 3 days prehistory, every indication</h1>
<nav><a href="#run">Run</a><a href="#timeline">Four-hour timeline</a></nav>
<p class="note">Generated from summary.json. Paper replays only; nothing was submitted to an exchange. The complete line-by-line list is in results-4h.txt beside this file.</p>
<input id="filter" placeholder="Filter rows, for example Trend-Reversal, exec-branches or B07" aria-label="Filter rows">
<div id="run">{body}</div>
<script>
const box=document.getElementById('filter');
box.addEventListener('input',()=>{{const q=box.value.trim().toLowerCase();for(const row of document.querySelectorAll('tbody tr')){{row.hidden=q!==''&&!row.textContent.toLowerCase().includes(q)}}}});
</script>
</main></body></html>"""


def main():
    if len(sys.argv) != 3:
        print("Usage: render-five-day-report.py <summary.json> <output-directory>", file=sys.stderr)
        return 2
    summary_path = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    records = list(build_records(summary))
    # Keep a stable, bucket-major order: bucket, engine order, then stage lines before group lines.
    engine_order = {engine["profile"]["name"]: index for index, engine in enumerate(summary["summaries"])}
    records.sort(key=lambda r: (r["bucket"], engine_order[r["engine"]], 0 if r["scope"] == "stage" else 1, STAGES.index(r["stage"]) if r["stage"] in STAGES else 9, r["dimension"], str(r["value"])))
    write_text(records, out / "results-4h.txt")
    write_csv(records, out / "results-4h.csv")
    (out / "five-day-report.html").write_text(build_html(summary, records), encoding="utf-8")
    print(json.dumps({"lines": len(records), "text": str(out / "results-4h.txt"), "csv": str(out / "results-4h.csv"), "html": str(out / "five-day-report.html")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
