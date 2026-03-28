---
name: gmail
description: Gmail setup, send, read, and search emails via SMTP/IMAP using exec + curl
metadata:
  emoji: "📧"
  always: false
---

# Gmail Skill

Full Gmail access (send, read, count, search) via `exec` + `curl` over SMTP and IMAP. No extra dependencies, no Gmail API needed.

## What is a Google App Password

A Google App Password looks like `cipg qciu zczq wupq` — four groups of four lowercase letters.
It is NOT encrypted, NOT encoded, NOT a cipher. It is a plain SMTP/IMAP password.
Pass it directly to curl `--user` flag as-is. Spaces are optional — Google accepts both formats.

**Do NOT attempt to decode, decrypt, ROT13, Base64-decode, or transform it in any way.**

## Setup Flow

1. Ask for Gmail email address → save with `secret_set` key `gmail:email`
2. Confirm briefly (e.g. "Saved.")
3. Ask for App Password (16-char code from https://myaccount.google.com/apppasswords) → save with `secret_set` key `gmail:app_password`
4. Confirm briefly (e.g. "Saved.")
5. Verify connection (see Verify section)
6. Report the EXACT result from curl

## Verify Connection (SMTP)

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

Empty output = success. Any output = error.

## Send Email (SMTP)

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

## Count Emails (IMAP)

```bash
curl --silent --show-error \
  --url "imaps://imap.gmail.com:993/INBOX" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --request "STATUS INBOX (MESSAGES UNSEEN)" \
  --max-time 10 \
  2>&1
```

Returns: `* STATUS "INBOX" (MESSAGES 42 UNSEEN 3)`

## List Recent Emails (IMAP)

Fetch last 10 message subjects:

```bash
curl --silent --show-error \
  --url "imaps://imap.gmail.com:993/INBOX" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --request "FETCH 1:10 (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])" \
  --max-time 15 \
  2>&1
```

## Read a Specific Email (IMAP)

Fetch full body of message by UID:

```bash
curl --silent --show-error \
  --url "imaps://imap.gmail.com:993/INBOX;UID=${UID}" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --max-time 15 \
  2>&1
```

## Search Emails (IMAP)

```bash
curl --silent --show-error \
  --url "imaps://imap.gmail.com:993/INBOX" \
  --user "${EMAIL}:${APP_PASSWORD}" \
  --request "SEARCH FROM \"sender@example.com\"" \
  --max-time 10 \
  2>&1
```

Other SEARCH criteria: `SUBJECT "keyword"`, `SINCE 01-Mar-2026`, `UNSEEN`, `ALL`.

## Critical Rules

- App Passwords are plain SMTP/IMAP credentials. NO decryption, NO transformation.
- Store the password EXACTLY as given. Do not strip spaces.
- Never echo password values back in chat.
- Never claim a connection is verified until curl confirms it.
- Never simulate curl output — run the actual command and report real results.
- Do not narrate steps you are not performing.
- Do NOT claim you need "Gmail API", "nodemailer", or any other library. Everything works via curl.
- If credentials are not saved — tell the user to provide them, don't guess.
- App Passwords require 2FA enabled on the Google account.
