# CTS-C · Last-N, Auto PF und Exec

## Prüfung der Stufen

- Base prüft die eigenen abgeschlossenen Renditen je Geometrie, Symbol, Richtung und Koordination. Long, Short und Last belegen getrennte chronologische Blöcke. Es zählen ausschließlich frühere Abschlüsse.
- Main, Real und Exec beginnen mit leeren eigenen Büchern. Jedes gültige Eltern-Set kann für jede eingestellte Fensterkombination ein eigenes Kind je aktivierter Koordination eröffnen. Ohne Auswahl von Kind-Koordinationen laufen alle aktivierten Koordinationen. Ein geerbter Long-Block verwendet die Breite des ursprünglichen Base-Sets.
- Jede Stufe verlangt alle Samples und ihren eigenen Mindest-PF. Die gezielt verschlechterte Rendite eines einzelnen Buchs stoppt genau den folgenden Übergang. Der Kombinatoriktest prüft 1.250 Exec-Pfade aus fünf Koordinationen an vier Stufen und zwei Exec-Short-Breiten.
- Auto PF liest je Set bis zu 40 ältere, datierte Abschlüsse außerhalb des Gate-Fensters. Bis zum 16. solchen Abschluss gilt der Fallback 1,10 zusammen mit dem Mindest-PF der Stufe. Relate prüft damit auch seine eigene Volumenerhöhung.
- Live spiegelt den freigegebenen Exec-Einstieg direkt. Nach einem Neustart prüft der Executor die vollständige Zulassung mit Set-IDs, Entscheidungszeit, Fenstergröße und PF vor einem neuen Auftrag. Offene Positionen behalten die bei Eröffnung gespeicherten Konditionen bis zum Abschluss.
- Post-Stage-PF zählt die Quellpositionen, die tatsächlich Folgepositionen eröffnet haben. Eine Quellposition zählt einmal, auch wenn sie mehrere Kind-Sets eröffnet. Gewinne und Verluste zählen beim Schließen. Die Erfassung beginnt mit dem gespeicherten Übergangsnachweis. Post-Exec-PF entspricht dem PF der freigegebenen, abgeschlossenen Exec-Positionen. Diese Zahlen stehen in der Stufendiagnose und im Replay.

## Gemessene Ergebnisse

Die Replays verwenden geschlossene 1-Minuten-Kerzen. Gebühren und modellierte Slippage ergeben 0,110 % je eingestiegenem Notional. PF ist die Summe positiver abgeschlossener Nettorenditen geteilt durch den Betrag negativer Nettorenditen. Bei einem leeren Buch steht ein Strich. Identische Preisverläufe werden zusätzlich anhand von Symbol, Richtung, Ein- und Ausstiegszeit und -preis gruppiert. Der PF dieser Gruppen verwendet je Preisverlauf den Mittelwert der Nettorenditen.

| Szenario | Symbole | Post-Base PF / Abschlüsse | Post-Main | Post-Real | Post-Exec | Eigene Preisverläufe / PF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| x02, alle fünf Koordinationen, Trend | 6 | 1,296 / 436 | 1,055 / 713 | 0,831 / 384 | 1,440 / 292 | 38 / 2,860 |
| x02, DCA mit gemischten Indikationen | 6 | 0,822 / 9.554 | 0,973 / 3.105 | 0,965 / 524 | 2,835 / 73 | 36 / 1,993 |
| x02, Trend + DCA mit Exec Short 4/8/12 | 6 | 1,404 / 309 | 1,704 / 150 | 1,674 / 46 | 3,933 / 40 | 16 / 4,230 |
| Öffentliche BingX-Kerzen, gleicher Trend + DCA-Entwurf, anderer Zeitraum | 12 | 1,234 / 743 | 1,507 / 303 | 2,257 / 77 | 1,574 / 17 | 14 / 1,634 |
| x02, gleicher Entwurf, 48 h Vorhistorie + 48 h Auswertung | 50 | 0,770 / 447 | 0,720 / 112 | 0,000 / 1 | — / 0 | 0 / — |

Der [Trend+DCA-Entwurf](../research-data/exec-dca-trend-preset.json) ist im Strategy Lab auswählbar und als JSON importierbar. Er verwendet Trend auf 1 Minute mit Periode 10, Range Short, TP 12 Kostenstufen, SL 1,2 × TP sowie bis zu zwei DCA-Ergänzungen nach jeweils 0,25 % Gegenbewegung mit jeweils 50 % der Ausgangsgröße. Die zehn Tage Vorhistorie entsprechen der Gesamtdauer vor dem x02-Prüffeld. Die Einstellungen lassen jetzt bis zu 20.160 Minuten zu. Der Warm-up liest ab der ältesten benötigten Minute in begrenzten, fortsetzbaren Abschnitten.

