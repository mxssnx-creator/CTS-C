# BingX Mainnet Live-Verifikation – 18. Juli 2026

## Umfang

Die Verifikation wurde gegen BingX USDT Perpetual Mainnet mit serverseitig injizierten Testzugangsdaten durchgeführt. Zugangsdaten, Kontostände und Exchange-Order-IDs wurden weder in das Repository noch in diesen Bericht übernommen.

- harte Obergrenze je Testposition: 3 USDT Notional
- tatsächlich ausgeführtes Notional: rund 2,02 USDT je Szenario
- Positionsmodus: vor Ausführung gelesen und unverändert verwendet
- Ausgangsinventar: eine vorbestehende Position und eine vorbestehende offene Order
- Marktdaten: zwölf aktive Kontrakte mit Ticker und zehn 1-Minuten-Kerzen
- Account-Stress: fünf Zyklen aus parallelen Balance-, Positions- und Order-Lesezugriffen

## Ausgeführte Szenarien

| Prüfung | LONG | SHORT |
|---|---:|---:|
| isoliertes Symbol ohne vorbestehende Position/Order gewählt | bestanden | bestanden |
| Market-Entry angenommen und Position exchange-seitig verifiziert | bestanden | bestanden |
| nativer `STOP_MARKET` gesetzt und über Order-ID verfolgt | bestanden | bestanden |
| nativer `TAKE_PROFIT_MARKET` gesetzt und über Order-ID verfolgt | bestanden | bestanden |
| frische Connector-Instanz stellt Modus, Position und Schutzorders wieder her | bestanden | bestanden |
| ausschließlich Test-Schutzorders storniert | bestanden | bestanden |
| Reduce-only Market-Close verifiziert | bestanden | bestanden |
| Entry und Close in aktueller Orderhistorie gefunden | bestanden | bestanden |
| Testpositionen nach Abschluss | 0 | 0 |
| Testorders nach Abschluss | 0 | 0 |

Das vorbestehende Positions- und Order-Inventar entsprach unmittelbar nach beiden isolierten Szenarien exakt dem jeweiligen Ausgangszustand. Eine spätere zusätzliche Nur-Lese-Kontrolle bestätigte weiterhin null offene Orders mit dem reservierten `ctsc_`-Testpräfix.

## Während der Verifikation behobene Fehlerklassen

1. Der Rate-Limiter startete trotz `maxConcurrent` bisher nur einen Request zur selben Zeit. Der Scheduler füllt jetzt echte Parallel-Slots und hält weiterhin das konfigurierte Sekunden-/Minutenbudget ein.
2. Temporäre Fehler bei Positions- und Orderinventar wurden teilweise als leere Listen interpretiert. Sicherheitskritische Reads schlagen jetzt geschlossen fehl; eine nicht erreichbare Exchange darf keine lokal verfolgten Live-Positionen als extern geschlossen markieren.
3. BingX lieferte ohne explizites Zeitfenster keine zuverlässig aktuelle Orderhistorie. Die Abfrage fordert nun ausdrücklich das neueste unterstützte Sieben-Tage-Fenster an.
4. Signierte Reads synchronisieren die Serverzeit, wiederholen ausschließlich sichere GET-Abfragen bei temporären Transport-, Timestamp- oder Rate-Limit-Fehlern und geben dauerhafte Fehler an den Aufrufer weiter.
5. Ein Timeout nach einem Order-POST ist mehrdeutig, weil BingX die Order bereits angenommen haben kann. Entry und Schutzorders werden in diesem Fall ausschließlich über ihre eindeutige Client-Order-ID wiedergefunden; ein blindes zweites POST wird vermieden.
6. Connector- und Live-Sync-Zeitbudgets wurden an beobachtete Mainnet-Latenzspitzen angepasst. Gesunde Calls warten dadurch nicht länger, langsame erfolgreiche Antworten bleiben aber verfolgbar.
7. Der alte Route-Smoke löschte den Production-Build und testete einen anderen Port als den gestarteten Dev-Server. Der neue Smoke startet den gebauten Standalone-Server isoliert, authentifiziert sich und prüft sieben Hauptseiten.

## Reproduzierbare Gates

```bash
npm run preflight
```

Der Preflight umfasst Secret-Boundary-Scan, Unit-Tests, TypeScript, ESLint, Production-Build, Auth-/Identitäts-/Snapshot-/Restart-Kontinuität und den authentifizierten Route-Smoke.

Der Mainnet-Test bleibt standardmäßig schreibgeschützt:

```bash
npm run test:bingx:live
```

Die echte Ausführung erfordert zusätzlich `--execute`, gültige serverseitige Umgebungsvariablen und ein explizites `BINGX_TEST_MAX_NOTIONAL` von höchstens 5 USDT. Ein erfolgreicher technischer Test ist keine Aussage über Profitabilität und hebt Markt-, Gebühren-, Liquiditäts- oder Slippage-Risiken nicht auf.
