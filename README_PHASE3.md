# Premium Shop – Phase 3

Diese Version baut vollständig auf der Render-/Registry-gefixten Phase 2 auf.

## Neu in Phase 3

- Alle kundenrelevanten Oberflächen und Statusbezeichnungen auf Deutsch
- Altersfreigabe für Kunden unsichtbar; Hinweis erscheint nur bei einem gesperrten 16+/18+-Kauf
- Kundenränge mit automatischer Einstufung und Fortschritts-Zeitleiste:
  - Kunde
  - Premium-Kunde: 5 Bestellungen oder 50 € Umsatz
  - Veteranen-Kunde: 10 Bestellungen oder 100 € Umsatz
  - OG-Kunde: 25 Bestellungen und 250 € Umsatz
- Wöchentliche rollenspezifische Rabattcodes: 5 % für Premium, 10 % für Veteran/OG
- OG-Cashback: 5 % als Guthaben nach einer abgeschlossenen normalen Bestellung
- Neue Mitarbeiterrollen mit fest definierten Rechten:
  - New-Staff
  - Junior-Staff
  - Senior-Staff
  - Co-Owner
  - Owner
- Der Owner-Account ist in der Datenbank auf genau einen Account begrenzt
- Rollenabzeichen sind anklickbar und öffnen die Vorteile-/Fortschrittsansicht
- Benachrichtigungszentrale in der Website; E-Mail-Arten können im Konto deaktiviert werden
- Gutschein als eigenes Shop-Produkt in der Kategorie „Gutschein“
- Gutscheinwert, Empfänger, Absender, Nachricht, Gestaltung und Ausgabe als Download oder E-Mail wählbar
- Gutscheincode wird ausschließlich in der erzeugten PDF angezeigt
- Produktvorschläge durch Co-Owner mit Owner-Freigabe
- Co-Owner-Rabattgrenzen und Freigabeprozess für abweichende Rabattcodes
- Kunden- und Mitarbeiterrollen können entsprechend den Berechtigungen verwaltet werden
- New-/Junior-Staff sehen bei Kundenbestellungen keine E-Mail-Adresse oder Anschrift
- Guthabenänderungen für Senior-Staff, Co-Owner und Owner im Support

## Render

Build Command:

```bash
npx pnpm@9.15.4 install --frozen-lockfile && npx pnpm@9.15.4 run migrate
```

Start Command:

```bash
node server.js
```

Danach in Render **Manual Deploy → Clear build cache & deploy**.

## Wichtige Umgebungsvariablen

```env
DATABASE_URL=...
SESSION_SECRET=...
APP_URL=https://deine-domain.de
MAILERSEND_API_KEY=...
MAIL_FROM=Premium Shop <noreply@deine-domain.de>
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_REVIEW_FOLDER=premium-shop/reviews
```

`CLOUDINARY_REVIEW_FOLDER` muss der tatsächliche Ordnerpfad in Cloudinary sein, nicht die ID aus der Browser-URL.

## Rechtlicher Hinweis

Die eingebauten rechtlichen Seiten und Bestellregeln sind technisch editierbare Vorlagen. Sie stellen keine Rechtsberatung dar und garantieren nicht, dass der Shop oder einzelne Klauseln rechtlich zulässig sind. Altersbeschränkte Waren benötigen insbesondere eine rechtskonforme Altersprüfung und Übergabe.


## Render-Lockfile-Fix

Der `pnpm-lock.yaml` ist mit den exakten Versionen aus `package.json` synchronisiert. Der Render-Build kann daher mit `--frozen-lockfile` ausgeführt werden.
