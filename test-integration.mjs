// Standalone integration test — replicates what playwright.repository.ts
// would do inside the runtime, minus all the agent/tool plumbing.
//
// Steps:
//  1. Fetch the per-user storageState from ranch-api integration endpoint
//  2. Launch a stealth-patched Chromium with that state
//  3. Navigate x.com/home and report whether we're logged in
//
// Usage:
//   cd runtime
//   API_URL=http://localhost:3333 \
//     BRIDLE_API_KEY=<bridle-key> \
//     USER_ID=55212224 \
//     PROFILE=x:dimzhuk \
//     bun test-integration.mjs

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const API_URL = (process.env.API_URL ?? 'http://localhost:3333').replace(
  /\/+$/,
  '',
);
const BRIDLE_API_KEY = process.env.BRIDLE_API_KEY;
const USER_ID = process.env.USER_ID ?? '55212224';
const PROFILE = process.env.PROFILE ?? 'x:dimzhuk';

if (!BRIDLE_API_KEY) {
  console.error('Set BRIDLE_API_KEY env var (from ranch/api/.env.dev)');
  process.exit(1);
}

console.log(
  `[test] api=${API_URL} userId=${USER_ID} profile=${PROFILE}`,
);

// ── 1) fetch state from integration store ────────────────────────────────
const url = new URL(`${API_URL}/integrations/internal/browser-state`);
url.searchParams.set('userId', USER_ID);
url.searchParams.set('profile', PROFILE);

const res = await fetch(url.toString(), {
  headers: { 'x-bridle-api-key': BRIDLE_API_KEY },
});
console.log(`[test] api response: ${res.status} ${res.statusText}`);
if (!res.ok) {
  console.error(`[test] expected 200, got ${res.status}. Aborting.`);
  process.exit(1);
}
const body = await res.json();
const payload = body?.data ?? body;
const userAgent = payload?.userAgent;
const storageState = payload?.storageState ?? payload;
const cookies = storageState?.cookies ?? [];
console.log(
  `[test] state: ua=${userAgent ? 'yes' : 'NO'} cookies=${cookies.length} ` +
    `authToken=${cookies.find((c) => c.name === 'auth_token') ? 'yes' : 'NO'}`,
);

// ── 2) launch Chromium with stealth + the storageState ───────────────────
chromium.use(StealthPlugin());
const browser = await chromium.launch({
  headless: false, // false so user can SEE the page if anything weird happens
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  storageState,
  ...(userAgent ? { userAgent } : {}),
});

const page = await context.newPage();

// ── 3) navigate and inspect ──────────────────────────────────────────────
console.log('[test] navigating to https://x.com/home …');
const response = await page.goto('https://x.com/home', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

await page.waitForTimeout(3000); // let SPA settle

const result = await page.evaluate(() => {
  return {
    url: location.href,
    title: document.title,
    hasPrimaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
    hasProfileLink: !!document.querySelector(
      '[data-testid="AppTabBar_Profile_Link"]',
    ),
    profileHref:
      document
        .querySelector('[data-testid="AppTabBar_Profile_Link"]')
        ?.getAttribute('href') ?? null,
    seesLoginButton: !!document.querySelector(
      '[data-testid="loginButton"], [data-testid="login"]',
    ),
    seesSignupButton: !!document.querySelector(
      '[data-testid="signupButton"]',
    ),
    bodyTextSample: document.body.innerText.slice(0, 200).replace(/\n/g, ' '),
  };
});

console.log('\n=== RESULT ===');
console.log(JSON.stringify(result, null, 2));

const loggedIn = result.hasPrimaryColumn && !result.seesLoginButton;
console.log(`\n${loggedIn ? '✅' : '❌'} Logged in: ${loggedIn}`);
if (loggedIn) {
  console.log(`   Profile: ${result.profileHref}`);
  console.log(`   Title:   ${result.title}`);
} else {
  console.log(`   URL:   ${result.url}`);
  console.log(`   Title: ${result.title}`);
  console.log(
    '   Hint:  if URL is /login or /i/flow/login → cookies didnt authenticate',
  );
}

// Leave the browser open for 5s so user can see, then close.
await page.waitForTimeout(5000);
await browser.close();
process.exit(loggedIn ? 0 : 2);
