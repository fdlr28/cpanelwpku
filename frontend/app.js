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
  const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
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
    const head = instant ? "<b>Perhatian: alokasi creator cair instan saat peluncuran.</b><br/>" : "";
    return `<div class="${cls}">${head}${lines.join("<br/>")}</div>`;
  }

  const integratorCache = new Map();
  async function integratorLabel(id) {
    if (!id) return "tanpa integrator";
    if (!integratorCache.has(id)) {
      try { const it = await registry.getIntegrator(id); integratorCache.set(id, { name: it.name, account: it.account, verified: it.verified }); }
      catch { integratorCache.set(id, { name: "?", account: ZERO, verified: false }); }
    }
    const it = integratorCache.get(id);
    return `#${id} ${esc(it.name)} <span class="mono">${short(it.account)}</span>${it.verified ? '<span class="tag">verified</span>' : ""}`;
  }

  async function launchOf(token) {
    const logs = await core.queryFilter(core.filters.Launched(null, token), CFG.deployBlock || 0);
    if (!logs.length) return null;
    const l = logs[0];
    return { integratorId: Number(l.args.integratorId), record: l.args.record.toObject() };
  }

  // ------------------------------------------------------------------ wallet
  async function connect() {
    if (!window.ethereum) return banner("Dompet EVM (MetaMask/Rabby) tidak ditemukan.");
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
  function need() { if (!signer) throw new Error("Hubungkan dompet terlebih dahulu."); return signer; }
  async function send(fn, after) {
    try {
      const tx = await fn();
      banner("Menunggu konfirmasi: " + tx.hash, true);
      const rc = await tx.wait();
      banner("Transaksi berhasil ✓", true);
      if (after) await after(rc);
    } catch (e) { banner(errMsg(e)); }
  }

  // ------------------------------------------------------------------ list
  async function viewList() {
    app.innerHTML = `<div class="empty">Memuat…</div>`;
    const launches = (await SDK.listLaunches(read, CFG.core, { fromBlock: CFG.deployBlock || 0 })).reverse().slice(0, 60);
    if (!launches.length) {
      app.innerHTML = `<div class="empty">Belum ada token. <a class="btn btn-primary" href="#/create">Luncurkan yang pertama</a></div>`;
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
        ? `<span class="tag bad">alokasi ${pct(r.allocBps)} instan</span>` : `<span class="tag warn">alokasi ${pct(r.allocBps)} vesting</span>`;
      const devTag = BigInt(r.devBuyTokens) > 0n ? `<span class="tag warn">dev buy ${SDK.supplyPct(r.devBuyTokens)}</span>` : "";
      return `<a class="card" href="#/token/${l.token}">${avatar(meta, symbol)}
        <div style="min-width:0"><b>${esc(name)}</b> <span class="muted">$${esc(symbol)}</span>${allocTag}${devTag}
        <div class="muted small">MC ≈ ${mc.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${esc(quoteSym(q))}</div>
        <div class="muted small">via ${await integratorLabel(l.integratorId)}</div></div></a>`;
    }));
    app.innerHTML = `<h2>Token terbaru</h2><div class="grid">${cards.join("")}</div>`;
  }

  // ------------------------------------------------------------------ create
  async function viewCreate() {
    const id = Number(await router.integratorId());
    const policy = await registry.policyOf(id);
    const count = Number(await config.presetCount());
    const presets = [];
    for (let i = 1; i <= count; i++) {
      if (!(await config.isPresetUsable(i))) continue;
      const [info] = await config.preset(i);
      presets.push({ id: i, quote: info.quote });
    }
    const maxAlloc = Number(policy.maxAllocBps) / 100;
    const maxDev = Number(policy.maxDevBuyBps) / 100;
    app.innerHTML = `<div class="panel" style="max-width:680px;margin:0 auto">
      <h2 style="margin-top:0">Luncurkan token</h2>
      <p class="muted small">Supply 1.000.000.000. Token tanpa owner dan tanpa mint. Fee 1% selamanya dibagi: protokol 20%,
      Provenalt ${pct(policy.integratorBps)}, creator ${pct(8000n - BigInt(policy.integratorBps))}.</p>
      <form id="f">
        <div class="row"><div><label>Nama</label><input name="name" maxlength="32" required /></div>
        <div><label>Ticker</label><input name="symbol" maxlength="12" required style="text-transform:uppercase" /></div></div>
        <label>URL gambar (https:// atau ipfs://)</label><input name="image" />
        <label>Deskripsi</label><textarea name="description" maxlength="200"></textarea>
        <label>Pasangan (quote)</label><select name="preset">${presets.map((p) => `<option value="${p.id}">${esc(quoteSym(p.quote))}</option>`).join("")}</select>
        <div class="row">
          <div><label>Alokasi creator % (maks ${maxAlloc})</label><input name="alloc" type="number" min="0" max="${maxAlloc}" step="0.01" value="0" /></div>
          <div><label>Cliff (hari, min ${Number(policy.minCliff) / 86400})</label><input name="cliff" type="number" min="0" step="1" value="0" /></div>
          <div><label>Vesting (hari, min ${Number(policy.minDuration) / 86400})</label><input name="duration" type="number" min="0" step="1" value="0" /></div>
        </div>
        <div id="allocWarn" class="disclosure instant hidden">Vesting 0 hari berarti alokasi <b>cair instan</b> saat peluncuran. Ini akan ditampilkan ke semua pembeli.</div>
        <div class="row">
          <div><label>Dev buy % supply (maks ${maxDev}, bebas fee anti-sniper, fee 1%)</label><input name="dev" type="number" min="0" max="${maxDev}" step="0.01" value="0" /></div>
          <div><label>Dana maks untuk dev buy</label><input name="devMax" type="number" min="0" step="any" value="0" /></div>
        </div>
        <p class="muted small">Sisa dana dev buy yang tidak terpakai dikembalikan otomatis.</p>
        <button class="btn btn-primary" type="submit">Luncurkan</button>
      </form></div>`;

    const f = $("#f");
    const warn = () => $("#allocWarn").classList.toggle("hidden", !(Number(f.alloc.value) > 0 && Number(f.duration.value) === 0));
    f.alloc.oninput = warn; f.duration.oninput = warn;
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector("button");
      try {
        const s = need();
        const presetId = Number(f.preset.value);
        const quote = presets.find((p) => p.id === presetId).quote;
        const allocBps = Math.round(Number(f.alloc.value) * 100);
        const devBps = BigInt(Math.round(Number(f.dev.value) * 100));
        const devMax = ethers.parseUnits(String(f.devMax.value || "0"), quoteDec(quote));
        const metadataURI = encodeMeta({ image: f.image.value.trim(), description: f.description.value.trim() });
        if (metadataURI.length > 512) throw new Error("Metadata terlalu panjang (maks 512 byte): persingkat deskripsi/URL.");
        if (devBps > 0n && devMax === 0n) throw new Error("Isi dana maksimum untuk dev buy.");
        const p = SDK.normalizeParams({
          name: f.name.value.trim(), symbol: f.symbol.value.trim().toUpperCase(), metadataURI, creator: account, presetId,
          allocations: allocBps > 0 ? [{ recipient: account, bps: allocBps }] : [],
          cliff: allocBps > 0 ? Math.round(Number(f.cliff.value) * 86400) : 0,
          duration: allocBps > 0 ? Math.round(Number(f.duration.value) * 86400) : 0,
          devBuyTokens: (SDK.SUPPLY * devBps) / 10000n, maxDevBuyQuote: devBps > 0n ? devMax : 0n,
        });
        btn.disabled = true;
        if (quote !== ZERO && p.maxDevBuyQuote > 0n) {
          const erc = C("EridanosToken", quote, s);
          if ((await erc.allowance(account, CFG.router)) < p.maxDevBuyQuote) await (await erc.approve(CFG.router, p.maxDevBuyQuote)).wait();
        }
        const value = quote === ZERO ? p.maxDevBuyQuote : 0n;
        await send(() => router.connect(s).launch(p, { value }), async (rc) => {
          const ev = rc.logs.map((l) => { try { return core.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
          if (ev) location.hash = `#/token/${ev.args.token}`;
        });
      } catch (e) { banner(errMsg(e)); } finally { btn.disabled = false; }
    };
  }

  // ------------------------------------------------------------------ token page
  async function viewToken(token) {
    if (!ethers.isAddress(token)) return (app.innerHTML = `<div class="empty">Alamat tidak valid.</div>`);
    app.innerHTML = `<div class="empty">Memuat…</div>`;
    const poolId = await core.poolOf(token);
    if (poolId === ethers.ZeroHash) return (app.innerHTML = `<div class="empty">Token ini tidak diluncurkan lewat Eridanos.</div>`);
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
          <div class="stat"><span class="muted small">Harga</span><b>${price.toPrecision(4)} ${esc(qs)}</b></div>
          <div class="stat"><span class="muted small">Market cap</span><b>${(price * 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${esc(qs)}</b></div>
          <div class="stat"><span class="muted small">Fee saat ini</span><b>${(Number(fee) / 10000).toFixed(2)}%${elapsed < 10 ? " (anti-sniper)" : ""}</b></div>
          <div class="stat"><span class="muted small">Pembagian fee</span><b>${pct(terms.protocolBps)} / ${pct(terms.integratorBps)} / ${pct(terms.creatorBps)}</b></div>
        </div>
        <button id="collectBtn" class="btn">Kumpulkan fee pool (collect)</button>
      </div></div>
      <div><div class="panel">
        <div class="tabs"><button class="btn active buy" data-side="buy">Beli</button><button class="btn sell" data-side="sell">Jual</button></div>
        <label id="amtLabel">Jumlah ${esc(qs)}</label><input id="amt" type="number" min="0" step="any" placeholder="0.0" />
        <div id="quote" class="quote"></div>
        <button id="tradeBtn" class="btn btn-buy" style="width:100%">Beli</button>
        <p class="muted small">Slippage ${Number(SLIPPAGE_BPS) / 100}%. ${account ? `Saldo: ${num(bal)} ${esc(symbol)}` : "Hubungkan dompet untuk trading."}</p>
        ${isCreator ? `<hr style="border-color:var(--border)"/><p class="small">Fee creator: ${num(owedQ, qd)} ${esc(qs)} + ${num(owedTok)} ${esc(symbol)}</p>
          <button id="claimBtn" class="btn" style="width:100%" ${owedQ + owedTok === 0n ? "disabled" : ""}>Klaim fee creator</button>` : ""}
      </div></div></div>`;

    $("#collectBtn").onclick = () => send(() => hook.connect(need()).collect(poolId), () => viewToken(token));
    const claim = $("#claimBtn");
    if (claim) claim.onclick = () => send(() => distributor.connect(need()).claimCreator(poolId), () => viewToken(token));
    bindTrade(token, symbol, q, qs, qd);
  }

  function bindTrade(token, symbol, q, qs, qd) {
    let side = "buy";
    const amt = $("#amt"), quoteEl = $("#quote"), btn = $("#tradeBtn");
    let last = null;
    document.querySelectorAll(".tabs .btn").forEach((b) => (b.onclick = () => {
      side = b.dataset.side;
      document.querySelectorAll(".tabs .btn").forEach((x) => x.classList.toggle("active", x === b));
      $("#amtLabel").textContent = side === "buy" ? `Jumlah ${qs}` : `Jumlah ${symbol}`;
      btn.textContent = side === "buy" ? "Beli" : "Jual";
      btn.className = `btn ${side === "buy" ? "btn-buy" : "btn-sell"}`; btn.style.width = "100%";
      amt.value = ""; quoteEl.textContent = ""; last = null;
    }));
    const deadline = () => Math.floor(Date.now() / 1000) + 600;
    const parse = () => ethers.parseUnits(amt.value, side === "buy" ? qd : 18);
    async function quote(v) {
      if (!account) throw new Error("Hubungkan dompet untuk melihat kutipan.");
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
        } catch (e) { quoteEl.textContent = side === "sell" ? "Setujui token dulu atau periksa saldo." : errMsg(e); }
      }, 250);
    };
    btn.onclick = () => send(async () => {
      const s = need();
      const v = parse();
      if (side === "sell") {
        const t = C("EridanosToken", token, s);
        if ((await t.allowance(account, CFG.router)) < v) { banner("Menyetujui token untuk router…", true); await (await t.approve(CFG.router, v)).wait(); }
      } else if (q !== ZERO) {
        const erc = C("EridanosToken", q, s);
        if ((await erc.allowance(account, CFG.router)) < v) { banner("Menyetujui quote untuk router…", true); await (await erc.approve(CFG.router, v)).wait(); }
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
      if (!CFG.core) return (app.innerHTML = `<div class="empty">Alamat kontrak belum diisi di <code>config.js</code>.</div>`);
      if (h.startsWith("#/create")) return await viewCreate();
      if (h.startsWith("#/token/")) return await viewToken(h.slice(8));
      return await viewList();
    } catch (e) { app.innerHTML = `<div class="empty">Error: ${esc(errMsg(e))}</div>`; }
  }

  $("#connectBtn").onclick = connect;
  $("#netInfo").textContent = `· ${CFG.chainName} (chainId ${CFG.chainId})`;
  window.addEventListener("hashchange", route);
  if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => connect());
    window.ethereum.on?.("chainChanged", () => location.reload());
  }
  route();
})();
