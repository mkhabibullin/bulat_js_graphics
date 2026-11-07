// Plays the built game in real headless Chrome against a real server: two
// players, movement, chat, building, the avatar shop and a phone-sized screen.
// Any console error, page error or failed request fails the run.
//
//   CHROME_PATH=/path/to/chrome npm run test:e2e

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type KeyInput, type Page } from 'puppeteer-core';
import { startApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { B } from '../shared/blocks.ts';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((p): p is string => Boolean(p));

const shots = path.join(import.meta.dirname, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinkerlands-e2e-'));

const app = await startApp(
  loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    DB_PATH: path.join(tmp, 'e2e.db'),
    LOG_LEVEL: 'warn',
    RATE_GUESTS_PER_HOUR: '1000',
    RATE_AUTH_PER_MINUTE: '1000',
    RATE_API_PER_MINUTE: '100000',
  }),
);
const base = `http://127.0.0.1:${app.port}`;

const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
assert.ok(executablePath, 'No Chrome found. Set CHROME_PATH.');

const browser: Browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--no-sandbox'],
});

const problems: string[] = [];

async function newPlayer(name: string, viewport = { width: 1280, height: 720 }, touch = false): Promise<Page> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ ...viewport, hasTouch: touch, isMobile: touch });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[${name}] console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${name}] page error: ${(e as Error).message}`));
  page.on('requestfailed', (r) => {
    // Navigating away cancels in-flight image loads, which isn't a fault.
    if (r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`[${name}] failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().includes('/api/auth/login')) problems.push(`[${name}] HTTP ${r.status()}: ${r.url()}`);
  });
  return page;
}

async function clickByText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    (s, t) => [...document.querySelectorAll(s)].some((e) => e.textContent?.includes(t)),
    { timeout: 15_000 },
    selector,
    text,
  );
  await page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => e.textContent?.includes(t)) as HTMLElement;
      el.click();
    },
    selector,
    text,
  );
}

interface DebugInfo {
  ready: boolean;
  x: number;
  y: number;
  z: number;
  grounded: boolean;
  players: number;
  pendingChunks: number;
  fps: number;
  canBuild: boolean;
  buildMode: boolean;
}

function info(page: Page): Promise<DebugInfo> {
  return page.evaluate(() => (window as unknown as { __tinker: () => DebugInfo }).__tinker());
}

async function waitForWorld(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const fn = (window as unknown as { __tinker?: () => { ready: boolean; pendingChunks: number } }).__tinker;
      if (!fn) return false;
      const d = fn();
      return d.ready && d.pendingChunks === 0;
    },
    { timeout: 90_000, polling: 200 },
  );
}

/** True if the element is what the browser would hit at the element's centre. */
function isOnTop(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const old = (el as HTMLElement).style.pointerEvents;
    (el as HTMLElement).style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    (el as HTMLElement).style.pointerEvents = old;
    return hit !== null && (hit === el || el.contains(hit));
  }, selector);
}

