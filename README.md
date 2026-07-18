# CTS-C Dashboard 4.0

CTS-C ist ein vollständiges Next.js-Dashboard für unabhängige Exchange-Verbindungen, historische und Echtzeit-Indikationen, Base/Main/Real-Progression, Live-Ausführung, Monitoring, Backups und Administration.

Der Referenzbetrieb ist bewusst eine einzelne, langlebige Node-/Docker-Instanz. Das passt zur Engine-Architektur: Timer, Locks, fortlaufende Progression und der schnelle In-Memory-Datensatz bleiben in genau einem Prozess; ein atomarer Snapshot auf einem Docker-Volume sorgt für Neustartkontinuität. Serverless-Funktionen mit wechselnden Instanzen sind für den kontinuierlichen Trade-Engine-Betrieb nicht geeignet.

## Sicherheitsmodell

- Alle Dashboard-APIs außer Auth- und Health-Endpunkten benötigen ein signiertes HttpOnly-Session-Cookie.
- Jede Anmeldung erzeugt eine widerrufbare Serversitzung mit eigener Session-ID und bindet sie an die dauerhafte Site-ID.
- Die Site-ID bleibt über Neustarts bestehen; jede Prozessinstanz besitzt zusätzlich eine eigene Runtime-ID und einen Heartbeat.
- Selbstregistrierung ist im Produktionsprofil deaktiviert.
- Admin-Autologin ist für den gewünschten privaten Einzelbenutzerbetrieb implementiert. Compose bindet deshalb standardmäßig ausschließlich an `127.0.0.1`. Vor einer öffentlichen Freigabe muss davor ein authentifizierender Reverse Proxy oder ein VPN stehen; alternativ `ADMIN_AUTOLOGIN_ENABLED=false` setzen.
- Exchange-Zugangsdaten werden ausschließlich serverseitig aus Umgebungsvariablen oder dem Laufzeitspeicher gelesen. `NEXT_PUBLIC_*`-Secret-Aliase werden nicht akzeptiert.
- Verwende Exchange-Keys ohne Auszahlungsrecht, mit IP-Allowlist und ausschließlich den erforderlichen Handelsrechten.

## Produktionsstart

Voraussetzungen: Docker mit Compose-Plugin und mindestens 5 GB verfügbarer Arbeitsspeicher.

```bash
cp .env.example .env
openssl rand -base64 48
openssl rand -base64 48
```

Die beiden generierten Werte in `.env` als `JWT_SECRET` und `CRON_SECRET` eintragen. Danach bei Bedarf die BingX-Schlüssel hinzufügen und starten:

```bash
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:3001/api/health/readiness
```

Das Dashboard ist unter `http://127.0.0.1:3001` erreichbar. Für einen Reverse Proxy `CTS_BIND_ADDRESS` und `CTS_TRUSTED_ORIGINS` ausdrücklich auf die Zielumgebung abstimmen.

## Lokale Entwicklung

```bash
npm ci
npm run dev
```

Ohne gesetztes `JWT_SECRET` verwendet ausschließlich der Entwicklungsmodus einen nicht produktionsfähigen lokalen Schlüssel. Die Engine initialisiert nur nach einer erfolgreichen Authentifizierung.

## Staging- und Progressionslogik

| Stufe | Zweck | Persistenz | Exchange-Aktion |
|---|---|---|---|
| Prehistory | Warm-up aus historischen Kerzen | Fortschritt je Verbindung/Symbol/Set | keine |
| Realtime | Lückenloser Übergang zu Live-Marktdaten | Cursor und letzter Zeitstempel | keine |
| Base | unabhängige Pseudo-Positionen je Konfigurations-Set und Richtung | vollständige Position/Statistik | keine |
| Main | aus Base qualifizierte Strategie-Sets | Set- und Positionshistorie | keine |
| Real | qualifizierte reale Kandidaten und Schutzparameter | Audit, Kandidat, Größenberechnung | keine |
| Live | native Exchange-Ausführung | Order-, Fill-, SL/TP- und Close-Audit | echte Order |

