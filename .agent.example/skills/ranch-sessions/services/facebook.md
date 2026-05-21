# Facebook / Meta Ads — session recipes

Read `../SKILL.md` first for the shared flow (discover profile, login
recovery, reliable reading). This file is Facebook-specific.

| Need | Answer |
|------|--------|
| Profile | `facebook:<label>` (e.g. `facebook:main`, `facebook:client-acme`) |
| Login URL | `https://www.facebook.com/login/` |
| Meta link | One profile covers Facebook AND linked Instagram when SSO is on |
| Ads Manager | `https://adsmanager.facebook.com/` — same cookies |

## Read Ads Manager campaigns

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${adAccountId}` },
    { kind: 'wait', ms: 8000 },
    { kind: 'evaluate', code: `
        return [...document.querySelectorAll('[role="row"]')].slice(1, 21).map(r => r.innerText);
      ` },
  ],
})
```

## Post on a page

```ts
await browser_play({
  profile: acc.profile,
  actions: [
    { kind: 'navigate', url: `https://www.facebook.com/${pageId}` },
    { kind: 'wait', ms: 5000 },
    { kind: 'click', selector: '[role="button"][aria-label*="Create"]' },
    { kind: 'waitForSelector', selector: '[contenteditable="true"]', timeout: 15000 },
    { kind: 'fill', selector: '[contenteditable="true"]', value: post },
    { kind: 'wait', ms: 2000 },
    { kind: 'click', selector: '[role="button"][aria-label="Post"]' },
  ],
})
```

## accountKey conventions

- `facebook:main` — primary personal account
- `facebook:<client-slug>` — shared / agency accounts (one per client)
- `facebook:ads-<account-id>` — pinned to a specific Business Manager

Don't mix personal and Business Manager logins in one profile — Meta
re-prompts for auth when the active account switches.
