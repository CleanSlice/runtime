---
name: ranch-sessions
description: Logged-in browser automation for social and web accounts — X (Twitter), Instagram, Facebook / Meta Ads, TikTok. Discover a connected session, recover a dead login, read content reliably, then load the per-service recipe file.
metadata:
  always: true
---

# Ranch Sessions

A **session** is a logged-in browser account the agent drives through
the `browser_play` tool — X, Instagram, Facebook / Meta, TikTok. The
user connects it once by pushing cookies from their own browser via the
**Ranch Cookies** extension; cookies live on a persistent volume and
survive pod restarts.

This file holds the **shared flow** that applies to every service. The
**per-service recipes live in separate files** — see "Per-service
recipes" at the bottom and read the one you need before calling
`browser_play`.

---

## Step 0 — discover the profile (always, never guess)

`browser_play` needs a `profile` string. Never invent it — call
`session_list` and use the exact `profile` field it returns:

```ts
const { accounts } = await session_list()
const acc = accounts.find(a => a.service === "instagram") // or x / facebook / tiktok
if (!acc) {
  // not connected — tell the user to connect it (see below), then STOP
  return
}
// acc.profile is e.g. "instagram:miybot" — pass it to browser_play verbatim
```

Guessing `x:default` or a handle you assumed is the #1 cause of false
"needs login" failures.

## Always try browser_play first — don't gate on status

`session_list` returns a `status` field. **It is advisory and often
stale** — it can say `needs_login` while the cookies are perfectly
valid. The only trustworthy login signal is `browser_play`'s own
`needsLogin` response. Run `browser_play`; let it decide. Skipping it
because of a stale status is why posts silently never happen.

---

## Connecting an account (extension-driven, no VNC)

The user logs in **in their own Chrome** and pushes cookies via the
**Ranch Cookies** extension. Ranch never opens a VNC browser.

1. User opens the site (`instagram.com`, `x.com`, …) in their normal
   Chrome and logs in — 2FA and challenges are handled there, like any
   browser session.
2. User clicks the **Ranch Cookies** extension → it auto-detects the
   service from the tab → **Send cookies**.
3. The session shows up in the admin `/sessions` page; the agent can
   now call `browser_play` with that profile.

Never tell the user to "just log in somewhere" without the extension —
cookies must arrive through it.

## Login recovery (cookies expired)

When `browser_play` returns `needsLogin: true`:

```ts
const help = await session_request_login({
  service: acc.service, accountKey: acc.accountKey,
})
await ctx.send(help.instructions)   // forward the instructions verbatim
// Then STOP. Wait for the user to confirm they re-pushed cookies.
// Do NOT loop browser_play. Retry it ONCE, after they confirm.
```

Never fill a username/password form yourself — every one of these
services detects scripted logins and locks the account fast.

---

## Reading content reliably

Every site here is a heavy SPA with **obfuscated, rotating class
names**. `getText` / `click` / `waitForSelector` on guessed selectors
**time out** — the single most common failure mode. Read from stable
sources instead:

1. **`<meta property="og:*">` tags** — in the static `<head>`, present
   *before* the SPA renders. Selectors never rot.
2. **`screenshot`** — `browser_play` screenshots and runs vision
   automatically; use it as the fallback / cross-check.
3. **`evaluate`** — run JS to pull text in one shot, instead of many
   per-element selector actions.

Never build a read on `waitForSelector` + `getText`.

## If browser_play crashes or stalls

These sites intermittently crash or hang headless Chromium —
`browser_play` returns `browser has been closed` or hits its 100s hard
deadline. **Retry the same call once.** A single retry usually
succeeds; don't loop beyond that — report the failure to the user.

---

## Per-service recipes — read the matching file

Each service has its own recipe file in this skill's `services/`
folder. **Before calling `browser_play` for a service, read its file
with the `file` tool** — it has the verified action sequences.

| Service | Profile | Read this file |
|---------|---------|----------------|
| X (Twitter) | `x:<accountKey>` | `skills/ranch-sessions/services/x.md` |
| Instagram | `instagram:<handle>` | `skills/ranch-sessions/services/instagram.md` |
| Facebook / Meta Ads | `facebook:<label>` | `skills/ranch-sessions/services/facebook.md` |
| TikTok | `tiktok:<handle>` | `skills/ranch-sessions/services/tiktok.md` |

Paths are relative to the agent working dir (`.agent/`).

---

## Per-service: X (Twitter) — INLINED, do not freelance

The X recipe is inlined here on purpose: sub-files don't auto-load and the
LLM consistently fails to read them. This is the **only** sequence that
works — every variant tried in production (clicking sidebar buttons,
`a[href='/compose/tweet']`, `fill` on the textarea, `fullPage` screenshots)
hits a dead end. Use it verbatim.

### Why each step is the way it is

