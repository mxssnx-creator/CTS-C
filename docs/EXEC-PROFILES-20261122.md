# CTS-C · Exec-Profile und Validierung

## Standardprofile

Trend + DCA und Parabolic SAR + DCA sind in der Exec-Progression standardmäßig aktiv. Sie ergänzen das konfigurierbare Strategie-Grid um drei Geometrien. Trend nutzt Periode 10. Parabolic SAR verwendet zwei getrennte Quellen mit den IDs `parabolic-sar-0.01-0.15` und `sar-fast`. Beide Profile verwenden geschlossene Ein-Minuten-Kerzen, Range Short, TP 12 Kostenstufen, SL 1,2 × TP und einen festen Exit.

| Stufe | Long | Short | Last | Koordination |
| --- | ---: | --- | --- | --- |
| Base | 10 | 4 | 1 positiv und 1 negativ, unabhängig | Normal und DCA |
| Main | – | 4 | 1 positiv und 1 negativ, unabhängig | DCA |
| Real | – | 4 | 1 positiv und 1 negativ, unabhängig | DCA |
| Exec | – | 4, 8, 12 | 1 positiv und 1 negativ, unabhängig | DCA |

Ein Kind-Set erhält nur einen Einstieg seines eigenen qualifizierten Eltern-Sets. Ausschlaggebend ist der PF des vollständigen eigenen Fensters mit getrennten Long-, Short- und Last-Blöcken. Auto PF verwendet bis zu 40 ältere datierte Abschlüsse je Set. Bis zum 16. verwertbaren älteren Abschluss gilt der Fallback 1,10. Die konfigurierten Stufen-Mindestwerte gehen zusätzlich als Untergrenze ein. Die Profile fügen bei jeweils 0,25 % Gegenbewegung höchstens zweimal je 50 % des jeweiligen Anfangsbudgets hinzu. Gebühren, Volumenfaktoren und Orderlimits kommen aus der Verbindung.

Exec übergibt akzeptierte Einstiege direkt an Live. Der Auftrag behält die vollständige Kette aus vier zeitgleichen Freigaben. Die Stufendiagnose zeigt den Post-Stage-PF und den Executed PF je Profil. Unter Strategy Lab lassen sich beide Profile einzeln abschalten. Der globale DCA-Schalter gilt auch für sie. Vorhandene Positionen können mit ihren gespeicherten Exits schließen. Explizit gespeicherte Profil-Schalter werden beim Neustart übernommen.

## Historische Prüfung

Jede Zeile enthält freigegebene und im angegebenen Prüfzeitraum geschlossene Modellpositionen. Gezählt werden sämtliche Nettogewinne und Nettoverluste bei 0,110 % modellierten Round-Trip-Kosten. Die Preisverlauf-Deduplizierung gruppiert zusätzlich nach Symbol, Richtung, Zeit und Preis von Ein- und Ausstieg. Sie verwendet pro Gruppe die mittlere Nettorendite. Das Auswertungsergebnis setzt keine Aufträge ab.

| Quelle und Prüfzeitraum (UTC) | Symbole | Trend PF / Abschlüsse | SAR PF / Abschlüsse | Zusammen PF / Abschlüsse | Preisverläufe / PF |
| --- | ---: | ---: | ---: | ---: | ---: |
| BingX öffentlich, 8.–15.11. | 12 | 1,574 / 17 | 8,248 / 18 | 3,037 / 35 | 32 / 3,484 |
| BingX öffentlich, 15.–18.11. | 12 | – / 0 | 1,080 / 14 | 1,080 / 14 | 13 / 1,355 |
| x02 VST, 18.–22.11. | 6 | 3,933 / 40 | 1,901 / 14 | 3,309 / 54 | 26 / 3,328 |
| x02 VST, 48 h Vorhistorie und 48 h Prüfung, 9.–11.11. | 50 | – / 0 | – / 0 | – / 0 | 0 / – |

Die beiden öffentlichen Prüfungen beginnen mit Daten ab dem 26. Oktober. Das x02-Fenster vom 18. November beginnt mit Daten ab dem 8. November. Trend ist im jüngsten Fenster auf NEAR-USDT konzentriert. Die SAR-Stichproben umfassen zwei bis fünf verschiedene Symbole je Fenster. Die positive SAR-Gegenprobe vom 15. November ist mit PF 1,08 knapp. Im 50-Symbole-Replay kamen beide Profile bis Real. Die gemischte Referenzkonfiguration hatte 18 weitergegebene Real-Abschlüsse und keinen freigegebenen Exec-Abschluss. Ein Live-Strategie-PF wurde in dieser Prüfung nicht gemessen.