Das x02-Prüffeld war 18.–22. November UTC und folgte sieben Tagen Vorhistorie sowie drei Tagen Kalibrierung. Die 40 Abschlüsse des Entwurfs kamen von NEAR-USDT. Die zeitlich getrennte Gegenprobe nutzte öffentliche Marktkerzen vom 8.–15. November UTC mit Formationen auf AAVE, ADA, BCH und NEAR. Ihre Vorhistorie begann am 26. Oktober. Der 50-Symbole-Lauf bewertete 9.–11. November UTC nach weiteren 48 Stunden Vorhistorie. Er erreichte die Exec-Mindeststichprobe in keinem Set. Das Preset bleibt ein Replay-Entwurf mit begrenzter Evidenz. Eine belastbare Live-Strategie-PF-Messung steht aus.

## Exec Short bis 30

Die folgende Tabelle verwendet den gemischten DCA-Lauf im x02-Prüffeld. Jede Breite hatte 876 eigene Exec-Sets. Set-Reife wird am Ende des Zeitraums gezählt. Short 30 benötigt bei Last 1 insgesamt 31 Abschlüsse. Ein geerbter Base-Long-Block von 10 erhöht den Bedarf auf 41.

| Exec Short | Sets mit vollem Fenster | Freigegebene Abschlüsse / verschiedene Preisverläufe | Exec-PF |
| ---: | ---: | ---: | ---: |
| 4 | 72 | 34 / 34 | 1,690 |
| 8 | 12 | 18 / 18 | 2,526 |
| 12 | 4 | 11 / 11 | 4,518 |
| 16 | 2 | 7 / 7 | 8,875 |
| 20 | 2 | 3 / 3 | 48,101 |
| 24 | 0 | 0 / 0 | — |
| 28 | 0 | 0 / 0 | — |
| 30 | 0 | 0 / 0 | — |

Short 20 hatte drei Abschlüsse und ist für eine Voreinstellung zu dünn belegt. In der zeitlich getrennten Prüfung qualifizierten sich Short 4 und 8. Das Preset enthält auch Short 12 als wählbare Lane, die im x02-Prüffeld elf Abschlüsse ergab. Alle acht getesteten Breiten sind in den Exec-Einstellungen verfügbar.

## Auto-PF-Default im Trend+DCA-Entwurf

| Einstellung | x02-PF / Abschlüsse | PF der öffentlichen Gegenprobe / Abschlüsse |
| --- | ---: | ---: |
| Set-History, Fallback 1,05 | 3,313 / 42 | 1,574 / 17 |
| Set-History, Fallback 1,10 | 3,933 / 40 | 1,574 / 17 |
| Set-History, Fallback 1,20 | 3,080 / 34 | 0,624 / 9 |
| Set-History, Fallback 1,10 und Exec-Mindest-PF 1,35 | 3,856 / 38 | 1,375 / 14 |
| Statischer PF 1,10 an jeder Stufe | 3,345 / 41 | 2,042 / 21 |

Der Entwurf verwendet die getrennte Set-History mit 1,10. Sie lieferte im späteren x02-Fenster den höchsten PF dieser Auswahl und blieb in der früheren Gegenprobe über 1. Die frühere Gegenprobe favorisierte den statischen PF. Beide Prüfzeiten haben begrenzte Stichproben.

## Koordinationen und Taktiken

| x02-Vergleich im selben Prüffeld | Exec-Buch: abgeschlossene Positionen / PF | Freigegebene Abschlüsse / PF |
| --- | ---: | ---: |
| Normal | 512 / 0,598 | 0 / — |
| Axis mit Base-Referenz | 544 / 0,520 | 0 / — |
| Axis mit Referenz in derselben Stufe | 0 / — | 0 / — |
| Block Pyramid | 224 / 0,307 | 0 / — |
| Block Rounds | 0 / — | 0 / — |
| DCA, feste Ergänzungen | 8.384 / 0,965 | 73 / 2,835 |
| DCA, Auto-Schrittprüfung | 1.504 / 0,757 | 2 / 1,292 |
| Relate mit Auto PF | 1.024 / 0,598 | 0 / — |
| Geerbter Base Long ab Main | 0 / — | 0 / — |
| Statischer PF 1,10 | 1.376 / 0,780 | 0 / — |
| Mindest-PF in Exec 1,35 | 512 / 0,598 | 0 / — |
| Axis → Block → DCA/Relate | 2.112 / 1,176 | 0 / — |

