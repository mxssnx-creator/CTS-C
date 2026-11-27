#!/usr/bin/env python3
"""Render completed replay-exec-stages studies as a standalone German report."""
import argparse
import json
from collections import defaultdict
from datetime import datetime
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Europe/Vienna")
HOUR = 3_600_000
STAGES = ("base", "main", "real", "exec")
COORDINATIONS = ("normal", "axis", "block", "dca", "relate")
TOTAL_FIELDS = ("closes", "wins", "profit", "loss", "cashProfit", "cashLoss", "pnl", "fees")
TRIALS = {
    "dca-base":"DCA über alle Stages",
    "higher-base":"DCA mit Base-PF 1,35",
    "routed-normal":"DCA bis Real · Normal in Exec",
    "routed-block":"DCA bis Real · Block in Exec",
    "light-dca":"DCA mit einer kleineren Aufstockung",
    "activity":"Activity ATR Momentum",
    "exit-modes":"Fünf Exit-Typen",
    "inverse-minimal":"Inverse in Minimal",
}


def number(value, places=3):
    return f"{value:.{places}f}".replace(".", ",")


def pf(row, cash=False):
    if not row or not row["closes"]:
        return "—"
    if cash:
        gain, loss = row["cashProfit"], row["cashLoss"]
    else:
        gain, loss = row["profit"], row["loss"]
    return number(gain / loss) if loss else ("∞" if gain else "1,000")


def count(row):
    return row.get("closes", 0)


def stage_cell(row):
    samples = f"{count(row):,}".replace(",", ".")
    return f"{samples} · {pf(row)} · {pf(row, True)}"


def time_label(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, ZONE).strftime("%d.%m.%Y %H:%M")


def table(headers, rows):
    columns = "".join(f'<th scope="col">{escape(str(label))}</th>' for label in headers)
    body = "".join(
        f"<tr{attrs}>" + "".join(f"<td>{escape(str(value))}</td>" for value in values) + "</tr>"
        for attrs, values in rows
    )
    return f'<div class="table"><table><thead><tr>{columns}</tr></thead><tbody>{body}</tbody></table></div>'


def score(run, stage):
    return run["postStages"][stage]["holdout"]


def sum_row(target, row):
    for key in TOTAL_FIELDS:
        target[key] += row[key]


def score_clock(run):
    tape = run["results"][0]["tape"]
    beginning = tape["firstClose"] + (run["warmupMinutes"] + run["fitMinutes"] - 1) * 60_000
    return beginning, tape["lastClose"]


def run_label(name, run):
    venue = "BingX VST" if "vst" in name or name.startswith("matrix-") else "Binance"
    start, end = score_clock(run)
    period = f"{time_label(start)[:6]}–{time_label(end)[:6]}"
    if name.startswith("control-"):
        return f"Vorlaufvergleich · {venue} · {period}"
    if name.startswith("matrix-"):
        mode = name.removeprefix("matrix-").replace("relate-auto", "Relate Auto")
        return f"Typenmatrix · {mode}"
    if name.startswith("probe-range-grid"):
        return f"Sieben Preisbereiche · {venue} · {period}"
    phase = "Entwicklung" if name.startswith("fit-") else "Prüfung"
    trial = next((label for key,label in TRIALS.items() if name.startswith(("fit-"+key+"-", "check-"+key+"-"))), name)
    return f"{phase} · {trial} · {venue} · {period}"