| Beide Profile plus Kontrollstrategie | Post-Base PF | Post-Main PF | Post-Real PF | Post-Exec PF |
| --- | ---: | ---: | ---: | ---: |
| BingX 8.–15.11. | 1,281 | 1,687 | 2,310 | 3,037 |
| BingX 15.–18.11. | 0,590 | 0,598 | 0,514 | 1,080 |
| x02 18.–22.11. | 1,006 | 1,357 | 1,520 | 3,309 |
| x02 48+48 h | 0,973 | 1,205 | 1,770 | – |

## Weitere Strategien

| Geprüftes Setup | PF / Anzahl, 8.–15.11. | PF / Anzahl, 15.–18.11. |
| --- | ---: | ---: |
| Normal | – / 0 | – / 0 |
| Axis, Base-Referenz | – / 0 | – / 0 |
| Axis, Stufenreferenz | – / 0 | – / 0 |
| Block Pyramid | – / 0 | – / 0 |
| Block Rounds | – / 0 | – / 0 |
| Relate | – / 0 | – / 0 |
| DCA Auto | – / 0 | – / 0 |
| Acht Kernindikationen | 0,705 / 6 | 0,711 / 10 |
| Weitere Trend-Typen | 0,981 / 12 | 0,031 / 2 |
| Break-Typen | 0,721 / 4 | 0,678 / 9 |
| RSI und Parabolic SAR gemischt | 3,561 / 22 | 0,779 / 16 |
| Tactic und Inverse | 1,830 / 20 | 0,539 / 12 |
| Signals | 0,000 / 1 | 0,000 / 3 |
| Low-Range | 0,254 / 5 | – / 0 |
| Vier Trailing-Typen | – / 0 | – / 0 |
| DCA Trend in anderen Ranges | – / 0 | 6,941 / 5 |

Zusätzliche x02-Gegenproben ergaben null Abschlüsse für MACD + RSI-Momentum und Trend-Tactic. Trend ADX erreichte PF 0,916 bei 21 Abschlüssen. Parabolic SAR eigenständig war in allen drei Phasen positiv. Die Auswahl zusätzlicher Standardprofile berücksichtigt getrennte Prüfzeiträume und eigene Stichproben. Bei vielen getesteten Varianten kann ein hoher PF in einem einzelnen Fenster zufällig entstehen. [Bailey et al., The Probability of Backtest Overfitting](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2326253)

## Speicher, Laufzeit und Regression

Identische Gebühren-Kataloge teilen jetzt die Routing-Daten. Preisverlauf, Indikatorzustand, Set-Samples und Positionsbuch bleiben nach Symbol und Set getrennt. Ohne Signal entfällt die Suche über sämtliche Geometrien. Die Speicherwerte messen zusätzlich belegten V8-Heap nach Garbage Collection. Die Zeitwerte sind der Median aus drei abwechselnden Läufen auf derselben Umgebung.

| 500 Symbole, 252 Geometrien, 100.000 synthetische Kerzen | Vorher | Danach |
| --- | ---: | ---: |
| Katalogaufbau | 131 ms | 11 ms |
| Heap direkt nach Aufbau | 13,99 MiB | 0,72 MiB |
| Kerzenverarbeitung | 1.379 ms | 655 ms |
| Heap nach Verarbeitung | 16,75 MiB | 3,45 MiB |

Mit beiden Profilen, 50 Symbolen und 20.000 synthetischen Kerzen verarbeitete der Motor 23.100 freigegebene Abschlüsse mit exakt gleicher Exec/Live-Anzahl. Der Lauf dauerte rund 2,9 s bei 12,9 MiB zusätzlichem Heap. Die Voll- und Regressionstests prüfen Positiv- und Negativfenster, Stufen-PF, Identität und Reihenfolge der Sets, Neustart, Gebühren, Long und Short, 50-%-Adds und Profileinstellungen. Beide Lastfälle laufen auch in der GitHub-Prüfung.

## Reproduzieren

Alle 44 Fälle verfügen über ihre vollständige Konfiguration, die Zeitgrenzen, die SHA-256 je Tape, Stufen-PF, Abschlüsse und deduplizierte Ergebnisse. [Messdaten und Szenarien](../research-data/ctsc-exec-profiles-20261122.json)

```sh
jq '.cases["enabled-vst"].scenario' research-data/ctsc-exec-profiles-20261122.json > /tmp/cts-exec-profiles.json
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/cts-exec-profiles-result.json short ordinary 6 1 /tmp/cts-exec-profiles.json
npm run test:exec-performance
npm run check
```

Die Tape-Dateien enthalten geschlossene Kerzen als `<SYMBOL>-USDT.json`. Die genaue Schlusszeit in Millisekunden steht im Datensatz. [BingX-Kerzendaten](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/SKILL.md)
