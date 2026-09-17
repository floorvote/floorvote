#!/usr/bin/env node
/**
 * Captures the fictitious bill-early-vote product screenshot from a local
 * dev environment (seeded via setup.sh's overlay) and frames it, in one
 * shot — an automated alternative to setup.sh's manual browser-paste flow.
 *
 * Prerequisites — seed a local dev environment first:
 *
 *   cd api
 *   rm -rf .wrangler/state
 *   npx wrangler d1 migrations apply floorvote-dev --local -c wrangler.dev.toml
 *   npx wrangler d1 execute floorvote-dev --local -c wrangler.dev.toml \
 *     --file ../scripts/seed-dev.sql --yes
 *   npx wrangler d1 execute floorvote-dev --local -c wrangler.dev.toml --yes \
 *     --command "INSERT OR IGNORE INTO users (id, email, name, role, subtitle, can_vote, created_at) VALUES ('demo-user', 'demo@example.com', 'Demo User', 'owner', 'Demo Account', 1, datetime('now'));"
 *   npx wrangler d1 execute floorvote-dev --local -c wrangler.dev.toml \
 *     --file ../scripts/example-screenshots/seed.sql --yes
 *   cd ..
 *   bash scripts/dev-demo-local.sh &   # api :8789, web :5174
 *
 * (wrangler.dev.toml/dev-demo-local.sh are untracked local-rehearsal
 * scaffolding — see .gitignore. If this machine's api/wrangler.toml still
 * has an [env.dev] section, setup.sh's `npm run dev:local` path works too;
 * point URL below at localhost:5173 in that case.)
 *
 * Then:
 *   npm run screenshot:bill-early-vote [-- output-dir]
 *
 * Produces <output-dir>/bill-early-vote-framed.png (default: this script's
 * own directory).
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const URL = 'http://localhost:5174/bills/bill-early-vote';
const WIDTH = 999; // yields a 690px white card in the desktop layout — measured
                    // empirically: card width = viewport width - 309 (sidebar +
                    // gutter) once past the ~700px mobile breakpoint.
const MARGIN = 16;
const OUT_DIR = path.resolve(process.argv[2] ?? __dirname);
const RAW = path.join(OUT_DIR, 'bill-early-vote-raw.png');
const FRAMED = path.join(OUT_DIR, 'bill-early-vote-framed.png');
const FRAME_PY = path.join(__dirname, 'frame.py');
const INJECTIONS_JS = path.join(__dirname, 'injections.js');

fs.mkdirSync(OUT_DIR, { recursive: true });
const injections = fs.readFileSync(INJECTIONS_JS, 'utf8');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 1600 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on('console', (msg) => console.log(`  [page] ${msg.text()}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
// First load 401s before the DEMO_MODE session cookie is set; reload once authenticated.
await page.goto(URL, { waitUntil: 'networkidle' });
await page.locator('h1, h2').first().waitFor();
await page.waitForTimeout(500);

await page.evaluate(injections);
await page.waitForTimeout(300);

const clip = await page.evaluate((m) => {
  const heading = [...document.querySelectorAll('h1')].find((h) =>
    h.textContent.includes('Election Access and Verification')
  );
  // Walk up from the heading to the white content card (skips the
  // scrollbar-gutter/padding band that main.app-main's own rect includes).
  let topCard = heading;
  while (topCard && topCard.parentElement) {
    if (getComputedStyle(topCard).backgroundColor === 'rgb(255, 255, 255)') break;
    topCard = topCard.parentElement;
  }
  const topRect = topCard.getBoundingClientRect();

  // Stop above the footer's border-top divider (the "Back to bills" link's
  // wrapper div) — everything from there down is page chrome, not content.
  const backLink = [...document.querySelectorAll('a')].find(
    (el) => el.textContent.trim() === '← Back to bills'
  );
  let bottom;
  if (backLink) {
    bottom = (backLink.parentElement ?? backLink).getBoundingClientRect().top;
  } else {
    bottom = 0;
    for (const el of document.querySelectorAll('main.app-main *')) {
      if (!el.offsetHeight) continue;
      const er = el.getBoundingClientRect();
      if (er.bottom > bottom) bottom = er.bottom;
    }
  }

  return {
    x: topRect.left,
    y: Math.max(0, topRect.top - m),
    width: topRect.width,
    height: bottom - topRect.top,
  };
}, MARGIN);

console.log('Clip:', clip);
await page.setViewportSize({ width: WIDTH, height: Math.ceil(clip.height) + 50 });
await page.waitForTimeout(200);
await page.screenshot({ path: RAW, clip });
console.log(`Saved raw screenshot -> ${RAW}`);

await browser.close();

execFileSync('python3', [FRAME_PY, RAW, FRAMED], { stdio: 'inherit' });
fs.rmSync(RAW);
console.log(`Framed screenshot -> ${FRAMED}`);
