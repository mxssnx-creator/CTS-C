# CTS-C · Frühere Exec-Ergebnisse und Orderauswahl

27. November 2026

## Vergleich mit den früheren Läufen

Die Kursreihen für zwölf Symbole in den beiden öffentlichen November-Fenstern wurden aus der BingX-Historie rekonstruiert. Alle 24 SHA-256-Prüfsummen stimmen mit dem [ursprünglichen Manifest](../research-data/ctsc-exec-profiles-20261122.json) überein. Der damalige Stand `681d114` und der aktuelle Stand `6d078c2` rechneten mit denselben Kosten, Einstiegssignalen, Symbolen und Last-N-Fenstern. Die 50-Symbol-Archivprobe wurde zusätzlich auf diesen beiden Ständen und auf `ccd815b` verglichen.

| BingX-Prüfzeitraum | Post-Base PF | Post-Main PF | Post-Real PF | Exec-Abschlüsse, damals und aktuell | Exec-PF, damals und aktuell | Cash-PF, aktuell |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 8.–15. November, 12 Symbole | 1,281 | 1,687 | 2,310 | 35 | 3,037 | 2,447 |
| 15.–18. November, 12 Symbole | 0,590 | 0,598 | 0,514 | 14 | 1,080 | 0,752 |
| 9.–11. November, 50 Symbole | 0,973 | 1,205 | 1,770 | 0 | — | — |

Die starken Zahlen gehören zur schmalen Trend-/SAR-Konfiguration auf dem Marktfenster vom 8.–15. November. Das zweite November-Fenster hatte bereits damals schwächere Post-Stage-Ergebnisse. Der frühere x02-Lauf vom 18.–22. November benötigte Vorlauf ab dem 8. November. Die erneut abrufbare VST-Historie ließ dort Kerzen aus. Er gehört daher nur zum ursprünglichen Manifest.

Die öffentlichen Läufe verwendeten vor der Bewertung 13 beziehungsweise 20 Tage Kursdaten, einschließlich der vorangehenden Fit-Periode. Mit nur sieben Tagen davor reproduziert das erste Fenster seine 35 Exec-Abschlüsse. Im zweiten entstehen zwölf Abschlüsse bei Exec-PF 0,933 und Cash-PF 0,678. Zehn Tage ergeben im zweiten Fenster dieselben zwölf Abschlüsse. Die paarweise Auswertung hält das bewertete Zeitfenster fest.

## Weniger gleichzeitige Orders

**One funded Exec sibling per signal** bündelt gleichzeitig qualifizierte Geschwister desselben Symbols, derselben Seite, Geometrie und Koordination. Alle Base-, Main-, Real- und Exec-Sets führen ihre eigenen Bücher. Für Live gewinnt das größte vollständige Exec-Fenster. Bei Gleichstand entscheidet die stabile Konfigurations-ID. Die Auswahl verwendet nur die bereits vor dem Einstieg belegten Freigaben. Das ausgewählte Exec-Set liefert die vollständige vierstufige Freigabe an seine Live-Spiegelung.

| Replay | Alle freigegebenen Exec-Abschlüsse | Mit Einzelauswahl | Verschiedene Preisverläufe | Exec-PF vorher → mit Auswahl | Cash-PF vorher → mit Auswahl |
| --- | ---: | ---: | ---: | ---: | ---: |
| Trend + SAR, BingX 8.–15. November | 35 | 32 | 32 | 3,037 → 3,484 | 2,447 → 2,733 |
| Trend + SAR, BingX 15.–18. November | 14 | 13 | 13 | 1,080 → 1,355 | 0,752 → 0,943 |
| Inverse, BingX VST 25.–27. November, 30 Symbole | 59 | 25 | 18 | 1,767 → 1,830 | 1,140 → 1,200 |
| Inverse, Binance 8.–10. Oktober, 30 Symbole | 27 | 16 | 14 | 1,676 → 1,987 | 1,034 → 1,409 |
| Inverse, Binance 18.–20. Oktober, 30 Symbole | 71 | 48 | 48 | 0,951 → 1,123 | 0,642 → 0,741 |

Im VST-Vergleich verringerte eine zusätzliche Exec-Mindestschwelle von 1,50 die Zahl weiter auf 22. Der Cash-PF sank dabei auf 0,977. Das Referenzpreset verwendet die ursprüngliche Schwelle von 1,10. Cash-PF basiert auf den positiven und negativen Nettozahlungen der simulierten Positionen nach Modellkosten. Er lag in zwei der fünf Vergleiche mit Einzelauswahl unter 1. Die Replays erzeugten Paper-Orders.

## Einstellungen und Reproduktion

In Strategy Lab lädt **Prepare Trend + SAR reference** das [gespeicherte Profil](../research-data/exec-trend-sar-reference.json) mit vier Geometrien, zehn Tagen Vorlauf und Einzelauswahl. Gebühren und Budget kommen aus der Verbindung. Der Schalter lässt sich separat abwählen. Die Regression prüft die identischen Exec-Set-Stichproben mit und ohne Auswahl, die vier Freigaben am Einstiegszeitpunkt, genau eine gespiegelte Order je Gruppe und die Fortsetzung nach Neustart.

```sh
node -e 'const study=require("./research-data/ctsc-exec-profiles-20261122.json"); console.log(JSON.stringify(study.cases["enabled-nov"].scenario))' > /tmp/cts-c-trend-sar-original.json
node --import tsx scripts/replay-exec-stages.ts /path/to/original-tapes /tmp/cts-c-original.json short ordinary 12 1 /tmp/cts-c-trend-sar-original.json
node -e 'const scenario=require("/tmp/cts-c-trend-sar-original.json"); scenario.settings.catalog.strategyExecSingleEntry=true; console.log(JSON.stringify(scenario))' > /tmp/cts-c-trend-sar-single-entry.json
node --import tsx scripts/replay-exec-stages.ts /path/to/original-tapes /tmp/cts-c-single-entry.json short ordinary 12 1 /tmp/cts-c-trend-sar-single-entry.json
```