async function hold(page: Page, key: KeyInput, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, ms));
  await page.keyboard.up(key);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  await fn();
  console.log(`  ok  ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

let failed = false;
try {
  const alice = await newPlayer('alice');

  await step('landing page, then play as a guest', async () => {
    await alice.goto(base, { waitUntil: 'networkidle0' });
    await alice.screenshot({ path: path.join(shots, '1-landing.png') });
    await clickByText(alice, 'button', 'Play now');
    await alice.waitForSelector('.card', { timeout: 15_000 });
    assert.ok((await alice.$$('.card')).length >= 5);
    await alice.waitForNetworkIdle({ idleTime: 300 });
    await alice.screenshot({ path: path.join(shots, '2-discover.png') });
  });

  await step('search filters worlds', async () => {
    await alice.type('input.search', 'spiral');
    await alice.waitForFunction(() => document.querySelectorAll('.card').length === 1, { timeout: 5000 });
    await alice.$eval('input.search', (e) => {
      (e as HTMLInputElement).value = '';
      e.dispatchEvent(new Event('input'));
    });
    await alice.waitForFunction(() => document.querySelectorAll('.card').length >= 5, { timeout: 5000 });
  });

  await step('world page, then enter the obstacle course', async () => {
    await alice.goto(`${base}/#/world/skyline-sprint`);
    await alice.waitForSelector('.world-hero img');
    await alice.waitForNetworkIdle({ idleTime: 300 });
    await alice.screenshot({ path: path.join(shots, '3-world.png') });
    await clickByText(alice, 'a.btn', 'Play');
    await waitForWorld(alice);
    await new Promise((r) => setTimeout(r, 1000));
    await alice.screenshot({ path: path.join(shots, '4-obby.png') });
    // Check what a player can actually see and click, not just what's in the DOM.
    for (const selector of ['.timer', '.hud-coins', '.hud-btn', '.chat-line']) {
      assert.ok(await isOnTop(alice, selector), `${selector} should be visible above the canvas`);
    }
  });

  await step('walking and jumping move the player, confirmed by the server', async () => {
    const before = await info(alice);
    await hold(alice, 'KeyW', 500);
    const moved = await info(alice);
    assert.ok(Math.hypot(moved.x - before.x, moved.z - before.z) > 0.5, `moved ${JSON.stringify([before, moved])}`);
    await new Promise((r) => setTimeout(r, 600));
    const room = app.rooms.get('skyline-sprint')!;
    const server = [...room.players.values()][0].state;
    const client = await info(alice);
    assert.ok(Math.hypot(server.x - client.x, server.z - client.z) < 1, `client and server disagree: ${server.x},${server.z} vs ${client.x},${client.z}`);

    await alice.keyboard.down('Space');
    await alice.waitForFunction(() => !(window as unknown as { __tinker: () => { grounded: boolean } }).__tinker().grounded, { timeout: 5000 });
    await alice.keyboard.up('Space');
  });

  await step('two players see each other and can chat', async () => {
    await alice.goto(`${base}/#/play/open-plots`);
    await waitForWorld(alice);

    const bob = await newPlayer('bob');
    await bob.goto(base, { waitUntil: 'networkidle0' });
    await clickByText(bob, 'button', 'Play now');
    await bob.waitForSelector('.card');
    await bob.goto(`${base}/#/play/open-plots`);
    await waitForWorld(bob);

    await alice.waitForFunction(() => (window as unknown as { __tinker: () => { players: number } }).__tinker().players === 1, { timeout: 10_000 });
    await bob.waitForFunction(() => (window as unknown as { __tinker: () => { players: number } }).__tinker().players === 1, { timeout: 10_000 });

    await bob.keyboard.press('Enter');
    await bob.waitForSelector('.chat-input:not(.hidden)');
    await bob.type('.chat-input', 'hello from bob <img src=x onerror=alert(1)>');
    await bob.keyboard.press('Enter');
    await alice.waitForFunction(() => document.querySelector('.chat-log')?.textContent?.includes('hello from bob'), { timeout: 10_000 });
    assert.equal(await alice.$('.chat-log img'), null, 'chat must never render markup');

    // Bring bob into view so that the screenshot shows both characters.
    const room = app.rooms.get('open-plots')!;
    const ids = [...room.players.values()];
    assert.equal(ids.length, 2);
    await hold(bob, 'KeyW', 300);
    await new Promise((r) => setTimeout(r, 800));
    await alice.screenshot({ path: path.join(shots, '5-multiplayer.png') });
    await bob.close();
    await alice.waitForFunction(() => (window as unknown as { __tinker: () => { players: number } }).__tinker().players === 0, { timeout: 10_000 });
  });

  await step('build mode places and removes blocks through the real mouse path', async () => {
    const room = app.rooms.get('open-plots')!;
    const count = (block: number): number => room.world.data.reduce((n, b) => n + (b === block ? 1 : 0), 0);
    const before = count(B.PLANKS) + count(B.GRASS) + count(B.BRICK);

    await alice.keyboard.press('KeyB');
    await alice.waitForSelector('.hotbar:not(.hidden)');
    assert.equal((await info(alice)).buildMode, true);

    // Look at the ground in front of the character, then capture the mouse.
    await alice.mouse.move(640, 360);
    await alice.mouse.down();
    await alice.mouse.move(640, 480, { steps: 6 });
    await alice.mouse.up();
    // Time for the camera to finish moving over the shoulder.
    await new Promise((r) => setTimeout(r, 1500));

    await alice.keyboard.press('Digit3');
    await alice.mouse.click(640, 360, { button: 'right' });
    await new Promise((r) => setTimeout(r, 400));
    await alice.waitForFunction(() => document.querySelector('.slot.selected') !== null);
    const bricks = count(B.BRICK);
    assert.ok(bricks >= 1, 'a brick should exist on the server');
    assert.ok(count(B.PLANKS) + count(B.GRASS) + bricks > before);
    await alice.screenshot({ path: path.join(shots, '6-build.png') });

    // A quick click only starts cracking the block (brick takes 1.1 seconds).
    await alice.mouse.click(640, 360, { button: 'left' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(count(B.BRICK), bricks, 'a quick click must not break a block');

    // Holding breaks it. Screenshot partway through, to show the cracks.
    await alice.mouse.down({ button: 'left' });
    await new Promise((r) => setTimeout(r, 450));
    await alice.screenshot({ path: path.join(shots, '6b-mining.png') });
    const deadline = Date.now() + 8000;
    while (count(B.BRICK) === bricks && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await alice.mouse.up({ button: 'left' });
    await alice.screenshot({ path: path.join(shots, '6c-broken.png') });
    assert.equal(count(B.BRICK), bricks - 1, 'holding the button breaks the block under the crosshair');
    assert.equal(await alice.$('.toast-error'), null, 'an honest break must never show an error');

    // TNT: place it, light it with a second right-click, then watch it go off.
    const grass = count(B.GRASS);
    await alice.keyboard.press('Digit9');
    await alice.mouse.click(640, 360, { button: 'right' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(count(B.TNT), 1, 'TNT should be placed');
    await alice.screenshot({ path: path.join(shots, '6d-tnt.png') });
    await alice.mouse.click(640, 360, { button: 'right' });
    await new Promise((r) => setTimeout(r, 900));
    await alice.screenshot({ path: path.join(shots, '6e-tnt-lit.png') });
    const fuseEnd = Date.now() + 6000;
    while (count(B.TNT) === 1 && Date.now() < fuseEnd) await new Promise((r) => setTimeout(r, 15));
    await alice.screenshot({ path: path.join(shots, '6f-tnt-boom.png') });
    assert.equal(count(B.TNT), 0, 'lit TNT should explode');
    assert.ok(count(B.GRASS) < grass - 15, 'the blast should destroy the ground around it');
    await new Promise((r) => setTimeout(r, 1500));
    await alice.screenshot({ path: path.join(shots, '6g-tnt-crater.png') });

    await alice.keyboard.press('KeyE');
    await alice.waitForSelector('.palette:not(.hidden)');
    await alice.screenshot({ path: path.join(shots, '7-palette.png') });
    await alice.keyboard.press('KeyE');
    await alice.keyboard.press('KeyB');
  });

  await step('pause menu opens and closes', async () => {
    // Esc frees the captured mouse. Then a real click, which only lands if
    // nothing is covering the button.
    await alice.keyboard.press('Escape');
    await alice.waitForSelector('.pause:not(.hidden)');
    await alice.screenshot({ path: path.join(shots, '8-pause.png') });
    await alice.click('.pause .btn-primary');
    await alice.waitForSelector('.pause.hidden');
  });

  await step('avatar shop: buy, equip and persist a hat', async () => {
    await alice.goto(`${base}/#/avatar`);
    await alice.waitForSelector('.hat-item');
    await clickByText(alice, '.hat-item', 'Ball cap');
    await alice.waitForFunction(() => [...document.querySelectorAll('.hat-item.active')].some((e) => e.textContent?.includes('Ball cap')), { timeout: 5000 });
    await clickByText(alice, '.swatch', '');
    await new Promise((r) => setTimeout(r, 800));
    await alice.screenshot({ path: path.join(shots, '9-avatar.png') });
    await alice.reload({ waitUntil: 'networkidle0' });
    await alice.waitForFunction(() => [...document.querySelectorAll('.hat-item.active')].some((e) => e.textContent?.includes('Ball cap')), { timeout: 5000 });
  });

  await step('create a world from a template and enter it as its owner', async () => {
    await alice.goto(`${base}/#/mine`);
    await alice.waitForSelector('.create-form input');
    await alice.type('.create-form input', 'Alice Land');
    await clickByText(alice, '.template', 'Obstacle course');
    await clickByText(alice, '.create-form button[type=submit]', 'Create');
    await waitForWorld(alice);
    assert.equal((await info(alice)).canBuild, true);
    await alice.goto(`${base}/#/mine`);
    await alice.waitForSelector('.card');
    await alice.waitForNetworkIdle({ idleTime: 300 });
    await alice.screenshot({ path: path.join(shots, '10-mine.png') });
  });

  await step('reconnects after the connection drops', async () => {
    await alice.goto(`${base}/#/play/sunny-isle`);
    await waitForWorld(alice);
    await new Promise((r) => setTimeout(r, 800));
    await alice.screenshot({ path: path.join(shots, '11-island.png') });
    const room = app.rooms.get('sunny-isle')!;
    [...room.players.values()][0].ws.terminate();
    await new Promise((r) => setTimeout(r, 200));
    await waitForWorld(alice);
    await alice.waitForFunction(() => document.querySelector('.overlay-solid:not(.hidden)') === null, { timeout: 15_000 });
    assert.equal(room.players.size, 1, 'the player should be back in the room');
    await alice.close();
  });

  await step('phone layout with touch controls', async () => {
    const phone = await newPlayer('phone', { width: 412, height: 800 }, true);
    await phone.goto(base, { waitUntil: 'networkidle0' });
    await phone.screenshot({ path: path.join(shots, '12-phone-landing.png') });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no sideways scrolling on phones');
    await clickByText(phone, 'button', 'Play now');
    await phone.waitForSelector('.card');
    await phone.goto(`${base}/#/play/skyline-sprint`);
    await waitForWorld(phone);
    assert.ok(await phone.$('.stick'), 'joystick should show on touch screens');
    await new Promise((r) => setTimeout(r, 500));
    await phone.screenshot({ path: path.join(shots, '13-phone-game.png') });
    await phone.close();
  });

  if (problems.length > 0) throw new Error(`Browser problems:\n${problems.join('\n')}`);
  console.log('\nE2E passed.');
} catch (err) {
  failed = true;
  console.error('\nE2E FAILED:', err);
  if (problems.length > 0) console.error(problems.join('\n'));
} finally {
  await browser.close();
  await app.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(failed ? 1 : 0);