Im gemischten DCA-Lauf lieferte Trend 53 Abschlüsse mit PF 3,690, RSI-Reclaim 5 / 25–75 zwölf mit PF 1,141 und Bollinger Bounce acht mit PF 0,880. Die mitlaufenden SAR-, RSI-Momentum-, Low-Range-, Mean-Reversion- und Quarter-hour-Konfigurationen hatten keine freigegebenen Abschlüsse. Ein separater Entwicklungsscan prüfte Momentum, einfache Umkehr, bestätigte Umkehr und Kerzenumkehr mit 1–60 Minuten Rückblick, Volumenfilter und unterschiedlichen Haltezeiten. Der aktivste vorselektierte Pfad hatte acht Abschlüsse.

Der getrennte CTS-G-Vergleich erreichte mit Short 20–30 in einem 16-Symbole-Fenster PF 0,701 bei 258 Abschlüssen, danach PF 0,557 bei 108. Isolierte SAR-Trend- und RSI-5-Varianten lagen in den späteren CTS-G-Fenstern ebenfalls unter 1. [CTS-G-Stand zum Vergleich](https://github.com/mxssnx-creator/CTS-G/tree/ac32c20ca2404bfb2bd788f19565a61fe72a8d43)

## x02 und Lasttest

- Der Marktdatenpfad verarbeitete die maximale Konfiguration von 500 Symbolen mit 50.000 verifizierten, lückenlosen Minuten in rund 40,5 s inklusive Download. Alle fünf Koordinationen waren verfügbar. Der Lauf endete bei rund 75 MiB Heap im Prozess. Dieses kurze Fenster lieferte noch keine vollständigen Stufen-Sets.
- Ein deterministischer 500-Symbole-Lauf mit einer Geometrie verarbeitete 47.500 Kerzen in 2,1 s mit rund 196 MiB Heap am Ende. Die 6.000 freigegebenen Exec-Abschlüsse und Live-Paper-Abschlüsse stimmten in Anzahl überein. Die Markt-Replays prüfen für jeden freigegebenen Exec-Abschluss auch Preis, Zeit, Menge, Kosten und Rendite der Paper-Spiegelung.
- Der getrennte x02-Börsentest auf XRP-USDT eröffnete je Richtung 6 Einheiten, ergänzte 3 und schloss 9. Der Executor bestätigte insgesamt 14 Aufträge einschließlich Schutzorders, 6 Fills und null offene oder partielle Orders am Ende. Börsen-Brutto-PnL −0,006 VST, Gebühren 0,016706 VST, Netto −0,022706 VST. Auf denselben Fills ergibt die simulierte Kostenpauschale rund 0,018378 VST inklusive Slippage. Kontostand- und Inventarprüfung liefen über x02. Diese zwei manuellen Diagnosetrades zählen außerhalb der Strategie-PF-Auswertung.
- Die Dispatch-Schleife ist auf 250 ms eingestellt. Die zwölf gemessenen Zyklen des nativen Diagnosetests ergaben rund 5,35 s p95 inklusive Venue-Aufrufen und Abgleich. Dies misst den kompletten Venue-Zyklus. Eine Ende-zu-Ende-Grenze von 250 ms ist damit offen.

## Reproduktion

Das [Manifest](../research-data/ctsc-exec-stage-audit-20261122.json) enthält alle Szenarien, getrennte Fit- und Holdout-Werte, Set-Reife je Short-Breite, die Kerzenzeiten und SHA-256 je Symbol. Tape-Dateien werden als `<SYMBOL>-USDT.json` mit UTC-Schlusszeit in Millisekunden erwartet. Die Daten wurden in chronologischen Abschnitten von bis zu 4.320 Minuten mit `closedHistory` und `validateHistory` gelesen.

```sh
jq '.scenarios["preset-vst"]' research-data/ctsc-exec-stage-audit-20261122.json > /tmp/ctsc-exec-preset.json
node --import tsx scripts/replay-exec-stages.ts /path/to/tapes /tmp/ctsc-exec-results.json short ordinary 6 1 /tmp/ctsc-exec-preset.json
```

- [BingX-Marktdaten und Klines](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/SKILL.md)
- [Bailey et al. zur Überanpassung in Backtests](https://escholarship.org/uc/item/4w1110bb)
- [Shen et al. zu Intraday-Momentum, Volumen und Volatilität](https://doi.org/10.1111/fire.12290)
