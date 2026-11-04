// Browser E2E for the Hypelys frontend (local node + deploy-local-v2 + static server on :8090).
// Usage: NODE_PATH=$(npm root -g) node scripts/e2e-hypelys.js <screenshot-dir>
const { chromium } = require('playwright');
const fs = require('fs');
const SP = process.argv[2];
const cfg = fs.readFileSync('/home/user/cpanelwpku/frontend/config.local.js', 'utf8');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((cfgSrc) => {
    eval(cfgSrc);
    const rpc = async (method, params) => {
      const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }) });
      const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
    };
    const acct = async () => [(await rpc('eth_accounts'))[10]];
    window.ethereum = { request: ({ method, params }) => (method === 'eth_requestAccounts' || method === 'eth_accounts') ? acct() : rpc(method, params), on() {} };
  }, cfg);
  const banner = () => page.textContent('#banner');
  const waitOk = async () => { await page.waitForFunction(() => /berhasil/.test(document.querySelector('#banner').textContent), null, { timeout: 30000 }); await page.waitForTimeout(800); };

  await page.goto('http://127.0.0.1:8090/');
  await page.waitForSelector('text=Belum ada token');
  await page.click('#connectBtn');
  await page.waitForFunction(() => document.querySelector('#connectBtn').textContent.includes('…'));

  await page.click('a[href="#/create"]');
  await page.waitForSelector('#f');
  await page.fill('input[name=name]', 'Elysian Otter');
  await page.fill('input[name=symbol]', 'OTTER');
  await page.fill('input[name=image]', 'https://example.com/otter.png');
  await page.fill('textarea[name=description]', 'Berenang di sungai Eridanos <b>tebal</b>');
  await page.fill('input[name=alloc]', '5');
  await page.fill('input[name=duration]', '0');
  const warnVisible = await page.isVisible('#allocWarn');
  await page.fill('input[name=dev]', '2');
  await page.fill('input[name=devMax]', '100');
  await page.click('#f button[type=submit]');
  await page.waitForSelector('#tradeBtn', { timeout: 30000 });
  const disclosure = (await page.textContent('.disclosure')).replace(/\s+/g, ' ');
  await page.screenshot({ path: SP + '/v2-token.png', fullPage: true });

  // wait out the 10 s anti-sniper window (local node uses wall-clock timestamps), then buy
  await page.waitForTimeout(11000);
  await page.fill('#amt', '1');
  await page.waitForFunction(() => document.querySelector('#quote').textContent.includes('OTTER'), null, { timeout: 15000 });
  const buyQuote = await page.textContent('#quote');
  await page.click('#tradeBtn'); await waitOk();

  await page.waitForSelector('#tradeBtn');
  await page.click('.tabs [data-side=sell]');
  await page.fill('#amt', '1000000');
  await page.waitForTimeout(600);
  await page.click('#tradeBtn'); await waitOk();

  await page.waitForSelector('#collectBtn');
  await page.click('#collectBtn'); await waitOk();
  await page.waitForSelector('#claimBtn');
  const owedLine = await page.textContent('text=Fee creator');
  await page.click('#claimBtn'); await waitOk();
  await page.waitForSelector('#claimBtn');
  const claimDisabled = await page.isDisabled('#claimBtn');

  await page.goto('http://127.0.0.1:8090/#/');
  await page.waitForSelector('.card');
  const card = (await page.textContent('.card')).replace(/\s+/g, ' ');
  await page.screenshot({ path: SP + '/v2-list.png' });

  console.log(JSON.stringify({ warnVisible, disclosure, buyQuote, owedLine, claimDisabled, card, xssSafe: !(await page.$('.disclosure b + b')), errors }, null, 1));
  await browser.close();
})().catch((e) => { console.error('E2E FAIL', e.message); process.exit(1); });
