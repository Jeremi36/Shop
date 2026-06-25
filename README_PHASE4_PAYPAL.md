# Phase 4 – PayPal.Me mit manueller Bestätigung

## Funktionsweise

- PayPal ist für alle Kundenränge verfügbar.
- Eingesetztes Guthaben wird vor dem offenen PayPal-Betrag abgezogen.
- Nach der Bestellung wird eine Seite mit Bestellnummer, Restbetrag und PayPal.Me-Link angezeigt.
- PayPal.Me trägt den Betrag ein; die Bestellnummer wird per Kopierknopf übernommen und vom Kunden als Nachricht eingetragen.
- Die Bestellung bleibt unbezahlt, bis der Owner den tatsächlichen Zahlungseingang geprüft und bestätigt hat.
- Die Bestätigung wird in Bestellverlauf und Audit-Log gespeichert.

## Render-Variablen

```env
PAYPAL_ME_LINK=https://paypal.me/DEINNAME
PAYPAL_EMAIL=deine-bestaetigte-paypal-adresse@example.com
```

`PAYPAL_EMAIL` ist optional und dient nur als sichtbare Empfängerinformation. Für den Link wird `PAYPAL_ME_LINK` benutzt.

## Warum diese Änderung?

Die vorherige Version verwendete einen alten PayPal-Händlercheckout (`_xclick`). Dieser kann bei privaten oder nicht für Händlerzahlungen freigeschalteten Konten die Meldung anzeigen, dass die Zahlung an den Händler nicht abgeschlossen werden kann. Die neue Version nutzt stattdessen deinen normalen PayPal.Me-Link und behält die manuelle Bestätigung durch den Owner bei.

Die Website wählt keine Zahlungsart innerhalb von PayPal vor. Der Kunde kontrolliert Empfänger, Betrag und Bestellnummer vor dem Absenden.


## Migration-Fix payment_method
Die wiederholt ausgeführte Schema-Migration erlaubt PayPal und Guthaben nun bereits bei allen früheren Constraint-Schritten. Dadurch schlagen bestehende Bestellungen mit diesen Zahlungsarten bei einem erneuten Deploy nicht mehr fehl.
