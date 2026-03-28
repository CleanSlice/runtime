---
name: gmail
description: Gmail setup, verification, and email sending via SMTP using exec + curl
metadata:
  emoji: "📧"
  always: false
---

# Gmail Skill

Send and verify Gmail via SMTP using `exec` tool with `curl`. No extra dependencies needed.

## What is a Google App Password

A Google App Password looks like `cipg qciu zczq wupq` — four groups of four lowercase letters.
It is NOT encrypted, NOT encoded, NOT a cipher. It is a plain SMTP/IMAP password.
Pass it directly to curl `--user` flag as-is. Spaces are optional — Google accepts both `cipg qciu zczq wupq` and `cipgqciuzczqwupq`.

**Do NOT attempt to decode, decrypt, ROT13, Base64-decode, or transform it in any way.**

## Setup Flow

When the user wants to connect Gmail:

1. Ask for Gmail email address → save with `secret_set` key `gmail:email`
2. Confirm briefly (e.g. "Saved.")
3. Ask for App Password (16-char code from https://myaccount.google.com/apppasswords) → save with `secret_set` key `gmail:app_password`
4. Confirm briefly (e.g. "Saved.")
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

- Empty output = success. Report: connection verified.
- Any output = error. Show the exact error to the user.

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

- App Passwords are plain SMTP credentials. NO decryption, NO transformation, NO encoding.
- Store the password EXACTLY as the user gives it. Do not strip spaces, do not modify.
- Never echo password values back in chat.
- Never claim a connection is verified until `exec` with curl confirms it.
- Never simulate curl output — run the actual command and report real results.
- Do not narrate steps you are not performing. If you are running curl — just run it silently.
- If credentials are not saved — tell the user to provide them, don't guess.
- App Passwords require 2FA enabled on the Google account.
