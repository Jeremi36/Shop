# Phase 6 – E-Mail-Versand über Resend

Der Shop versendet Transaktionsmails jetzt direkt über die **Resend HTTP API**. MailerSend und die alte SMTP-Fallback-Logik werden nicht mehr verwendet.

## Warum Resend?

- keine Production-Freischaltung und kein Sandbox-Warteprozess
- kostenlos bis zu 3.000 Transaktionsmails pro Monat beziehungsweise 100 pro Tag
- nach der Domain-Verifizierung kann jede Absenderadresse unter `@premium-shop.com` genutzt werden
- funktioniert auf Render über HTTPS und ist damit unabhängig von geblockten oder problematischen SMTP-Ports

## 1. Resend einrichten

1. Kostenloses Konto bei Resend erstellen.
2. Im Resend-Dashboard unter **Domains** die Domain `premium-shop.com` hinzufügen.
3. Die dort erzeugten DNS-Einträge beim DNS-Anbieter der Domain eintragen.
4. Warten, bis Resend die Domain als **Verified** anzeigt.
5. Unter **API Keys** einen neuen Schlüssel mit Sendeberechtigung erstellen.

Die DNS-Werte sind pro Resend-Konto individuell und dürfen deshalb nicht aus Beispielen übernommen werden.

## 2. Render-Variablen setzen

Im Render-Dashboard des Web Services unter **Environment**:

```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
MAIL_FROM=Premium Shop <info@premium-shop.com>
MAIL_REPLY_TO=info@premium-shop.com
APP_URL=https://premium-shop.com
```

Danach alte Variablen entfernen, sofern vorhanden:

```text
MAILERSEND_API_KEY
MAILERSEND_FROM
SMTP_HOST
SMTP_PORT
SMTP_SECURE
SMTP_USER
SMTP_PASS
```

Anschließend **Manual Deploy → Deploy latest commit** ausführen.

## 3. Wichtig zu `info@premium-shop.com`

Resend kann nach erfolgreicher Domain-Verifizierung von `info@premium-shop.com` senden, auch wenn dafür noch kein echtes Postfach existiert. Für Antworten von Kunden sollte die Adresse jedoch als reales Postfach oder Weiterleitung eingerichtet sein, weil sie als `Reply-To` verwendet wird.

## 4. Kontrolle

Im Render-Log erscheint bei korrekter Konfiguration:

```text
[Mail] Resend API ist aktiv.
```

Bei einer erfolgreich versendeten E-Mail:

```text
[Mail gesendet] ... via Resend (...)
```

Fehler werden mit HTTP-Status und Resend-Fehlermeldung geloggt.
