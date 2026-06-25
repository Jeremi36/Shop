# Premium Shop – Phase 2

## Enthalten

- Amazon-artiges Supportfenster unten rechts mit editierbaren FAQs
- Support-Conversations mit Nummer, Staff-Zuteilung, E-Mail-Ping und Chat
- Support-Tools: Altersstatus, temporäre Sperre, Ban/Entban und Guthabenänderung
- Gutscheinkauf: Anfrage → Staff bestätigt Zahlung → Code und PDF werden automatisch erzeugt und per Mail bereitgestellt
- Kundenguthaben mit Transaktionshistorie und Gutschein-Einlösung
- Guthaben im Checkout; vollständige Deckung setzt die Bestellung automatisch auf `Paid`
- Originalpreis, Guthabenabzug und Restpreis in der Bestellverwaltung
- Treffpunkt-Vorschläge, Kundenbestätigung, Ablehnung und Gegenvorschlag
- Granulare Staff-Rechte, die der Owner auf der Website verwaltet
- Manuelle Bestellzuteilung durch den Owner mit E-Mail-Benachrichtigung
- Audit-Log, Bestell-Timeline und dauerhafte Kontaktdaten-Snapshots je Bestellung
- Optionales Bewertungsbild über Cloudinary
- Experimentelle 16+/18+-Sperre und optionaler Registrierungscode als Owner-Schalter

## Deploy auf Render

Build Command:

```bash
npx pnpm@9.15.4 install && npx pnpm@9.15.4 run migrate
```

Start Command:

```bash
node server.js
```

Danach **Manual Deploy → Clear build cache & deploy**.

## Wichtige Variablen

Siehe `.env.example`. Für Mails werden `MAILERSEND_API_KEY` und eine verifizierte `MAIL_FROM`-Adresse benötigt. Für Bilder werden die drei Cloudinary-Variablen benötigt.

## Rechtlicher Hinweis

Die editierbaren Starttexte sind keine Rechtsberatung. Insbesondere Altersprüfung, Widerrufsbelehrung, AGB, Datenschutz und Impressum müssen vor einem echten Live-Betrieb fachlich geprüft und vollständig an das konkrete Geschäftsmodell angepasst werden. Zwingende Verbraucherrechte werden im Code nicht pauschal ausgeschlossen.


## Render registry fix
The pnpm lockfile now uses the public npm registry and contains no environment-specific internal tarball URLs.
Build command: `npx pnpm@9.15.4 install --frozen-lockfile && npx pnpm@9.15.4 run migrate`
