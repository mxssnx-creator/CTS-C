# CTS-C · RSI, Parabolic SAR, Trend und Breakout

## Signale, Sets und Freigaben

Die Fortsetzungsquellen für RSI und Parabolic SAR liefern ein neues Signal auf einer späteren geschlossenen Kerze, solange dieselbe Richtung bestätigt ist und das Set wieder frei ist. Varianten mit einmaligem Signal bleiben separat auswählbar. Breakout Continuation verlangt einen Schlusskurs jenseits des vorherigen Kanals. Die Fortsetzung endet, wenn das Ausbruchsniveau oder die Trendbestätigung verloren geht oder das Zeitfenster abläuft.

Die neuen Standardprofile ergänzen das konfigurierbare Grid. Die Schalter stehen in Strategy Lab. Jedes Profil verwendet eigene Geometrien und ein eigenes Positionsbuch pro Symbol, Seite, Eltern-Set und Fenster. Jeder Einstieg passiert den PF von Base, Main, Real und Exec. Exec übernimmt nur vollständige Freigaben. Live erhält genau diese Einträge.

| Profil | Varianten auf 1m | TP in Kostenstufen | SL / TP | Fenster |
| --- | --- | ---: | ---: | --- |
| RSI Momentum + DCA | RSI 8, 35/65, Fortsetzung | 18 | 1,20 | Standard |
| RSI Momentum + DCA | RSI 5, 35/65, Momentum | 8 | 1,20 | Standard |
| Parabolic SAR 0.04/0.10 + DCA | SAR AF 0,04, max 0,10, Richtungswechsel | 12 | 0,80 | Standard |
| Trend Efficiency + DCA | Periode 10, Effizienz ab 0,30 | 8 | 0,80 | Signiert |
| Breakout Continuation + DCA | Periode 20, Trendbestätigung und gehaltenes Ausbruchsniveau | 12 | 0,80 | Standard |
| Breakout Retest + DCA | Periode 10, bestätigter Rücktest | 12 | 0,80 | Signiert |

Die Standardfenster haben Base Long 10, Short 4 und Last 1 mit getrennten Last-Vorzeichen. Die signierten Fenster haben Base Long 10 oder 20 und separate Short-/Last-Varianten für beide Vorzeichen. Main und Real verwenden Short 4 und Last 1. Exec verwendet Short 4, 8 oder 12 und Last 1. Ein negativer Block braucht weiterhin einen positiven PF für das vollständige Fenster. Auto PF verwendet je Set bis zu 40 frühere datierte Abschlüsse. Bei weniger als 16 solchen Abschlüssen gilt der Fallback 1,10. DCA fügt bei 0,25 % Gegenbewegung bis zu zweimal je 50 % des Anfangsbudgets hinzu.

Der historische Replay zeigt unter **Exec orders by indication** die Exec-Stichproben, offenen und geschlossenen freigegebenen Positionen und den Netto-PF. Das Live-Modell übernimmt die gleichen Preise, Mengen, Kosten und Ausstiege. Der Historienlauf verarbeitet adaptive Blöcke bis acht Kerzen. Die jeweils aktuelle, ausführbare Kerze bleibt eine einzelne validierte Beobachtung.

## Prüfung mit 20 Symbolen

Verwendet wurden vollständige Minutenkerzen von BingX Perpetual und BingX VST. Die öffentlichen Daten beginnen am 26. Oktober 2026. Die längere x02-Reihe beginnt am 8. November. Ein weiterer x02-Lauf verwendet exakt 48 Stunden Vorhistorie und 48 Stunden Prüfzeit. Die Stichproben enthalten Positionen, die im ausgewiesenen Zeitraum eröffnet und geschlossen wurden. Die Modellkosten betragen 0,110 % pro Roundtrip. Identische Verläufe werden zusätzlich nach Symbol, Richtung, Ein- und Ausstiegszeit und Preisen zusammengefasst. So gewichten parallele Lanes dieselben Marktbewegungen in der Gegenprobe nur einmal.

Die Testmatrix enthält 50 RSI-Einstellungen, 20 Parabolic-SAR-Einstellungen, deren getrennte Fortsetzungsvarianten, Trend- und Breakout-Typen sowie MA, MACD, Bollinger und Tactic-Varianten. Sie prüft mehrere TP-Stufen, SL-Quoten und, getrennt, zwei Sätze von Last-N-Fenstern. Kandidaten aus der Matrix wurden erneut durch den regulären Motor gerechnet. Die Marktfenster wurden für die Auswahl und Verifikation dieser Version verwendet. Das Folgeergebnis eines künftigen Zeitraums bleibt offen.