- `/compose/post` is the modal-direct URL. `/home` + click on sidebar
  button is selector-fragile.
- `[role="dialog"]` scope is **mandatory** — the page has two
  `tweetTextarea_0` (sidebar mini-composer + modal). Without the scope
  Playwright in strict mode times out on ambiguity.
- Use `type` (real keystrokes), **never `fill`**. X's editor is Lexical;
  `fill` slams `.value` directly and React never sees the input → the
  Post button stays disabled forever.
- **No `screenshot`** in the posting flow. X is infinite-scroll heavy;
  fullPage shots trigger lazy-load loops that blow the 100s deadline.
  Verify by reading the timeline back instead.

### Post a tweet

```ts
const { accounts } = await session_list()
const acc = accounts.find(a => a.service === "x")
if (!acc) { /* tell the user to connect X via /sessions, STOP */ return }

await browser_play({
  profile: acc.profile,
  actions: [
    { kind: "navigate", url: "https://x.com/compose/post" },
    { kind: "waitForSelector",
      selector: '[role="dialog"] [data-testid="tweetTextarea_0"]',
      timeout: 30000 },
    { kind: "click", selector: '[role="dialog"] [data-testid="tweetTextarea_0"]' },
    // ← `type`, not `fill`. Fires the input events Lexical listens to.
    { kind: "type",
      selector: '[role="dialog"] [data-testid="tweetTextarea_0"]',
      text },
    { kind: "wait", ms: 1000 },
    // Wait for the button to become enabled (X disables it until valid text).
    { kind: "waitForSelector",
      selector: '[role="dialog"] [data-testid="tweetButton"]:not([aria-disabled="true"])',
      timeout: 15000 },
    { kind: "click", selector: '[role="dialog"] [data-testid="tweetButton"]' },
    { kind: "wait", ms: 3000 },
  ],
})

// Verify in a SEPARATE call (the modal closes on cancel too, so closure ≠ success).
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: "navigate", url: `https://x.com/${handle}` },
    { kind: "waitForSelector", selector: '[data-testid="tweet"]', timeout: 30000 },
    { kind: "evaluate", code: `
        const top = document.querySelector('[data-testid="tweet"]');
        JSON.stringify({
          posted: top?.querySelector('[data-testid="tweetText"]')?.innerText?.includes(${JSON.stringify(text)}),
          text:   top?.querySelector('[data-testid="tweetText"]')?.innerText,
        })
      ` },
  ],
})
```

### Reply

Same dialog-scope + `type`; `Meta+Enter` is the documented submit shortcut.

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: "navigate", url: `https://x.com/${authorHandle}/status/${tweetId}` },
    { kind: "click", selector: '[data-testid="reply"]' },
    { kind: "waitForSelector",
      selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', timeout: 10000 },
    { kind: "type",
      selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', text: reply },
    { kind: "wait", ms: 1000 },
    { kind: "press",
      selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', key: "Meta+Enter" },
    { kind: "wait", ms: 4000 },
  ],
})
```

### Read a user's timeline

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: "navigate", url: `https://x.com/${handle}` },
    { kind: "waitForSelector", selector: '[data-testid="tweet"]', timeout: 15000 },
    { kind: "evaluate", code: `
        JSON.stringify([...document.querySelectorAll('[data-testid="tweet"]')].slice(0, 20).map(t => ({
          text: t.querySelector('[data-testid="tweetText"]')?.innerText ?? '',
          time: t.querySelector('time')?.getAttribute('datetime'),
        })))
      ` },
  ],
})
```

### Failure protocol (X)

- `tool error: TimeoutError` on the textarea selector → the modal didn't open
  (X redirected to login). Treat as `needsLogin`: call `session_request_login`,
  forward the instructions, **STOP**.
- `tool error: TimeoutError` on the post-button-not-disabled selector → text
  didn't register. You almost certainly used `fill` instead of `type`. Use
  `type` and retry **once**.
- `browser_play hit its 100s hard deadline` → almost always means a
  `screenshot` action triggered fullPage scroll-and-shoot. Remove all
  `screenshot` actions from posting flows; verify via `evaluate` instead.
- 3 consecutive errors in a row → stop. Report what happened to the user.
  Do NOT loop `browser_play` — it holds the per-agent browser mutex and
  starves other live conversations.

---

## Don't (all services)

- **Don't guess the profile** — `session_list` first, use it verbatim.
- **Don't fill login forms** — `session_request_login` → user pushes
  cookies via the extension. Scripted logins lock accounts.
- **Don't claim success from a closed dialog** — verify by reading the
  result back (e.g. the top post on `/<handle>`).
- **Don't burst** — rate limits are aggressive; pace navigations,
  especially on TikTok and Instagram.
- **Don't reference VNC / `browser_login`** — those tools were removed.
  The login path is `session_request_login` + the Ranch extension.
