// Browser E2E for the Provenalt frontend against a local chain.
//   npx hardhat node; npx hardhat run scripts/deploy-local-v2.js --network localhost
//   (cd frontend && python3 -m http.server 8090)
//   node scripts/e2e-provenalt.js <screenshot-dir> [indexerUrl]
// With an indexer URL (indexer running against the same local chain) the launch form uploads an image and the
// token page must show the chart, trades and holders from the indexer.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SP = process.argv[2];
const IDX = process.argv[3] || "";
const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "frontend", "config.local.js"), "utf8")
  + (IDX ? `\nwindow.PROVENALT_CONFIG.indexerUrl = ${JSON.stringify(IDX)};` : "");

// A real 64×64 PNG (gradient) for the upload test.
function png64() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 4 + 1) + 1 + x * 4;
    raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 180; raw[o + 3] = 255;
  }
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript((src) => {
    eval(src);
    const rpc = async (method, params) => {
      const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
      const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; } return j.result;
    };
    const acct = async () => [(await rpc("eth_accounts"))[10]];
    window.ethereum = { request: ({ method, params }) => (method === "eth_requestAccounts" || method === "eth_accounts") ? acct() : rpc(method, params), on() {} };
  }, cfgSrc);
  const waitOk = async () => { await page.waitForFunction(() => /confirmed/.test(document.querySelector("#banner").textContent), null, { timeout: 30000 }); await page.waitForTimeout(800); };

  await page.goto("http://127.0.0.1:8090/");
  await page.waitForFunction(() => document.querySelector(".card") || /No tokens/.test(document.querySelector("#app").textContent), null, { timeout: 30000 });
  const header = (await page.textContent("header")).replace(/\s+/g, " ").trim();
  const footer = (await page.textContent("footer")).replace(/\s+/g, " ").trim();
  await page.click("#connectBtn");
  await page.waitForFunction(() => document.querySelector("#connectBtn").textContent.includes("…"));

  await page.click('a[href="#/create"]');
  await page.waitForSelector("#f");
  const formText = (await page.textContent("#f")).replace(/\s+/g, " ");
  const hasAllocFields = !!(await page.$('input[name=alloc], input[name=cliff], input[name=duration], input[name=devMax]'));
  await page.fill("input[name=name]", "Elysian Otter");
  await page.fill("input[name=symbol]", "OTTER");
  let uploadStatus = null;
  if (IDX) {
    await page.setInputFiles("#imgFile", { name: "otter.png", mimeType: "image/png", buffer: png64() });
    await page.waitForFunction(() => /Uploaded|failed|Use a|large/.test(document.querySelector("#imgStatus").textContent), null, { timeout: 30000 });
    uploadStatus = await page.textContent("#imgStatus");
  } else {
    await page.fill("input[name=image]", "https://example.com/otter.png");
  }
  await page.fill("textarea[name=description]", "Swimming in the river <b>bold</b>");
  await page.click('#devSeg [data-dev="2.5"]');
  await page.waitForFunction(() => /for 2.5% of the supply/.test(document.querySelector("#devCost").textContent), null, { timeout: 15000 });
  const devCost = await page.textContent("#devCost");
  await page.click("#f button[type=submit]");
  await page.waitForSelector("#tradeBtn", { timeout: 30000 });
  const disclosure = (await page.textContent(".disclosure")).replace(/\s+/g, " ");
  const sourceLine = (await page.textContent(".panel .muted.small")).replace(/\s+/g, " ");
  const imgSrc = await page.$eval(".panel img.avatar", (i) => i.src).catch(() => null);
  await page.screenshot({ path: SP + "/en-token.png", fullPage: true });

  await page.waitForTimeout(11000); // leave the 10 s anti-sniper window (local node: wall-clock timestamps)
  await page.fill("#amt", "1");
  await page.waitForFunction(() => document.querySelector("#quote").textContent.includes("OTTER"), null, { timeout: 15000 });
  const buyQuote = await page.textContent("#quote");
  await page.click("#tradeBtn"); await waitOk();
  await page.waitForSelector("#tradeBtn");
  await page.click('.tabs [data-side="sell"]');
  await page.fill("#amt", "1000000");
  await page.waitForTimeout(600);
  await page.click("#tradeBtn"); await waitOk();
  await page.waitForSelector("#collectBtn");
  await page.click("#collectBtn"); await waitOk();
  await page.waitForSelector("#claimBtn");
  const owedLine = await page.textContent("text=Creator fees");
  await page.click("#claimBtn"); await waitOk();
  await page.waitForSelector("#claimBtn");
  const claimDisabled = await page.isDisabled("#claimBtn");
  let indexed = null;
  if (IDX) {
    await page.waitForTimeout(4000); // let the indexer catch up
    await page.reload();
    await page.waitForSelector("#chartBox svg, #chartBox .empty", { timeout: 30000 });
    indexed = {
      trades: await page.$$eval("#idxPanels .two-col > div:first-child tr", (r) => r.length - 1),
      holdersTitle: await page.textContent("#idxPanels .two-col > div:nth-child(2) h3"),
    };
  }

  await page.goto("http://127.0.0.1:8090/#/");
  await page.waitForSelector(".card");
  const card = (await page.textContent(".card")).replace(/\s+/g, " ");
  await page.screenshot({ path: SP + "/en-list.png" });

  console.log(JSON.stringify({ header, footer, hasAllocFields, formText: formText.slice(0, 160), uploadStatus, devCost, disclosure,
    sourceLine, imgSrc, buyQuote, owedLine, claimDisabled, indexed, card, xssSafe: !(await page.$(".disclosure b + b")), errors }, null, 1));
  await browser.close();
})().catch((e) => { console.error("E2E FAIL", e.message); process.exit(1); });