## Ergebnisse

| Standardprofil | 08.–15.11. BingX | 15.–18.11. BingX | 18.–22.11. BingX | 18.–22.11. x02 | 48+48 h x02 |
| --- | ---: | ---: | ---: | ---: | ---: |
| RSI Momentum + DCA | 1,98 / 28 | 4,88 / 13 | 1,60 / 42 | 2,49 / 34 | – / 0 |
| Breakout Continuation + DCA | 1,26 / 7 | 35,21 / 2 | 1,53 / 16 | 1,56 / 7 | – / 0 |
| Trend Efficiency + DCA | 152,60 / 2 | 4,96 / 3 | 1,44 / 34 | 1,81 / 23 | – / 0 |
| Breakout Retest + DCA | 2,72 / 4 | 1,69 / 10 | 1,03 / 15 | 1,80 / 2 | – / 0 |
| Parabolic SAR 0.04/0.10 + DCA | 1,37 / 8 | 1,04 / 9 | 4,82 / 29 | 15,97 / 5 | – / 0 |

Die Tabelle zeigt den Netto-Exec-PF und alle geschlossenen, freigegebenen Positionen je Set. Auch nach Zusammenfassen identischer Preisverläufe lagen die neuen Profile in den vier längeren Prüfungen über PF 1. Der höchste Trend-Wert beruht auf zwei Abschlüssen. Bei SAR ist das zweite BingX-Fenster mit PF 1,04 knapp. Im kurzen x02-Lauf gab es null freigegebene Abschlüsse.

| x02, 18.–22.11. | Post-Base PF / n | Post-Main PF / n | Post-Real PF / n | Exec PF / n |
| --- | ---: | ---: | ---: | ---: |
| RSI Momentum + DCA | 1,01 / 1167 | 1,05 / 463 | 1,18 / 121 | 2,49 / 34 |
| Breakout Continuation + DCA | 1,30 / 504 | 1,30 / 256 | 1,27 / 55 | 1,56 / 7 |
| Trend Efficiency + DCA | 0,89 / 2586 | 0,86 / 888 | 0,71 / 135 | 1,81 / 23 |
| Breakout Retest + DCA | 0,95 / 967 | 1,06 / 358 | 1,70 / 39 | 1,80 / 2 |
| Parabolic SAR 0.04/0.10 + DCA | 0,93 / 733 | 0,98 / 308 | 0,81 / 81 | 15,97 / 5 |

Die Post-Stage-Zahlen enthalten Positionen, die an die nächste Stufe weitergegeben wurden. Die Fortsetzungsvariante SAR AF 0,02 / max 0,10 blieb als Auswahl verfügbar. Sie lag im x02-Replay bei PF 0,72 über alle Orders und bei 1,12 über eindeutige Preisverläufe. Für das Standardprofil zählt der PF aller freigegebenen Orders. Jeder freigegebene Modellabschluss wurde auf ein identisches Live-Modellresultat geprüft.

## Regression und Reproduktion

Der Regressionstest `tests/exec-indications.test.ts` startet mit leeren Büchern, speichert den beobachteten Warm-up, lädt den Checkpoint neu und testet native RSI-, SAR-, Trend- und Breakout-Signale. Er prüft eindeutige Orderabsichten, die vier zeitgleichen Last-N-Freigaben, identische Exec-/Live-Abschlüsse und unveränderten Zustand bei doppelten Kerzen. Weitere Tests prüfen die unabhängige Wiederherstellung signierter Zweige, das Ende einer Breakout-Fortsetzung und die Indikator-Parität an Historiengrenzen.

Die historischen Replays verwenden `scripts/replay-exec-stages.ts` mit je einer Datei `<SYMBOL>-USDT.json` pro Instrument. Jeder Zeitstempel bezeichnet den Schluss einer beobachteten Ein-Minuten-Kerze. Szenarien, aggregierte Nettoergebnisse und SHA-256 der verwendeten Kursdateien stehen in den [Messdaten](../research-data/ctsc-exec-indications-20261122.json). [BingX Kerzendaten](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-market/SKILL.md)
