# TikTok — session recipes

Read `../SKILL.md` first for the shared flow (discover profile, login
recovery, reliable reading). This file is TikTok-specific.

| Need | Answer |
|------|--------|
| Profile | `tiktok:<handle>` — from `integration_list`, never guess |
| Login URL | `https://www.tiktok.com/login` |
| Anti-bot | The most aggressive of all — wait 2–5s between actions, never loop |

## Read profile stats

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://www.tiktok.com/@${handle}` },
    { kind: 'wait', ms: 6000 },
    { kind: 'evaluate', code: `
        const meta = p => document.querySelector('meta[property="'+p+'"]')?.content || null;
        const e2e = s => document.querySelector('[data-e2e="'+s+'"]')?.innerText || null;
        return {
          ogTitle: meta('og:title'),
          ogDescription: meta('og:description'),
          followers: e2e('followers-count'),
          likes: e2e('likes-count'),
          bio: e2e('user-bio'),
        };
      ` },
    { kind: 'screenshot', fullPage: false },
  ],
})
```

## Read the trending feed

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: 'https://www.tiktok.com/foryou' },
    { kind: 'wait', ms: 10000 },
    { kind: 'evaluate', code: `
        return [...document.querySelectorAll('[data-e2e="recommend-list-item-container"]')]
          .slice(0, 10).map(el => ({
            text: el.innerText.slice(0, 300),
            href: el.querySelector('a[href*="/video/"]')?.getAttribute('href') ?? null,
          }));
      ` },
  ],
})
```

## Don't

- Don't post videos with `evaluate` + `dispatchEvent` — TikTok validates
  the upload flow against real user gestures; use real `click` / `fill`.
- Don't run tight navigation loops — TikTok's web bot detection is the
  strictest of the social networks; 2–5s between actions.
