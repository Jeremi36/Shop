# Phase 4 – PayPal mit manueller Bestätigung

## Neue Funktionen

- PayPal ist für alle Kundenränge als Zahlungsart verfügbar.
- Bereits eingesetztes Guthaben wird vor dem PayPal-Betrag abgezogen.
- Jede Bestellung erhält eine lesbare Bestellnummer wie `PS-1000`.
- Nach der Bestellung wird eine PayPal-Zahlungsseite mit Empfänger, Restbetrag und Bestellnummer angezeigt.
- Die Bestellung wird **nicht automatisch** als bezahlt markiert.
- Nur der Owner kann den tatsächlichen PayPal-Zahlungseingang bestätigen.
- Die Bestätigung wird in Bestellverlauf und Audit-Log gespeichert.
- Optionaler PayPal-Sandboxmodus ohne echtes Geld.

## Render-Variablen

```env
PAYPAL_EMAIL=deine-bestaetigte-paypal-adresse@example.com
PAYPAL_SANDBOX=false
```

Für Tests ohne echtes Geld:

```env
PAYPAL_SANDBOX=true
```

## Wichtiger Hinweis

Die Integration erzeugt eine normale PayPal-Zahlung für eine Bestellung. Sie erzwingt keine Zahlung über „Freunde und Familie“. Der Owner muss Betrag und Bestellnummer in PayPal prüfen, bevor er die Bestellung als bezahlt markiert.
