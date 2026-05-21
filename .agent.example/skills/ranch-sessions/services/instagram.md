# Instagram — session recipes

Read `../SKILL.md` first for the shared flow (discover profile, login
recovery, reliable reading). This file is Instagram-specific.

| Need | Answer |
|------|--------|
| Profile | `instagram:<handle>` — from `integration_list`, never guess |
| Login URL | `https://www.instagram.com/accounts/login/` |

Instagram's rendered DOM is the most hostile of all the services — its
class names are obfuscated and rotate. **Read via `og:` meta tags, not
selectors** (see "Reading content reliably" in `../SKILL.md`).

## Read an account's latest post

One call: open the profile, jump to the newest post's permalink, read
the caption from `og:description`. The grid is newest-first, so the
first `/p/` or `/reel/` link is the latest post.

```ts
const result = await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://www.instagram.com/${handle}/` },
    { kind: 'wait', ms: 5000 },
    // Find the newest post, navigate to its permalink. setTimeout defers
    // the nav so evaluate's return value marshals cleanly first —
    // assigning location.href mid-evaluate destroys the JS context.
    { kind: 'evaluate', code: `
        const a = document.querySelector('a[href*="/p/"], a[href*="/reel/"]');
        if (a) setTimeout(() => { location.href = a.href; }, 150);
        return a ? a.href : 'NO_POSTS';
      ` },
    { kind: 'wait', ms: 5000 },
    { kind: 'evaluate', code: `
        const meta = p => document.querySelector('meta[property="'+p+'"]')?.content || null;
        return {
          url: location.href,
          ogTitle: meta('og:title'),
          ogDescription: meta('og:description'),
          caption: document.querySelector('h1')?.innerText || null,
        };
      ` },
    { kind: 'screenshot', fullPage: false },
  ],
})
```

`og:description` reads like `"42 likes, 3 comments - handle on May 18,
2026: \"<caption>\""` — the caption is the quoted tail (truncated for
long posts). `caption` (the `h1`) has the full text when React rendered
in time; the `screenshot` vision description is the final fallback.
Report whichever field is non-empty.

## Read a profile (bio, counts)

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://www.instagram.com/${handle}/` },
    { kind: 'wait', ms: 4000 },
    { kind: 'evaluate', code: `
        const meta = p => document.querySelector('meta[property="'+p+'"]')?.content || null;
        return { ogTitle: meta('og:title'), ogDescription: meta('og:description') };
      ` },
    { kind: 'screenshot', fullPage: false },
  ],
})
```

## Send a DM

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://www.instagram.com/direct/t/${threadId}/` },
    { kind: 'waitForSelector', selector: '[contenteditable="true"]', timeout: 15000 },
    { kind: 'fill', selector: '[contenteditable="true"]', value: 'Hello!' },
    { kind: 'press', selector: '[contenteditable="true"]', key: 'Enter' },
  ],
})
```
