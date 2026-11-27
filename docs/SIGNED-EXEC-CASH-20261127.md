# CTS-C · Signierte Last-N-Fenster und Cash-PF

27. November 2026

## Stage- und Indikationsänderungen

- Ein geladenes Base-Set verarbeitet seine eigenen Signale weiter, während seine Beobachtungshistorie neu aufgebaut wird oder ihr Probe-Trade noch offen ist. Die Probe dient zur Qualifikation neuer Sets. Wiederholte Signale verwenden die vorhandene Probe direkt.
- Jede gewählte Short- und Last-Polarität behält ihren eigenen Base-Ursprung und ihre eigenen abgeschlossenen Positionen. Bei aktiviertem Long stammt dessen Länge vom zugehörigen Base-Set. Liegen beide jüngeren Blöcke im Minus, braucht der Gesamt-PF ausreichend Gewinn aus Long. Ein fehlender Close hält die betroffene Lane zurück.
- Der Replay prüft alle vier Freigaben zum tatsächlichen Einstieg. Er kontrolliert den exakten Set-Pfad, die Blocklängen, die Polaritäten und den geerbten Long. Er vergleicht anschließend Ausführungszeitpunkte, Preise, Mengen, Gebühren und Cash-P&L sowie Einstiegs- und Aufstockungsfüllungen zwischen Exec und Paper-Live.
- Strategy Lab bietet NR4, NR7 und vier Range-Compression-Varianten für 1, 5, 15 und 30 Minuten. Die Varianten prüfen Ausbruch oder Zurückweisung nach einem 6/18- oder 10/30-Block. Die beiden Volatilitätsblöcke enden vor der bestätigenden Kerze. Die Range-Compression-Varianten verwenden den [Rogers–Satchell-Schätzer](https://skokholm.co.uk/wp-content/uploads/2016/01/R_Satchell_HLOC.pdf).
- Übersicht, Stage-Diagnostik und Replay zeigen den Cash-PF aus den tatsächlich modellierten Positionsgrößen. Bei älteren Checkpoints nennt die Übersicht die Abdeckung, sobald für einen Teil der Abschlüsse Brutto-Cash-Gewinne und -Verluste vorliegen.

## Auswertung

Die ersten zwei Binance-Zeitfenster dienten zur Entwicklung. Zwei weitere Binance-Zeitfenster und ein BingX-VST-Fenster prüften die festgelegten Vergleiche. Jedes Fenster umfasst 48 Stunden Vorlauf und fünf Tage Auswertung über dieselben 20 Symbole. Der erweiterte VST-Lauf ergänzt zehn Symbole im selben Zeitfenster. Insgesamt sind 32 abgeschlossene Läufe dokumentiert. Die Simulationskosten betragen 0,110 % des modellierten Positionswerts je Roundtrip. Sie setzen zwei Taker-Gebühren von je 0,050 % und einen Slippage-Aufschlag von 10 % auf die Gebühren an. Die [Binance-Archivdaten](https://github.com/binance/binance-public-data) enthalten USDⓈ-M-Minutenkerzen.

Ein Eintrag zeigt Abschlüsse / Exec-PF / Cash-PF. Bei null Abschlüssen bleibt der PF ohne Wert.

| Prüfzeitraum | Mit Short± und Last± | Nur positive Short- und Last-Blöcke | Neue Indikationen |
| --- | ---: | ---: | ---: |
| Binance, 17.–22. Oktober | 9 / 1,048 / 0,747 | 1 / 0,000 / 0,000 | 0 / — / — |
| Binance, 24.–29. Oktober | 6 / 0,138 / 0,141 | 2 / 1,144 / 1,144 | 0 / — / — |
| BingX VST, 22.–27. November | 0 / — / — | 0 / — / — | 0 / — / — |
| BingX VST, gleiches Fenster mit 30 Symbolen | 18 / 1,031 / 0,607 | 17 / 1,101 / 0,652 | — |
| 50-Symbol-Archiv, 9.–11. November, 48 h + 48 h | 4 / 2,968 / 3,012 | 1 / 0,000 / 0,000 | 0 / — / — |

Die signierte Referenz verwendet Inverse RSI und Inverse SAR mit DCA. Die 9 Abschlüsse im ersten Binance-Prüfzeitraum entsprechen 7 unterschiedlichen Preisverläufen. Die 18 Abschlüsse im erweiterten VST-Vergleich entsprechen 10 Preisverläufen. Das Portfolio aus sieben bereits vorhandenen Profilen beendete die drei Prüfzeitfenster und den Archivlauf mit 0 Exec-Abschlüssen. NR7 erreichte drei Exec-Abschlüsse in einem Entwicklungsfenster mit PF 0,974 und Cash-PF 0,589. Die dünnere DCA-Größe erreichte einmal 2,252 und 2,018 bei drei Abschlüssen. Ihre Archiv- und VST-Läufe endeten mit 0 Exec-Abschlüssen. Die neuen Indikationen sind in Strategy Lab wählbar. Für eine Default-Freigabe fehlt eine über die Prüffenster bestätigte Verbesserung beider PF-Werte.

### Post-Stage-PF der signierten Referenz

| Prüfzeitraum | Post-Base | Post-Main | Post-Real | Executed |
| --- | ---: | ---: | ---: | ---: |
| Binance, 17.–22. Oktober | 0,747 | 0,887 | 0,857 | 1,048 |
| Binance, 24.–29. Oktober | 0,684 | 0,801 | 0,739 | 0,138 |
| BingX VST, 22.–27. November | 0,790 | 0,864 | 0,805 | — |
| BingX VST mit 30 Symbolen | 0,800 | 0,875 | 0,838 | 1,031 |
| 50-Symbol-Archiv | 0,773 | 1,041 | 1,169 | 2,968 |

Post-Stage-PF zählt jeden abgeschlossenen Eltern-Trade einmal, wenn er mindestens ein Kind eröffnet hat. Executed PF zählt nur die abgeschlossenen Exec-Positionen mit eigener Freigabe. Der Cash-PF teilt positive durch absolute negative Netto-P&L in Kontowährung.

### Negative Fenster und Short bis 30

Im zweiten Entwicklungsfenster schlossen vier Exec-Positionen mit Short− positiv. Die Short−-Gruppe ist damit für einen PF-Vergleich zu klein. Im ersten Binance-Prüfzeitraum gewann die Exec-Last−-Gruppe bei drei Abschlüssen. Im zweiten verlor sie bei zwei Abschlüssen. Die Rollen der signierten Blöcke standen vor der Auswertung fest.

Der gesonderte VST-Breitenvergleich prüfte Real und Exec mit Short 4, 8, 12, 16, 20, 24, 28 und 30, beiden Polaritäten und beiden Long-Modi. Der breite Lauf erzeugte je Exec-Breite 520 Sets. Acht Short-4-Sets hatten zum Schluss vollständige Fenster. Für Short 8 bis 30 fehlten vollständige Fenster. Das vollständige signierte Profil hatte in diesem Vergleich keine Exec-Abschlüsse. Ein Regressionstest mit kontrollierten Kursen erzeugt Short−- und Last−-Freigaben über alle vier Stages und eine Exec-Freigabe mit beiden negativen Blöcken und geerbtem Long.

## Verifikation und Reproduktion

Typprüfung, 365 Anwendungstests, Produktionsbuild, Runtime- und Browser-Smoke bestanden. Die vier Last-N-Kerntests vergleichen die signierten Blöcke mit einem unabhängigen skalaren Rechenweg. Der Kapazitätstest verarbeitete 100.000 Bars bei 500 Symbolen. Die 50-Symbol-Lastprobe verarbeitete 20.000 Bars in 3,27 Sekunden mit 12,82 MiB zusätzlichem gehaltenem V8-Heap nach GC und 23.100 akzeptierten Paper-Abschlüssen. Diese Lastproben messen lokale Verarbeitung. Die historischen Läufe verwenden öffentliche Kurse und erzeugen ausschließlich Paper-Ausführungen.

Der breite Entwicklungsversuch mit vier Workern erreichte in der Testumgebung ein Speicherlimit. Die abgeschlossene Matrix begrenzt den Replay auf ein bis zwei Worker und verwendet getrennte Geometrie- und Breitenläufe.

Das [Replay-Protokoll](../research-data/ctsc-exec-cash-signed-20261127.json) enthält die genauen Szenarien, Datenfenster, Prüfsummen, Post-Stage-Ergebnisse, den Cash-PF und die verwendeten signierten Fenster. Eine Datei pro Symbol enthält die zeitlich sortierten geschlossenen Minutenkerzen. Der Zeitstempel in Millisekunden bezeichnet den Kerzenschluss.

```sh
node -e 'const study=require("./research-data/ctsc-exec-cash-signed-20261127.json"); const run=study.runs[process.argv[1]]; console.log(JSON.stringify({...study.scenarios[run.scenario],tapeMinutes:study.tapes[run.tape].minutes}))' hold-control-15 > /tmp/cts-c-scenario.json
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/cts-c-replay.json short ordinary 20 2 /tmp/cts-c-scenario.json
```
