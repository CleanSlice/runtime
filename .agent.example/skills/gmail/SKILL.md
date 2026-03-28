---
name: gmail
description: Gmail setup, verification, and email sending via SMTP using exec + curl
metadata:
  emoji: "📧"
  always: false
---

# Gmail Skill

Send and verify Gmail via SMTP using `exec` tool with `curl`. No extra dependencies needed.

## Setup Flow

When the user wants to connect Gmail:

1. Ask for Gmail email address → save with `secret_set` key `gmail:email`
2. Confirm: "Email сохранён."
3. Ask for App Password (16-char code from https://myaccount.google.com/apppasswords) → save with `secret_set` key `gmail:app_password`
4. Confirm: "Пароль сохранён."
5. Verify connection (see below)
6. Report the EXACT result — success or the actual error from the server

## Verify Connection

Retrieve credentials with `secret_get`, then run via `exec`:

```bash
curl --silent --show-error \
  --url "smtps://smtp.gmail.com:465" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --mail-from "${EMAIL}" \
  --mail-rcpt "${EMAIL}" \
  --upload-file /dev/null \
  --max-time 10 \
  2>&1
```

- Empty output = success → "SMTP подключение успешно."
- Any output = error → show the exact error to the user

## Send Email

Retrieve credentials with `secret_get`, build the email payload, then run via `exec`:

```bash
printf "From: ${EMAIL}\r\nTo: ${TO}\r\nSubject: ${SUBJECT}\r\n\r\n${BODY}" | \
curl --silent --show-error \
  --url "smtps://smtp.gmail.com:465" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --mail-from "${EMAIL}" \
  --mail-rcpt "${TO}" \
  --upload-file - \
  --max-time 15 \
  2>&1
```

## Critical Rules

- NEVER transform, decode, or "fix" the app password. Store EXACTLY as given.
- NEVER echo password values back in chat.
- NEVER say "connected" or "подключено" until `exec` with curl confirms it.
- NEVER simulate curl output — run the actual command and report real results.
- If credentials are not saved — tell the user to provide them, don't guess.
- App Passwords require 2FA enabled on the Google account.
