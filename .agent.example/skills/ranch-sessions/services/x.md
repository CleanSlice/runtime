# X (Twitter) — session recipes

Read `../SKILL.md` first for the shared flow (discover profile, login
recovery, reliable reading). This file is X-specific.

| Need | Answer |
|------|--------|
| Profile | `x:<accountKey>` — from `integration_list`, never guess |
| Login URL | `https://x.com/i/flow/login` |
| Write limits | 50 posts/hour free, ~300 Premium |

All recipes use `acc.profile` from `integration_list`. Placeholders
(`text`, `handle`, …) are values you fill in.

## Post a tweet

One `browser_play` call, all actions in it — never split posting across
calls, never retry the whole thing in a loop. Critical details:

- Navigate to `/compose/post` directly — opens the composer in a
  `[role="dialog"]` modal.
- **Scope every selector to `[role="dialog"]`** — the page has TWO
  `tweetTextarea_0` (sidebar mini-composer + modal); unscoped selectors
  hit the invisible sidebar one.
- `waitForSelector` the submit button **before** clicking it — blind
  clicks are what cause `click: Timeout 10000ms`.
- Pace for slow pods: `wait 6000` after navigate, `wait 4000` after
  `fill` (X's React enables the button a beat late).
- Stay under 280 chars on non-Premium accounts.
- **Always verify** — navigate to `/<handle>` and read the top tweet. A
  closed modal is NOT proof; it closes on cancel and rejection too.

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: 'https://x.com/compose/post' },
    { kind: 'wait', ms: 6000 },
    { kind: 'waitForSelector', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', timeout: 30000 },
    { kind: 'click', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]' },
    { kind: 'fill', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', value: text },
    { kind: 'wait', ms: 4000 },
    { kind: 'waitForSelector', selector: '[role="dialog"] [data-testid="tweetButton"]', timeout: 15000 },
    { kind: 'click', selector: '[role="dialog"] [data-testid="tweetButton"]' },
    { kind: 'wait', ms: 7000 },
    { kind: 'navigate', url: `https://x.com/${handle}` },
    { kind: 'waitForSelector', selector: '[data-testid="tweet"]', timeout: 30000 },
    { kind: 'wait', ms: 3000 },
    { kind: 'evaluate', code: `
        const top = document.querySelector('[data-testid="tweet"]');
        const link = top?.querySelector('a[href*="/status/"]')?.getAttribute('href');
        return {
          posted: top?.querySelector('[data-testid="tweetText"]')?.innerText?.includes(${JSON.stringify(text)}),
          url: link ? 'https://x.com' + link : null,
          text: top?.querySelector('[data-testid="tweetText"]')?.innerText,
        };
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
    { kind: 'fill', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', value: reply },
    { kind: 'wait', ms: 1500 },
    { kind: 'press', selector: '[role="dialog"] [data-testid="tweetTextarea_0"]', key: 'Meta+Enter' },
    { kind: 'wait', ms: 4000 },
  ],
})
```
