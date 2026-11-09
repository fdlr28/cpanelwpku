/* global ethers, EridanosSDK */
(() => {
  "use strict";

  const CFG = window.PROVENALT_CONFIG;
  const SDK = EridanosSDK;
  const ZERO = ethers.ZeroAddress;
  const SLIPPAGE_BPS = 200n; // 2%
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");

  // The public Elysium RPC rate-limits bursts (error -32017). Send one request at a time-ish: no JSON-RPC
  // batching, at most 3 in flight, spaced out, and retry rate-limited calls with backoff.
  class ThrottledProvider extends ethers.JsonRpcProvider {
    constructor(url, chainId) {
      super(url, chainId, { staticNetwork: true, batchMaxCount: 1 });
      this._active = 0;
      this._waiting = [];
      this._next = 0;
    }
    async _acquire() {
      if (this._active >= 3) await new Promise((r) => this._waiting.push(r));
      this._active++;
      const now = Date.now();
      const at = Math.max(now, this._next);
      this._next = at + 120;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    }
    _release() {
      this._active--;
      const r = this._waiting.shift();
      if (r) r();
    }
    async _send(payload) {
      for (let attempt = 0; ; attempt++) {
        await this._acquire();
        let res;
        try { res = await super._send(payload); } finally { this._release(); }
        const limited = res.some((r) => r.error && (r.error.code === -32017 || /rate limit/i.test(r.error.message || "")));
        if (!limited || attempt >= 6) return res;
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
      }
    }
  }
  const read = new ThrottledProvider(CFG.rpcUrl, CFG.chainId);
  const C = (name, address, runner = read) => new ethers.Contract(address, SDK.ABI[name], runner);
  const core = C("LaunchCore", CFG.core);
  const router = C("HypelysRouter", CFG.router);
  const hook = C("CurveHook", CFG.hook);
  const distributor = C("FeeDistributor", CFG.distributor);
  const registry = C("IntegratorRegistry", CFG.registry);
  const config = C("ProtocolConfig", CFG.config);
  let signer = null;
  let account = null;

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const quoteSym = (q) => CFG.quoteSymbols?.[q] ?? CFG.quoteSymbols?.[ethers.getAddress(q)] ?? short(q);
  const quoteDec = (q) => CFG.quoteDecimals?.[q] ?? CFG.quoteDecimals?.[ethers.getAddress(q)] ?? 18;
  const num = (v, dec = 18, dp = 4) => {
    const n = Number(ethers.formatUnits(v, dec));
    if (n === 0) return "0";
    if (Math.abs(n) < 1e-6) return n.toExponential(2);
    return n.toLocaleString("en-US", { maximumFractionDigits: dp });
  };
  const pct = (bps) => `${+(Number(bps) / 100).toFixed(2)}%`;
  const safeUrl = (u) => {
    if (!u) return "";
    if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.slice(7);
    try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch { return ""; }
  };
  const errMsg = (e) => e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);

  function banner(msg, ok = false) {
    const b = $("#banner");
    if (!msg) return b.classList.add("hidden");
    b.textContent = msg;
    b.classList.toggle("ok", ok);
    b.classList.remove("hidden");
  }

  function decodeMeta(uri) {
    try {
      if (uri?.startsWith("data:application/json;base64,")) {
        const bin = atob(uri.split(",")[1]);
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      }
    } catch {}
    return {};
  }
  function encodeMeta(obj) {
    const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
    const bytes = new TextEncoder().encode(JSON.stringify(clean));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return "data:application/json;base64," + btoa(bin);
  }
  function avatar(meta, symbol) {
    const img = safeUrl(meta.image);
    return img ? `<img class="avatar" src="${esc(img)}" alt="" referrerpolicy="no-referrer" />` : `<div class="avatar">${esc((symbol || "?").slice(0, 3))}</div>`;
  }

  // ------------------------------------------------------------------ indexer (optional, see indexer/)
  // With CFG.indexerUrl set, lists, charts, trades and holders come from the indexer's API; if it is
  // unreachable the pages fall back to reading the chain directly.
  const IDX = (CFG.indexerUrl || "").replace(/\/+$/, "");
  async function idx(path) {
    if (!IDX) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(IDX + path, { signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(timer); }
  }
  const cs = (a) => { try { return ethers.getAddress(a); } catch { return a; } };
  const fnum = (x, dp = 4) => {
    const n = Number(x);
    if (!Number.isFinite(n)) return "–";
    if (n === 0) return "0";
    if (Math.abs(n) < 1e-6) return n.toExponential(2);
    return n.toLocaleString("en-US", { maximumFractionDigits: dp });
  };
  const ago = (ts) => {
    const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const exLink = (kind, v, text) => (CFG.explorer ? `<a class="mono" href="${esc(CFG.explorer)}/${kind}/${esc(v)}" target="_blank" rel="noopener">${text}</a>` : `<span class="mono">${text}</span>`);
  const change = (pctv) => (pctv == null ? "" : `<span class="${pctv >= 0 ? "pos" : "neg"}">${pctv >= 0 ? "+" : ""}${pctv.toFixed(2)}%</span>`);
  // Launch source: our own app by name; other apps on the same protocol by number; direct launches as such.
  const OUR_APP = CFG.appName || "Provenalt";
  let ourId = null;
  const sourceLabel = (id) => (!id ? "direct launch" : ourId !== null && Number(id) === ourId ? OUR_APP : `app #${id}`);
  const idxIntegrator = (it) => sourceLabel(it ? it.id : 0);

  /** Candlestick chart as inline SVG (no library). */
  function candleSvg(candles) {
    if (!candles.length) return `<div class="empty small">No trades yet.</div>`;
    const W = 800, H = 260, padR = 78, padY = 14;
    const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
    const span = hi - lo || hi * 0.02 || 1;
    const y = (v) => padY + (hi - v) / span * (H - 2 * padY);
    const step = (W - padR) / Math.max(candles.length, 20);
    const bw = Math.max(2, step * 0.65);
    let g = "";
    candles.forEach((c, i) => {
      const x = i * step + step / 2;
      const up = c.close >= c.open;
      const col = up ? "var(--green)" : "var(--red)";
      const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
      g += `<line x1="${x}" x2="${x}" y1="${y(c.high)}" y2="${y(c.low)}" stroke="${col}" stroke-width="1"/>`
        + `<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${Math.max(1, bot - top)}" fill="${col}"/>`;
    });
    const axisNum = (v) => (Math.abs(v) < 1e-3 ? v.toExponential(3) : v.toPrecision(5));
    const label = (v) => `<text x="${W - padR + 6}" y="${y(v) + 4}" class="axis">${axisNum(Number(v))}</text>`;
    const t0 = new Date(candles[0].t), t1 = new Date(candles[candles.length - 1].t);
    const tl = (d) => d.toLocaleString("en-US", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    return `<svg class="chart" viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none" role="img" aria-label="price chart">
      <line x1="0" x2="${W - padR}" y1="${y(hi)}" y2="${y(hi)}" class="grid"/><line x1="0" x2="${W - padR}" y1="${y(lo)}" y2="${y(lo)}" class="grid"/>
      ${g}${label(hi)}${label(lo)}${hi !== lo ? label((hi + lo) / 2) : ""}
      <text x="2" y="${H + 14}" class="axis">${tl(t0)}</text><text x="${W - padR}" y="${H + 14}" class="axis" text-anchor="end">${tl(t1)}</text></svg>`;
  }

  /** Token price in quote units (human) from the pool's sqrt price. */
  function priceOf(sqrtPriceX96, tokenIs0, qDec) {
    const r = Number(sqrtPriceX96) / 2 ** 96;
    const raw = tokenIs0 ? r * r : 1 / (r * r); // quote-raw per token-raw
    return raw * 10 ** (18 - qDec);
  }

  function disclosure(record) {
    const lines = SDK.describeSupply(record).map(esc);
    const instant = record.instantAllocation;
    const cls = instant ? "disclosure instant" : "disclosure";
    const head = instant ? "<b>Heads up: the creator allocation unlocked at launch.</b><br/>" : "";
    return `<div class="${cls}">${head}${lines.join("<br/>")}</div>`;
  }

  async function integratorLabel(id) {
    if (ourId === null) { try { ourId = Number(await router.integratorId()); } catch { ourId = -1; } }
    return sourceLabel(id);
  }

  async function launchOf(token) {
    const logs = await core.queryFilter(core.filters.Launched(null, token), CFG.deployBlock || 0);
    if (!logs.length) return null;
    const l = logs[0];
    return { integratorId: Number(l.args.integratorId), record: l.args.record.toObject() };
  }

  // ------------------------------------------------------------------ wallet
  async function connect() {
    if (!window.ethereum) return banner("No EVM wallet found. Install MetaMask or Rabby.");
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureChain();
      signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
      account = await signer.getAddress();
      $("#connectBtn").textContent = short(account);
      banner("");
      route();
    } catch (e) { banner(errMsg(e)); }
  }
  async function ensureChain() {
    const hex = "0x" + CFG.chainId.toString(16);
    if ((await window.ethereum.request({ method: "eth_chainId" })) === hex) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: hex, chainName: CFG.chainName, nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
        rpcUrls: [CFG.rpcUrl], blockExplorerUrls: CFG.explorer ? [CFG.explorer] : [] }] });
    }
  }
  function need() { if (!signer) throw new Error("Connect your wallet first."); return signer; }
  async function send(fn, after) {
    try {
      const tx = await fn();
      banner("Waiting for confirmation: " + tx.hash, true);
      const rc = await tx.wait();
      banner("Transaction confirmed ✓", true);
      if (after) await after(rc);
    } catch (e) { banner(errMsg(e)); }
  }

  // ------------------------------------------------------------------ list
  let listSort = "new";
  let listQuery = "";
  async function viewList() {
    app.innerHTML = `<div class="empty">Loading…</div>`;
    if (ourId === null) { try { ourId = Number(await router.integratorId()); } catch { ourId = -1; } }
    if (IDX) {
      const data = await idx(`/tokens?limit=60&sort=${listSort}${listQuery ? "&q=" + encodeURIComponent(listQuery) : ""}`);
      if (data) return renderIndexedList(data.tokens);
    }
    const launches = (await SDK.listLaunches(read, CFG.core, { fromBlock: CFG.deployBlock || 0 })).reverse().slice(0, 60);
    if (!launches.length) {
      app.innerHTML = `<div class="empty">No tokens yet. <a class="btn btn-primary" href="#/create">Launch the first one</a></div>`;
      return;
    }
    const cards = await Promise.all(launches.map(async (l) => {
      const t = C("EridanosToken", l.token);
      const [name, symbol, uri, info, spot] = await Promise.all([
        t.name(), t.symbol(), t.metadataURI(), hook.poolInfo(l.record.poolId), hook.spot(l.record.poolId)]);
      const meta = decodeMeta(uri);
      const q = info.info.quote;
      const mc = priceOf(spot.sqrtPriceX96, info.info.tokenIs0, quoteDec(q)) * 1e9;
      const r = l.record;
      const allocTag = Number(r.allocBps) === 0 ? "" : r.instantAllocation
        ? `<span class="tag bad">${pct(r.allocBps)} unlocked to creator</span>` : `<span class="tag warn">${pct(r.allocBps)} vesting to creator</span>`;
      const devTag = BigInt(r.devBuyTokens) > 0n ? `<span class="tag warn">dev buy ${SDK.supplyPct(r.devBuyTokens)}</span>` : "";
      return `<a class="card" href="#/token/${l.token}">${avatar(meta, symbol)}
        <div style="min-width:0"><b>${esc(name)}</b> <span class="muted">$${esc(symbol)}</span>${allocTag}${devTag}
        <div class="muted small">MC ≈ ${mc.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${esc(quoteSym(q))}</div>
        <div class="muted small">via ${await integratorLabel(l.integratorId)}</div></div></a>`;
    }));
    app.innerHTML = `<h2>Latest tokens</h2><div class="grid">${cards.join("")}</div>`;
  }

  function renderIndexedList(tokens) {
    const sorts = [["new", "New"], ["mcap", "Market cap"], ["volume", "24h volume"], ["trades", "Trades"]];
    const cards = tokens.map((t) => {
      const allocTag = t.allocation.bps === 0 ? "" : t.allocation.instant
        ? `<span class="tag bad">${pct(t.allocation.bps)} unlocked to creator</span>` : `<span class="tag warn">${pct(t.allocation.bps)} vesting to creator</span>`;
      const devTag = Number(t.devBuy.tokens) > 0 ? `<span class="tag warn">dev buy ${SDK.supplyPct(ethers.parseUnits(t.devBuy.tokens, 18))}</span>` : "";
      return `<a class="card" href="#/token/${esc(ethers.getAddress(t.address))}">${avatar({ image: t.image }, t.symbol)}
        <div style="min-width:0"><b>${esc(t.name)}</b> <span class="muted">$${esc(t.symbol)}</span>${allocTag}${devTag}
        <div class="muted small">MC ≈ ${fnum(t.marketCap, 2)} ${esc(t.quote.symbol)} ${change(t.priceChange24h)}</div>
        <div class="muted small">24h vol ${fnum(t.volume24h, 2)} ${esc(t.quote.symbol)} · ${t.holders} holder${t.holders === 1 ? "" : "s"} · ${t.tradesTotal} trade${t.tradesTotal === 1 ? "" : "s"}</div>
        <div class="muted small">via ${idxIntegrator(t.integrator)} · ${ago(t.launchedAt)}</div></div></a>`;
    });
    app.innerHTML = `<div class="toolbar"><h2>Tokens</h2>
        <div class="seg">${sorts.map(([k, l]) => `<button class="btn${k === listSort ? " active" : ""}" data-sort="${k}">${l}</button>`).join("")}</div>
        <input id="search" placeholder="Search name, ticker or address" value="${esc(listQuery)}" /></div>
      ${tokens.length ? `<div class="grid">${cards.join("")}</div>`
        : `<div class="empty">${listQuery ? "No matching tokens." : `No tokens yet. <a class="btn btn-primary" href="#/create">Launch the first one</a>`}</div>`}`;
    document.querySelectorAll(".seg [data-sort]").forEach((b) => (b.onclick = () => { listSort = b.dataset.sort; viewList(); }));
    const search = $("#search");
    let timer;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { listQuery = search.value.trim(); viewList().then(() => { const i = $("#search"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); };
  }

  // ------------------------------------------------------------------ create
  const DEV_CHOICES = [0, 1, 2.5, 5, 10]; // % of supply, capped by the app's policy

  /** Downscales an image to fit `max` px and re-encodes it (WebP, else JPEG) before upload. */
  async function shrinkImage(file, max) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const encode = (type) => new Promise((r) => canvas.toBlob(r, type, 0.9));
    const webp = await encode("image/webp");
    return webp && webp.type === "image/webp" ? webp : encode("image/jpeg");
  }

  /** Uploads a token image to the indexer and returns its permanent URL. */
  async function uploadImage(file) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Use a PNG, JPEG, WebP or GIF image.");
    if (file.size > 10_000_000) throw new Error("Image is too large (max 10 MB).");
    // Animated GIFs stay as they are when small enough; everything else is resized to 512 px.
    const blob = file.type === "image/gif" && file.size <= 900_000 ? file : await shrinkImage(file, 512);
    const r = await fetch(IDX + "/upload", { method: "POST", headers: { "content-type": blob.type }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `upload failed (${r.status})`);
    return j.url;
  }

  async function viewCreate() {
    const id = Number(await router.integratorId());
    ourId = id;
    const policy = await registry.policyOf(id);
    const count = Number(await config.presetCount());
    const presets = [];
    for (let i = 1; i <= count; i++) {
      if (!(await config.isPresetUsable(i))) continue;
      const [info, bands] = await config.preset(i);
      presets.push({ id: i, quote: info.quote, startTick: Number(info.startTick),
        bands: bands.map((b) => ({ offsetLower: Number(b.offsetLower), offsetUpper: Number(b.offsetUpper), bps: Number(b.bps) })) });
    }
    const maxDev = Number(policy.maxDevBuyBps) / 100;
    const devChoices = DEV_CHOICES.filter((x) => x <= maxDev);
    const canUpload = !!IDX;
    app.innerHTML = `<div class="panel" style="max-width:640px;margin:0 auto">
      <h2 style="margin-top:0">Launch a token</h2>
      <p class="muted small">1,000,000,000 supply. No owner, no minting. 1% trading fee forever: protocol 20%,
      ${esc(OUR_APP)} ${pct(policy.integratorBps)}, creator ${pct(8000n - BigInt(policy.integratorBps))}.</p>
      <form id="f">
        <div class="row"><div><label>Name</label><input name="name" maxlength="32" required /></div>
        <div><label>Ticker</label><input name="symbol" maxlength="12" required style="text-transform:uppercase" /></div></div>
        <label>Image</label>
        <div class="imgpick">
          <div id="imgPreview" class="avatar">?</div>
          <div class="imgpick-body">
            ${canUpload ? `<input id="imgFile" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
            <div class="muted small" id="imgStatus">PNG, JPEG, WebP or GIF. Resized to 512 px.</div>
            <a href="#" id="imgUrlToggle" class="small link">Paste an image URL instead</a>` : ""}
            <input name="image" id="imgUrl" placeholder="https://… or ipfs://…" class="${canUpload ? "hidden" : ""}" />
          </div>
        </div>
        <label>Description</label><textarea name="description" maxlength="200" placeholder="Optional"></textarea>
        <label>Pair</label><select name="preset">${presets.map((x) => `<option value="${x.id}">${esc(quoteSym(x.quote))}</option>`).join("")}</select>
        <label>Dev buy <span class="muted">· optional: buy part of the supply in the launch transaction, free of the anti-sniper fee</span></label>
        <div class="seg" id="devSeg">${devChoices.map((x) => `<button type="button" class="btn${x === 0 ? " active" : ""}" data-dev="${x}">${x === 0 ? "None" : x + "%"}</button>`).join("")}</div>
        <div id="devCost" class="quote"></div>
        <button class="btn btn-primary" type="submit" style="width:100%;margin-top:10px">Launch</button>
      </form></div>`;

    const f = $("#f");
    let devPct = 0;
    let imageUrl = "";
    let uploading = false;

    // ---- image
    const preview = $("#imgPreview");
    const showPreview = (src) => {
      preview.innerHTML = src ? `<img class="avatar" src="${esc(src)}" alt="" referrerpolicy="no-referrer" />` : "?";
    };
    if (canUpload) {
      $("#imgUrlToggle").onclick = (ev) => {
        ev.preventDefault();
        $("#imgUrl").classList.toggle("hidden");
      };
      $("#imgFile").onchange = async () => {
        const file = $("#imgFile").files[0];
        const status = $("#imgStatus");
        imageUrl = "";
        if (!file) return showPreview("");
        showPreview(URL.createObjectURL(file));
        uploading = true;
        status.textContent = "Uploading…";
        try {
          imageUrl = await uploadImage(file);
          status.textContent = "Uploaded ✓";
        } catch (e) {
          status.textContent = errMsg(e);
          showPreview("");
          $("#imgFile").value = "";
        } finally { uploading = false; }
      };
    }
    $("#imgUrl").oninput = () => { if (!imageUrl) showPreview(safeUrl($("#imgUrl").value.trim())); };

    // ---- dev buy: cost from the curve, so no "max budget" field is needed
    const selectedPreset = () => presets.find((x) => x.id === Number(f.preset.value));
    const devTokens = () => (SDK.SUPPLY * BigInt(Math.round(devPct * 100))) / 10000n;
    const devBudget = () => {
      if (devPct === 0) return { cost: 0n, max: 0n };
      const cost = SDK.estimateBuyCost(selectedPreset(), SDK.SUPPLY, devTokens());
      return { cost, max: (cost * 101n) / 100n + 10n }; // 1% headroom for rounding; unused funds are refunded
    };
    const showCost = async () => {
      const el = $("#devCost");
      if (devPct === 0) return (el.textContent = "");
      const pr = selectedPreset();
      const qs = quoteSym(pr.quote), qd = quoteDec(pr.quote);
      const { cost, max } = devBudget();
      let line = `≈ ${num(cost, qd, 6)} ${qs} for ${devPct}% of the supply (1% fee included). Up to ${num(max, qd, 6)} ${qs} is sent; anything unused comes back.`;
      if (account) {
        const bal = pr.quote === ZERO ? await read.getBalance(account) : await C("EridanosToken", pr.quote).balanceOf(account);
        if (bal < max) line += ` Your balance (${num(bal, qd, 4)} ${qs}) is not enough.`;
      }
      el.textContent = line;
    };
    document.querySelectorAll("#devSeg [data-dev]").forEach((b) => (b.onclick = () => {
      devPct = Number(b.dataset.dev);
      document.querySelectorAll("#devSeg [data-dev]").forEach((x) => x.classList.toggle("active", x === b));
      showCost();
    }));
    f.preset.onchange = showCost;

    // ---- submit
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector("button[type=submit]");
      try {
        const s = need();
        if (uploading) throw new Error("Wait for the image upload to finish.");
        const pr = selectedPreset();
        const quote = pr.quote;
        const image = imageUrl || f.image.value.trim();
        const metadataURI = encodeMeta({ image, description: f.description.value.trim() });
        if (metadataURI.length > 512) throw new Error("Description or image URL is too long.");
        const { max } = devBudget();
        const p = SDK.normalizeParams({
          name: f.name.value.trim(), symbol: f.symbol.value.trim().toUpperCase(), metadataURI, creator: account, presetId: pr.id,
          allocations: [], cliff: 0, duration: 0, devBuyTokens: devTokens(), maxDevBuyQuote: max,
        });
        btn.disabled = true;
        if (quote !== ZERO && max > 0n) {
          const erc = C("EridanosToken", quote, s);
          if ((await erc.allowance(account, CFG.router)) < max) {
            banner(`Approving ${quoteSym(quote)}…`, true);
            await (await erc.approve(CFG.router, max)).wait();
          }
        }
        const value = quote === ZERO ? max : 0n;
        await send(() => router.connect(s).launch(p, { value }), async (rc) => {
          const e = rc.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched");
          if (e) location.hash = `#/token/${e.args.token}`;
        });
      } catch (e) { banner(errMsg(e)); } finally { btn.disabled = false; }
    };
  }

  // ------------------------------------------------------------------ token page
  async function viewToken(token) {
    if (!ethers.isAddress(token)) return (app.innerHTML = `<div class="empty">Invalid address.</div>`);
    app.innerHTML = `<div class="empty">Loading…</div>`;
    const poolId = await core.poolOf(token);
    if (poolId === ethers.ZeroHash) return (app.innerHTML = `<div class="empty">This token was not launched here.</div>`);
    const t = C("EridanosToken", token);
    const [name, symbol, uri, pinfo, spot, fee, terms, launch] = await Promise.all([
      t.name(), t.symbol(), t.metadataURI(), hook.poolInfo(poolId), hook.spot(poolId), hook.currentFee(poolId),
      distributor.feeTerms(poolId), launchOf(token)]);
    const meta = decodeMeta(uri);
    const q = pinfo.info.quote;
    const qs = quoteSym(q);
    const qd = quoteDec(q);
    const price = priceOf(spot.sqrtPriceX96, pinfo.info.tokenIs0, qd);
    const elapsed = Math.floor(Date.now() / 1000) - Number(pinfo.info.launchedAt);
    const [bal, owedTok, owedQ] = await Promise.all([
      account ? t.balanceOf(account) : 0n, distributor.creatorOwed(poolId, token), distributor.creatorOwed(poolId, q)]);
    const isCreator = account && account.toLowerCase() === terms.terms.creator.toLowerCase();

    app.innerHTML = `<div class="two-col"><div>
      <div class="panel">
        <div style="display:flex;gap:14px;align-items:center">${avatar(meta, symbol)}
          <div><h2 style="margin:0">${esc(name)} <span class="muted">$${esc(symbol)}</span></h2>
          <div class="mono">${esc(token)}</div>
          <div class="muted small">Creator ${short(terms.terms.creator)} · via ${await integratorLabel(launch?.integratorId ?? 0)}</div></div></div>
        <p>${esc(meta.description || "")}</p>
        ${launch ? disclosure(launch.record) : ""}
        <div class="stats">
          <div class="stat"><span class="muted small">Price</span><b>${price.toPrecision(4)} ${esc(qs)}</b></div>
          <div class="stat"><span class="muted small">Market cap</span><b>${(price * 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${esc(qs)}</b></div>
          <div class="stat"><span class="muted small">Current fee</span><b>${(Number(fee) / 10000).toFixed(2)}%${elapsed < 10 ? " (anti-sniper)" : ""}</b></div>
          <div class="stat" title="protocol / app / creator"><span class="muted small">Fee split</span><b>${pct(terms.protocolBps)} / ${pct(terms.integratorBps)} / ${pct(terms.creatorBps)}</b></div>
        </div>
        <button id="collectBtn" class="btn">Collect pool fees</button>
      </div></div>
      <div><div class="panel">
        <div class="tabs"><button class="btn active buy" data-side="buy">Buy</button><button class="btn sell" data-side="sell">Sell</button></div>
        <label id="amtLabel">Amount (${esc(qs)})</label><input id="amt" type="number" min="0" step="any" placeholder="0.0" />
        <div id="quote" class="quote"></div>
        <button id="tradeBtn" class="btn btn-buy" style="width:100%">Buy</button>
        <p class="muted small">Slippage ${Number(SLIPPAGE_BPS) / 100}%. ${account ? `Balance: ${num(bal)} ${esc(symbol)}` : "Connect your wallet to trade."}</p>
        ${isCreator ? `<hr style="border-color:var(--border)"/><p class="small">Creator fees: ${num(owedQ, qd)} ${esc(qs)} + ${num(owedTok)} ${esc(symbol)}</p>
          <button id="claimBtn" class="btn" style="width:100%" ${owedQ + owedTok === 0n ? "disabled" : ""}>Claim creator fees</button>` : ""}
      </div></div></div>
      ${IDX ? `<div id="idxPanels" class="panel" style="margin-top:16px"><div class="empty small">Loading chart…</div></div>` : ""}`;

    if (IDX) loadIndexed(token, symbol, qs);
    $("#collectBtn").onclick = () => send(() => hook.connect(need()).collect(poolId), () => viewToken(token));
    const claim = $("#claimBtn");
    if (claim) claim.onclick = () => send(() => distributor.connect(need()).claimCreator(poolId), () => viewToken(token));
    bindTrade(token, symbol, q, qs, qd);
  }

  async function loadIndexed(token, symbol, qs) {
    const box = $("#idxPanels");
    const addr = token.toLowerCase();
    const [trades, holders] = await Promise.all([idx(`/tokens/${addr}/trades?limit=30`), idx(`/tokens/${addr}/holders?limit=10`)]);
    if (!box || !document.body.contains(box)) return;
    if (!trades) return (box.innerHTML = `<div class="muted small">Chart and trade history are unavailable right now.</div>`);
    const intervals = [["1m", "1m"], ["5m", "5m"], ["1h", "1h"], ["1d", "1d"]];
    const rows = trades.trades.map((t) => {
      const buy = t.side === "buy";
      const tok = t.userAmountIn != null ? (buy ? t.userAmountOut : t.userAmountIn) : t.tokenAmount;
      const quo = t.userAmountIn != null ? (buy ? t.userAmountIn : t.userAmountOut) : t.quoteAmount;
      const label = t.kind === "devbuy" ? "Dev buy" : buy ? "Buy" : "Sell";
      return `<tr><td>${ago(t.ts)}</td><td class="${buy ? "pos" : "neg"}">${label}</td><td>${exLink("address", t.trader, short(cs(t.trader)))}</td>
        <td>${fnum(tok, 2)} ${esc(symbol)}</td><td>${fnum(quo, 6)} ${esc(qs)}</td><td>${exLink("tx", t.tx, "tx")}</td></tr>`;
    }).join("");
    const hrows = (holders?.top || []).map((h) => `<tr><td>${exLink("address", h.address, short(cs(h.address)))}${h.label ? ` <span class="muted small">${esc(h.label)}</span>` : ""}</td>
        <td>${fnum(h.balance, 2)}</td><td>${h.supplyPct.toFixed(2)}%</td></tr>`).join("");
    box.innerHTML = `<div class="toolbar"><h3>Price (${esc(qs)} per ${esc(symbol)})</h3>
        <div class="seg">${intervals.map(([k, l], i) => `<button class="btn${i === 1 ? " active" : ""}" data-iv="${k}">${l}</button>`).join("")}</div></div>
      <div id="chartBox"><div class="empty small">Loading…</div></div>
      <div class="two-col" style="margin-top:12px"><div><h3>Recent trades</h3>
        ${rows ? `<table><tr><th>Time</th><th>Type</th><th>Trader</th><th>Tokens</th><th>${esc(qs)}</th><th></th></tr>${rows}</table>` : `<div class="muted small">No trades yet.</div>`}</div>
        <div><h3>Holders (${holders ? holders.holders : "?"})</h3>
        ${hrows ? `<table><tr><th>Address</th><th>Balance</th><th>%</th></tr>${hrows}</table>` : `<div class="muted small">–</div>`}
        <p class="muted small">The holder count leaves out protocol contracts (pool, hook, vault, burn address).</p></div></div>`;
    const draw = async (iv) => {
      const c = await idx(`/tokens/${addr}/candles?interval=${iv}&limit=120`);
      const el = $("#chartBox");
      if (el) el.innerHTML = c ? candleSvg(c.candles) : `<div class="muted small">Chart unavailable.</div>`;
    };
    box.querySelectorAll("[data-iv]").forEach((b) => (b.onclick = () => {
      box.querySelectorAll("[data-iv]").forEach((x) => x.classList.toggle("active", x === b));
      draw(b.dataset.iv);
    }));
    draw("5m");
  }

  function bindTrade(token, symbol, q, qs, qd) {
    let side = "buy";
    const amt = $("#amt"), quoteEl = $("#quote"), btn = $("#tradeBtn");
    let last = null;
    document.querySelectorAll(".tabs .btn").forEach((b) => (b.onclick = () => {
      side = b.dataset.side;
      document.querySelectorAll(".tabs .btn").forEach((x) => x.classList.toggle("active", x === b));
      $("#amtLabel").textContent = side === "buy" ? `Amount (${qs})` : `Amount (${symbol})`;
      btn.textContent = side === "buy" ? "Buy" : "Sell";
      btn.className = `btn ${side === "buy" ? "btn-buy" : "btn-sell"}`; btn.style.width = "100%";
      amt.value = ""; quoteEl.textContent = ""; last = null;
    }));
    const deadline = () => Math.floor(Date.now() / 1000) + 600;
    const parse = () => ethers.parseUnits(amt.value, side === "buy" ? qd : 18);
    async function quote(v) {
      if (!account) throw new Error("Connect your wallet to see a quote.");
      if (side === "buy") return router.buy.staticCall(token, v, 0, deadline(), { from: account, value: q === ZERO ? v : 0n });
      return router.sell.staticCall(token, v, 0, deadline(), { from: account });
    }
    let timer;
    amt.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        last = null;
        if (!amt.value || Number(amt.value) <= 0) return (quoteEl.textContent = "");
        try {
          const v = parse();
          const out = await quote(v);
          last = { side, v, out };
          quoteEl.textContent = side === "buy" ? `≈ ${num(out)} ${symbol}` : `≈ ${num(out, qd)} ${qs}`;
        } catch (e) { quoteEl.textContent = side === "sell" ? "Check your balance (the sell asks for approval first)." : errMsg(e); }
      }, 250);
    };
    btn.onclick = () => send(async () => {
      const s = need();
      const v = parse();
      if (side === "sell") {
        const t = C("EridanosToken", token, s);
        if ((await t.allowance(account, CFG.router)) < v) { banner("Approving the token…", true); await (await t.approve(CFG.router, v)).wait(); }
      } else if (q !== ZERO) {
        const erc = C("EridanosToken", q, s);
        if ((await erc.allowance(account, CFG.router)) < v) { banner(`Approving ${qs}…`, true); await (await erc.approve(CFG.router, v)).wait(); }
      }
      const out = last && last.side === side && last.v === v ? last.out : await quote(v);
      const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const r = router.connect(s);
      return side === "buy" ? r.buy(token, v, minOut, deadline(), { value: q === ZERO ? v : 0n }) : r.sell(token, v, minOut, deadline());
    }, () => viewToken(token));
  }

  // ------------------------------------------------------------------ router
  async function route() {
    const h = location.hash || "#/";
    try {
      if (!CFG.core) return (app.innerHTML = `<div class="empty">Contract addresses are missing in <code>config.js</code>.</div>`);
      if (h.startsWith("#/create")) return await viewCreate();
      if (h.startsWith("#/token/")) return await viewToken(h.slice(8));
      return await viewList();
    } catch (e) { app.innerHTML = `<div class="empty">Error: ${esc(errMsg(e))}</div>`; }
  }

  $("#connectBtn").onclick = connect;
  $("#netInfo").textContent = `${CFG.chainName} (chain ${CFG.chainId})`;
  window.addEventListener("hashchange", route);
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => connect());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
  route();
})();
