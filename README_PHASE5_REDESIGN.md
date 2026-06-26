# Premium Shop – Phase 5: Professional Redesign

## Enthaltene Änderungen

- Komplett neu gestaltete Shop-Navigation mit Hamburger-Menü, Suche, Warenkorbanzahl, Warenkorbsumme, Kundenservice-Link und Favicon.
- Neue professionelle Startseite mit Vertrauenselementen, modernen Produktkarten und direkter Gutscheinseite.
- Gutscheine erscheinen nicht mehr im normalen Sortiment oder in der Produktverwaltung. `/gutschein` öffnet direkt den Gutschein-Builder.
- Neue Bestellverwaltung für Mitarbeiter: übersichtliche Karten, klare Statusanzeige, saubere Zuteilung und responsive Aktionen.
- Beim Markieren als bezahlt wird eine Bestellung automatisch angenommen.
- Ablehnungen benötigen eine Kundennachricht, buchen reservierten Bestand automatisch zurück und erstatten verwendetes Shop-Guthaben.
- Die Löschfunktion wurde aus der Oberfläche entfernt; der alte Backend-Endpunkt bleibt nur zur Kompatibilität bestehen und bucht Bestand automatisch zurück.
- Neue kompakte Bestelldetailseite mit 60/40-Aufteilung zwischen Bestelldaten und Verlauf.
- Überarbeitete PayPal-Hinweise und sichere Zahlungsübersicht.
- Bereits bezahlte, abgelehnte Bestellungen werden als offene Rückzahlung markiert und können vom Owner nach der Erstattung bestätigt werden.
- Support ist für Mitarbeiter nur noch über die Mitarbeiterübersicht erreichbar.
- Neue Supportansicht mit 40/60-Aufteilung, besserer Konversation und separaten Kundenwerkzeugen.
- Kunden können aktive und alte Support-Chats öffnen und Chats selbst schließen.
- Neuer interner Staff-Chat mit Erwähnungen und Cloudinary-Bildupload.
- Mitarbeiterübersicht nach täglicher Arbeit, Sortiment, Verwaltung und Owner-Systemfunktionen geordnet.
- Nachkauflinks in der Produktverwaltung: einmal klicken zum Bearbeiten, doppelklicken zum Öffnen.
- E-Mail-Unteroptionen werden bei deaktivierter Hauptoption automatisch abgewählt und gesperrt.

## Deployment

Render führt über `render.yaml` automatisch `pnpm run migrate` aus. Dadurch werden die neuen Spalten und die Tabelle `staff_chat_messages` in Neon angelegt.

Für Bilduploads im Staff-Chat werden dieselben Cloudinary-Zugangsdaten wie für Produktbilder verwendet. Optional kann `CLOUDINARY_STAFF_CHAT_FOLDER` gesetzt werden.
