# CTS-C · Base-Koordinationen und längerer Vorlauf

27. November 2026

Neue Verbindungen rechnen mit sieben Tagen geschlossener Minutenkerzen vor. Einstellungen und x01- und x02-Launcher verwenden dieselben Grenzen von 100 bis 20.160 Kerzen. Die History-Planung verarbeitet die älteste angeforderte Seite zuerst. Die Seite ist auf 4.320 Minuten begrenzt. Ein vorhandener Cursor holt die fehlenden Minuten in zeitlicher Reihenfolge nach.

Strategy Lab kann die Koordination am Base-Ursprung auswählen. Eine leere Auswahl verwendet alle aktivierten Koordinationen. Axis kann die Normal-Beobachtung als Referenz verwenden. Diese Referenz eröffnet bei einem ausgeschlossenen Normal-Ursprung keine Base-Sets und zählt nicht zu den ausgewählten Base-Kandidaten. Das Ändern der Base-Auswahl beendet die weitere Zulassung über ausgeschlossene Pfade. Bereits laufende Positionen behalten ihre erfasste Ausstiegslogik. Relate Auto beendet die Übernahme älterer Stichproben an einem DCA- oder Block-Vorfahren, da Aufstockungen dort die Renditebasis ändern können.

## Vergleich des Vorlaufs

30 identische Symbole je Fenster. Jedes Ergebnis umfasst 48 Stunden Bewertung nach dem angegebenen Vorlauf. Die Vergleichsgeometrie verwendet Inverse RSI und Inverse SAR mit DCA. Die Spalten zeigen Exec-Abschlüsse / Exec-PF / Cash-PF. Das Modell verwendet 0,110 % Roundtrip-Kosten.

| Bewertungsfenster | 2 Tage Vorlauf | 5 Tage Vorlauf | 7 Tage Vorlauf |
| --- | ---: | ---: | ---: |
| Binance, 8.–10. Oktober | 5 / 1,115 / 0,558 | 9 / 1,142 / 0,596 | 27 / 1,676 / 1,034 |
| Binance, 18.–20. Oktober | 4 / 0,228 / 0,125 | 49 / 1,245 / 0,835 | 71 / 0,951 / 0,642 |
| Binance, 28.–30. Oktober | 0 / — / — | 0 / — / — | 0 / — / — |
| BingX VST, 25.–27. November | 11 / 0,980 / 0,630 | 17 / 1,101 / 0,652 | 59 / 1,767 / 1,140 |
| Gemeinsame Bruttosummen | **20 / 0,903 / 0,542** | **75 / 1,168 / 0,714** | **157 / 1,452 / 0,951** |

Der Vorlauf verbreitert vor allem die späteren Stage-Stichproben. Innerhalb jedes Fensters blieb der Post-Base-PF bei dieser Geometrie gleich. Eine auf DCA beschränkte Base verbesserte im VST-Fenster den Post-Base-Rendite-PF von 0,838 auf 0,917 bei weiterhin 59 Exec-Abschlüssen. Der Post-Base-Cash-PF lag bei 0,618 und der Exec-Cash-PF bei 1,140. Die Endergebnisse variierten über die Prüffenster. Inverse in Minimal erreichte im zusätzlichen Binance-Prüffenster 58 Abschlüsse mit Exec-PF 0,763 und Cash-PF 0,535. Activity schloss auf dem jüngsten VST-Fenster einmal mit Verlust. Diese Trefferquote trägt keine neue Profil-Voreinstellung.

## Base-Audit und Reproduktion

Die unabhängige skalare Prüfung prüfte zehn Symbole mit 168 Stunden Vorlauf. Sie rekonstruierte 45.444 Base-Freigaben zum Einstiegszeitpunkt sowie die Stichproben und Freigaben der späteren Stages. Unter 250.131 beobachteten Abschlüssen ergaben sich null Abweichungen. Die signierten Last-N-Blöcke und die DCA- oder Block-Stichproben bleiben an ihren jeweiligen Set-Pfad gebunden.

Ein lokaler A/B-Lasttest mit 20.000 Bars, 50 Symbolen und je drei Wiederholungen maß im Median 2,22 s vor und 1,88 s nach der Änderung. Der zusätzlich gehaltene Heap nach GC sank im Median von 12,82 auf 12,16 MiB. Beide Stände erzeugten je Wiederholung 23.100 akzeptierte Paper-Abschlüsse. Base kopiert unveränderliche Stichproben nur beim Kürzen. Die Präfixsummen der Base-Beobachtung entstehen erst, wenn sie für einen noch fehlenden Set-Pfad benötigt werden.

Aktiviere `detailed: true` im Replay-Szenario für stündliche Cash-Summen und Konfigurationsbücher. Für reine Ergebnisaggregation bleibt diese Erfassung ausgeschaltet. Der HTML-Renderer verwendet den Ausgabeordner der abgeschlossenen Läufe.

```sh
node --import tsx scripts/replay-exec-stages.ts TAPES results/run.json short ordinary 30 1 scenario.json
node --import tsx scripts/audit-stage-gates.ts TAPES audit.json scenario.json 10 all
python3 scripts/render-base-warmup-report.py results CTS-C-Warmup.html --audit audit.json
```