def hours(run):
    if "hourly" not in run:
        return [], None
    start, end = score_clock(run)
    rows = []
    equity = peak = drawdown = 0.0
    positive, active = 0, 0
    for first in range(start // HOUR * HOUR, end, HOUR):
        cells = [run["hourly"].get(f"{stage}/{first}", {}).get("holdout", {}) for stage in STAGES]
        executed = cells[-1]
        net = executed.get("pnl", 0)
        positive += net > 0
        active += count(executed) > 0
        equity += net
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
        left, right = max(start, first), min(end, first + HOUR)
        rows.append(("", [f"{time_label(left)} – {time_label(right)}",
            *(stage_cell(cell) for cell in cells), number(net, 5), number(equity, 5)]))
    return rows, (positive, active, len(rows), drawdown)


def selected_modes(settings):
    selected = settings.get("catalog", {}).get("strategyStageCoordinations", {})
    globally_enabled = [mode for mode in COORDINATIONS if mode == "normal" or settings.get("coordinations", {}).get(mode, {}).get("enabled") is True]
    return {stage: set(selected.get(stage) or globally_enabled) for stage in STAGES}


def zero_row():
    return dict.fromkeys(TOTAL_FIELDS, 0)


def setup_tables(run):
    if "details" not in run:
        return ""
    settings = run.get("settings") or {}
    modes = selected_modes(settings)
    details = run["details"]
    type_totals = defaultdict(lambda: {stage:zero_row() for stage in STAGES})
    setup_rows, scored_setups = [], []
    for identifier in run["detailCatalog"]:
        family, source, band, step, tp, sl, exit_mode, tf, period, profile = json.loads(identifier)
        for coordination in COORDINATIONS:
            if profile:
                expected = coordination in ("normal", "dca")
            else:
                expected = any(coordination in active for active in modes.values())
            if not expected:
                continue
            stages = {stage:details.get(f"{identifier}/{coordination}/post-{stage}", {}).get("holdout", {}) for stage in STAGES}
            lifetime = {stage:details.get(f"{identifier}/{coordination}/{stage}", {}).get("holdout", {}) for stage in STAGES}
            totals = type_totals[family, coordination]
            for stage, value in stages.items():
                if value:
                    sum_row(totals[stage], value)
            attrs = f' class="config" data-family="{escape(family)}" data-coord="{coordination}"'
            label = [family, source, coordination, band, f"{tf} m / {period}", step or "—", number(tp), number(sl), exit_mode]
            setup_rows.append((attrs, [*label,
                *(stage_cell(lifetime[stage]) for stage in STAGES),
                *(stage_cell(stages[stage]) for stage in STAGES)]))
            final = stages["exec"]
            if count(final) and final["cashLoss"]:
                scored_setups.append((final["cashProfit"] / final["cashLoss"], label[:4], final))
    type_rows = [
        (f' class="config" data-family="{escape(family)}" data-coord="{mode}"',
         [family, mode, *(stage_cell(values[stage]) for stage in STAGES)])
        for (family, mode), values in sorted(type_totals.items())
    ]
    ranked = []
    for caption, order in (("Höchster Cash-PF", sorted(scored_setups, key=lambda row: -row[0])),
                           ("Niedrigster Cash-PF", sorted(scored_setups, key=lambda row: row[0]))):
        for _, labels, metric in order[:3]:
            ranked.append(("", [caption, *labels, count(metric), pf(metric), pf(metric, True), number(metric["pnl"], 5)]))
    return (
        "<h4>Indikation und Koordination</h4>"
        + table(["Indikation","Koordination","Post-Base","Post-Main","Post-Real","Exec-Freigaben"], type_rows)
        + "<h4>Konfigurationen mit endlichem Cash-PF</h4>"
        + (table(["Rang","Indikation","Quelle","Koordination","Range","Exec n","Exec-PF","Cash-PF","Netto"],ranked)
           if ranked else "<p>Es liegen 0 auswertbare Ranglisten-Konfigurationen vor.</p>")
        + "<h4>Alle gewählten Geometrien</h4>"
        + table(["Indikation","Quelle","Koordination","Range","TF / Periode","TP-Stufe","TP %","SL %","Exit",
                 "Base-Buch","Main-Buch","Real-Buch","Exec-Buch","Post-Base","Post-Main","Post-Real","Exec-Freigaben"], setup_rows)
    )


def audit_section(audit_path):
    if not audit_path:
        return ""
    audit = json.loads(audit_path.read_text())
    return (f'<section id="audit"><h2>Base- und Stage-Audit</h2><p>{audit["symbols"]} Symbole · '
            f'{audit["stageTrades"]:,} abgeschlossene Modellpositionen · {audit["failedChecks"]} Abweichungen.</p>'
            + table(["Prüfung","Vergleiche","Abweichungen","Übersprungen","Rundungsgrenze"], [
                ("", [key, row["checked"], row["failed"], row["skipped"], row["edge"]])
                for key, row in sorted(audit["tallies"].items())
            ]) + "</section>")


def render_run(name, run, index):
    start, end = score_clock(run)
    rows, hour_stats = hours(run)
    base, main, real, executed = [score(run, stage) for stage in STAGES]
    success = "—" if not hour_stats else f"{hour_stats[0]}/{hour_stats[2]} ({number(100*hour_stats[0]/hour_stats[2],1)} %)"
    label = run_label(name, run)
    title = f"{label} · {run['symbols']} Symbole"
    overview = ("", [label, run["symbols"], run["warmupMinutes"] // 60,
        stage_cell(base),stage_cell(main),stage_cell(real),stage_cell(executed),run["unique"]["holdout"],success])
    stage_books = table(["Stage","Buchabschlüsse","Forward-Abschlüsse","Forward-PF","Forward-Cash-PF","Gebühren","Netto"], [
        ("", [stage.capitalize(),count(run["stages"][stage]["holdout"]),count(row),pf(row),pf(row,True),
          number(row["fees"],5),number(row["pnl"],5)])
        for stage,row in zip(STAGES,[base,main,real,executed],strict=True)
    ])
    signed = table(["Fenster","Exec-Abschlüsse","Exec-PF","Cash-PF"], [
        ("", [policy,count(row["holdout"]),pf(row["holdout"]),pf(row["holdout"],True)])
        for policy,row in sorted(run["signedWindows"]["executedByAncestor"].items())
        if count(row["holdout"])
    ])
    hourly = (
        f"<h4>Stündliche Ergebnisse</h4><p>{success} profitable Uhrzeit-Segmente. "
        f"{hour_stats[1]} Segmente mit Exec-Abschluss. Maximaler realisierter Rückgang auf Stundenbasis "
        f"{number(hour_stats[3],5)}.</p>"
        + table(["Zeitraum","Post-Base","Post-Main","Post-Real","Exec","Exec netto","Exec kumuliert"],rows)
    ) if hour_stats else "<p>Dieser Vorlaufvergleich enthält zusammengefasste Stage-Daten.</p>"
    limits = run.get("settings") or {}
    reproduced = {
        "tapeMinutes":run["warmupMinutes"]+run["fitMinutes"]+run["holdoutMinutes"],
        "warmupMinutes":run["warmupMinutes"],"fitMinutes":run["fitMinutes"],
        "detailed":"details" in run,"groupSources":"details" not in run,"settings":limits,
    }
    return overview, (
        f'<details class="run" id="run-{index}"><summary>{escape(title)} · {count(executed)} Exec-Abschlüsse</summary>'
        f'<p>{time_label(start)} bis {time_label(end)} · {run["warmupMinutes"] // 60} h Vorlauf · '
        f'{number(run["durationMs"] / 1000,2)} s Rechenzeit · {run["workers"]} Worker</p>'
        + stage_books + "<h4>Freigaben nach Stage und signierten, getrennten Fenstern</h4>" + signed
        + setup_tables(run) + hourly
        + f'<details><summary>Szenario-JSON</summary><p>Replay-ID <code>{escape(name)}</code></p><pre>{escape(json.dumps(reproduced,indent=2))}</pre></details></details>'
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--notes", type=Path, help="Optional JSON list of findings displayed at the top")
    args = parser.parse_args()
    overview, detail = [], []
    families = set()
    for index, path in enumerate(sorted(args.results.glob("*.json"))):
        run = json.loads(path.read_text())
        if "postStages" not in run or "results" not in run:
            continue
        families.update(json.loads(key)[0] for key in run.get("detailCatalog", []))
        row, section = render_run(path.stem, run, index)
        overview.append(row)
        detail.append(section)
    if not detail:
        raise ValueError("No completed replay results")
    notes = json.loads(args.notes.read_text()) if args.notes else []
    findings = "".join(f"<li>{escape(line)}</li>" for line in notes)
    options = lambda items: '<option value="">Alle</option>' + "".join(f'<option>{escape(item)}</option>' for item in items)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text("""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CTS-C · Base- und Exec-Studie</title>
<style>
:root{color-scheme:light;font:16px system-ui,sans-serif;color:#183047;background:#f2f5f8}
body{margin:0}main{max-width:1420px;margin:auto;padding:clamp(12px,3vw,42px)}
header,section{padding:clamp(14px,2.5vw,30px);background:#fff;border:1px solid #dce5ee;border-radius:14px;margin-bottom:18px}
h1{margin:6px 0;font-size:clamp(1.7rem,3vw,2.8rem)}h2,h4{margin:12px 0}p,li{line-height:1.55}
.kicker{color:#0d607d;font-weight:700;letter-spacing:.04em}a{color:#075d86}li+li{margin-top:6px}
.table{overflow:auto;border:1px solid #dce5ee;border-radius:8px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:.85rem}th,td{text-align:left;padding:.5rem .7rem;white-space:nowrap;border-bottom:1px solid #e6edf3}th{background:#e9f0f7}tr:nth-child(even){background:#f7f9fc}
details{padding:.8rem 0;border-top:1px solid #dce5ee}summary{cursor:pointer;font-weight:650}
.controls{display:flex;gap:1rem;flex-wrap:wrap;margin:.6rem 0 1rem}.controls select{font:inherit;padding:.25rem;max-width:100%}
pre{overflow:auto;background:#edf3f8;padding:.8rem;border-radius:8px}code{font-family:ui-monospace,monospace}tr[hidden]{display:none}
</style></head><body><main>
<header><p class="kicker">CTS-C · historische Paper-Replays</p><h1>Base, Vorlauf und Exec-PF</h1>
<p>27. November 2026 · Zeitangaben Europa/Wien · 0 Börsenorders</p>
<p>Stage-Zellen zeigen Abschlüsse · Rendite-PF · Cash-PF. Der Cash-PF basiert auf positionsgewichteter Netto-P&L nach modellierten Kosten. Ein Strich steht für 0 Abschlüsse. Das Unendlich-Zeichen kennzeichnet positive Ergebnisse ohne Verlust.</p>
<ul>""" + findings + """</ul></header>
<section><h2>Übersicht der Läufe</h2>
<p>Kontrolle vergleicht denselben Bewertungszeitraum mit unterschiedlichem Vorlauf. Matrix prüft dieselbe Einstiegsgeometrie je Koordination. Entwicklung und Prüfung werden durch die Laufnamen ausgewiesen.</p>"""
        + table(["Lauf","Symbole","Vorlauf h","Post-Base","Post-Main","Post-Real","Exec","Exec-Preisverläufe","Profitable Stunden"],overview)
        + "</section>" + audit_section(args.audit)
        + '<section><h2>Detailergebnisse</h2><p>Stunden basieren auf abgeschlossenem Cash-P&L der weitergereichten Modellpositionen. Teilstunden am Fensteranfang oder -ende erscheinen mit ihren Datenzeitgrenzen.</p>'
        + f'<div class="controls"><label>Indikation <select id="family">{options(sorted(families))}</select></label>'
        + f'<label>Koordination <select id="coord">{options(COORDINATIONS)}</select></label></div>'
        + "".join(detail) + """</section>
<section><h2>Daten und Kosten</h2><p>Verwendet wurden geschlossene Minutenkerzen von Binance USDⓈ-M und BingX VST. Das Gebührenmodell verwendet 0,110 % des erfassten Positionswerts je Roundtrip. Jede weitergereichte Position zählt pro Stage einmal. Unterschiedliche Set-Pfade können denselben Kursverlauf handeln.</p>
<p><a href="https://github.com/binance/binance-public-data">Binance Public Data</a> · <a href="https://bingx-api.github.io/docs/">BingX API</a></p></section>
<script>
const selectFamily=document.getElementById("family"), selectCoord=document.getElementById("coord");
function applyFilters(){
  document.querySelectorAll("tr.config").forEach(row=>{
    row.hidden=Boolean((selectFamily.value&&row.dataset.family!==selectFamily.value)||
      (selectCoord.value&&row.dataset.coord!==selectCoord.value));
  });
}
selectFamily.addEventListener("change",applyFilters);selectCoord.addEventListener("change",applyFilters);
</script></main></body></html>""",encoding="utf-8")
    print(f"{len(detail)} runs · {len(families)} indication types · {args.output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
