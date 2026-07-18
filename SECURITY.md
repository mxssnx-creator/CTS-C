# Security Policy

Melde Sicherheitsprobleme nicht in einem öffentlichen Issue. Kontaktiere den Repository-Eigentümer über einen privaten, verifizierten Kanal.

Exchange-Keys, Session-Secrets, Snapshots und `.env`-Dateien dürfen niemals committed werden. Vor jedem Push muss `npm run security:check` erfolgreich sein. Bei einem vermuteten Leak:

1. betroffenen Exchange-Key sofort deaktivieren und neu ausstellen,
2. Handel pausieren und offene Positionen direkt an der Exchange prüfen,
3. `JWT_SECRET` und `CRON_SECRET` rotieren,
4. Git-Historie und Artefakte auf exakte Credential-Treffer prüfen,
5. erst nach vollständiger Bereinigung den Betrieb wieder aufnehmen.

Produktive Exchange-Keys sollen keine Auszahlungsrechte besitzen und nach Möglichkeit an feste IP-Adressen gebunden sein.
