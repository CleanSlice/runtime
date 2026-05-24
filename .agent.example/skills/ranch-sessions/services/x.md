# X (Twitter) — session recipes

Read `../SKILL.md` first for the shared flow (discover profile, login
recovery, reliable reading). This file is X-specific.

| Need | Answer |
|------|--------|
| Profile | `x:<accountKey>` — from `session_list`, never guess |
| Login URL | `https://x.com/i/flow/login` |
| Write limits | 50 posts/hour free, ~300 Premium |

All recipes use `acc.profile` from `session_list`. Placeholders
(`text`, `handle`, …) are values you fill in.

## Post a tweet

One `browser_play` call, all actions in it — never split posting across
calls, never retry the whole thing in a loop. Critical details:

- Navigate to `/compose/post` directly — opens the composer in a
  `[role="dialog"]` modal.
- **Scope every selector to `[role="dialog"]`** — the page has TWO
  `tweetTextarea_0` (sidebar mini-composer + modal); unscoped selectors
  hit the invisible sidebar one.
- **Use `type`, not `fill`.** X's editor is Lexical; `fill` slams `.value`
  directly and React never sees the input → Post button stays disabled.
- `waitForSelector` the post button `:not([aria-disabled="true"])` so
  you don't click while it's still disabled.
- **No `screenshot`** in the post flow — fullPage on X triggers infinite
  scroll and blows the 100s deadline. Verify via `evaluate` instead.
- Stay under 280 chars on non-Premium accounts.
- **Always verify** in a separate `browser_play` call — navigate to
  `/<handle>` and read the top tweet. The modal closes on cancel too.

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: 'https://x.com/compose/post' },
    { kind: 'waitForSelector', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', timeout: 30000 },
    { kind: 'click', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]' },
    { kind: 'type', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', text },
    { kind: 'wait', ms: 1000 },
    { kind: 'waitForSelector', selector: '[role="dialog"] [data-testid="tweetButton"]:not([aria-disabled="true"])', timeout: 15000 },
    { kind: 'click', selector: '[role="dialog"] [data-testid="tweetButton"]' },
    { kind: 'wait', ms: 3000 },
  ],
})

// Verify in a SEPARATE call.
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://x.com/${handle}` },
    { kind: 'waitForSelector', selector: '[data-testid="tweet"]', timeout: 30000 },
    { kind: 'evaluate', code: `
        const top = document.querySelector('[data-testid="tweet"]');
        const link = top?.querySelector('a[href*="/status/"]')?.getAttribute('href');
        JSON.stringify({
          posted: top?.querySelector('[data-testid="tweetText"]')?.innerText?.includes(${JSON.stringify(text)}),
          url: link ? 'https://x.com' + link : null,
          text: top?.querySelector('[data-testid="tweetText"]')?.innerText,
        })
      ` },
  ],
})
```

## Read a user's timeline

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://x.com/${handle}` },
    { kind: 'waitForSelector', selector: '[data-testid="tweet"]', timeout: 15000 },
    { kind: 'evaluate', code: `
        return [...document.querySelectorAll('[data-testid="tweet"]')].slice(0, 20).map(t => ({
          text: t.querySelector('[data-testid="tweetText"]')?.innerText ?? '',
          time: t.querySelector('time')?.getAttribute('datetime'),
        }));
      ` },
  ],
})
```

## Reply

Same dialog-scoping pattern; `Meta+Enter` on the textarea submits.

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://x.com/${authorHandle}/status/${tweetId}` },
    { kind: 'click', selector: '[data-testid="reply"]' },
    { kind: 'waitForSelector', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', timeout: 10000 },
    { kind: 'type', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', text: reply },
    { kind: 'wait', ms: 1000 },
    { kind: 'press', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', key: 'Meta+Enter' },
    { kind: 'wait', ms: 4000 },
  ],
})
```