Base, Main und Real bleiben konfigurations-, symbol- und richtungsunabhängig. Es gibt keinen künstlichen globalen Positionsdeckel; `max_open_positions=0` bedeutet unbegrenzt. Explizite Limits je Exchange/Verbindung, Kontostand, Margin, Leverage, Symbolregeln, Drawdown- und Risikokonfiguration bleiben wirksam. Erst die Live-Stufe sendet eine Order. Liegt die berechnete Größe unter der zulässigen Exchange-Mindestmenge bzw. dem Mindestnotional, normalisiert der native Connector sie auf die Exchange-Regel oder verwirft sie nachvollziehbar, wenn die Order nicht sicher zulässig ist.

## Persistenz und Wiederanlauf

Der Laufzeitspeicher wird standardmäßig alle 30 Sekunden atomar nach `/app/state/redis-snapshot.json` geschrieben. Beim sauberen `SIGTERM`/`SIGINT` erfolgt zusätzlich ein synchroner Flush. Compose hält `/app/state` und `/app/data` in benannten Volumes und gewährt 45 Sekunden zum Herunterfahren.

Backup:

```bash
docker compose stop
docker run --rm -v cts-dashboard-production_cts_state:/source -v "$PWD":/backup alpine \
  tar -czf /backup/cts-state-$(date +%Y%m%d-%H%M%S).tar.gz -C /source .
docker compose start
```

Ein Restore darf nur bei gestoppter Anwendung erfolgen. Nach Restore müssen `/api/system/identity`, `/api/health/readiness`, Verbindungstest und Engine-Status geprüft werden.

## Qualitäts- und Release-Gates

```bash
npm run security:check
npm run typecheck
npm run lint
npm run build
npm run test:standalone
```

Ein Release ist nur zulässig, wenn alle fünf Befehle erfolgreich sind. Der Standalone-Test startet zwei aufeinanderfolgende Produktionsprozesse und prüft Authentifizierung, parallele Identitätszugriffe, SIGTERM-Flush und Snapshot-Wiederanlauf. Echte Ordertests müssen isoliert mit Minimalvolumen erfolgen: zuerst Kontomodus, bestehende Orders/Positionen und Symbolregeln lesen; dann ausschließlich die Testposition eröffnen, Fill prüfen und dieselbe Position wieder vollständig schließen. Vorbestehende Positionen oder Orders dürfen niemals verändert werden.

## Betriebskontrollen

- Liveness: `GET /api/health/liveness`
- Readiness: `GET /api/health/readiness`
- Gesamtstatus: `GET /api/health`
- Site-/Runtime-Identität: `GET /api/system/identity` (authentifiziert)
- Strukturierte Live-Audits: Dashboard „Detailed Logs“ und `live_order_audit:*` im Laufzeitspeicher

Bei einem Fehler zuerst neue Orders pausieren, Snapshot/Logs sichern und erst danach neu starten. Niemals den Persistenz-Volume löschen, solange Progression oder Positionsabgleich benötigt werden.

## Wichtige Verzeichnisse

- `app/`: Dashboardseiten und API-Routen
- `components/`: UI, Provider und Engine-Bootstrap
- `lib/trade-engine/`: Stages, Live-Ausführung und Koordination
- `lib/exchange-connectors/`: native bzw. REST-Connectoren
- `lib/redis-db.ts`: schneller Einzelinstanz-Speicher und atomare Persistenz
- `scripts/`: Diagnose-, Smoke- und Sicherheitsprüfungen

## Haftung

Live-Handel verursacht reales Markt-, Liquiditäts-, Slippage- und Gebührenrisiko. Erfolgreiche technische Tests garantieren weder Profitabilität noch fehlerfreie Exchange-Ausführung. Zuerst Testnet oder Minimalvolumen verwenden und den Betrieb überwachen.
