/* global ethers */
(() => {
  "use strict";

  const CFG = window.LAUNCHPAD_CONFIG;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const SLIPPAGE_BPS = 200n; // 2%

  const LAUNCHPAD_ABI = [
    "function createToken(string name,string symbol,string metadataURI,uint256 minTokensOut) payable returns (address)",
    "function buy(address token,uint256 minTokensOut) payable returns (uint256)",
    "function sell(address token,uint256 tokenAmount,uint256 minNativeOut) returns (uint256)",
    "function claimCreatorFees()",
    "function allTokensLength() view returns (uint256)",
    "function getTokens(uint256 offset,uint256 limit) view returns (address[])",
    "function getPool(address token) view returns (tuple(address creator,uint64 createdAt,bool graduated,address pair,uint256 virtualNative,uint256 virtualToken,uint256 realNative,uint256 tokensSold,uint256 curveSupply,uint256 initialVirtualNative))",
    "function currentPrice(address token) view returns (uint256)",
    "function progressBps(address token) view returns (uint256)",
    "function quoteBuy(address token,uint256 grossIn) view returns (uint256 tokensOut,uint256 fee,uint256 spent,uint256 refund)",
    "function quoteSell(address token,uint256 tokenAmount) view returns (uint256 nativeOut,uint256 fee)",
    "function nativeToGraduate(address token) view returns (uint256)",
    "function creationFee() view returns (uint256)",
    "function tradeFeeBps() view returns (uint256)",
    "function creatorFeesAccrued(address) view returns (uint256)",
    "function wrappedNative() view returns (address)",
    "event TokenCreated(address indexed token,address indexed creator,string name,string symbol,string metadataURI,address pair,uint256 virtualNative,uint256 virtualToken,uint256 curveSupply)",
    "event Trade(address indexed token,address indexed trader,bool isBuy,uint256 nativeAmount,uint256 tokenAmount,uint256 fee,uint256 virtualNative,uint256 virtualToken,uint256 timestamp)",
  ];
  const TOKEN_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function metadataURI() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];
  const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])",
    "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[])",
    "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[])",
  ];

  const readProvider = new ethers.JsonRpcProvider(CFG.rpcUrl, CFG.chainId, { staticNetwork: true });
  const readLaunchpad = new ethers.Contract(CFG.launchpad, LAUNCHPAD_ABI, readProvider);
  let signer = null;
  let account = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const fmt = (v, d = 4) => {
    const n = Number(ethers.formatEther(v));
    if (n === 0) return "0";
    if (n < 1e-6) return n.toExponential(2);
    return n.toLocaleString("en-US", { maximumFractionDigits: d });
  };
  const fmtBig = (v) => {
    const n = Number(ethers.formatEther(v));
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toFixed(2);
  };
  const explorerLink = (kind, v) => (CFG.explorer ? `${CFG.explorer}/${kind}/${v}` : "#");
  const safeUrl = (u) => {
    if (!u) return "";
    if (u.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + u.slice(7);
    try {
      const url = new URL(u);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  };

  function banner(msg, ok = false) {
    const b = $("#banner");
    if (!msg) return b.classList.add("hidden");
    b.textContent = msg;
    b.classList.toggle("ok", ok);
    b.classList.remove("hidden");
  }

  function errMsg(e) {
    return e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);
  }

  const metaCache = new Map();
  async function loadMetadata(uri) {
    if (!uri) return {};
    if (metaCache.has(uri)) return metaCache.get(uri);
    let meta = {};
    try {
      if (uri.startsWith("data:application/json;base64,")) {
        const bin = atob(uri.split(",")[1]);
        meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      } else {
        const url = safeUrl(uri);
        if (url) meta = await (await fetch(url)).json();
      }
    } catch {
      meta = {};
    }
    metaCache.set(uri, meta);
    return meta;
  }

  function encodeMetadata(obj) {
    const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
    const bytes = new TextEncoder().encode(JSON.stringify(clean));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return "data:application/json;base64," + btoa(bin);
  }

  function avatar(meta, symbol, cls = "") {
    const img = safeUrl(meta.image);
    return img
      ? `<img class="avatar ${cls}" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<div class="avatar ${cls}">${esc((symbol || "?").slice(0, 3))}</div>`;
  }

  // ---------- wallet ----------
  async function connect() {
    if (!window.ethereum) return banner("Wallet EVM (MetaMask/Rabby) tidak ditemukan.");
    try {
      const bp = new ethers.BrowserProvider(window.ethereum);
      await bp.send("eth_requestAccounts", []);
      await ensureChain();
      signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
      account = await signer.getAddress();
      $("#connectBtn").textContent = short(account);
      banner("");
      route();
    } catch (e) {
      banner(errMsg(e));
    }
  }

  async function ensureChain() {
    const hex = "0x" + CFG.chainId.toString(16);
    const current = await window.ethereum.request({ method: "eth_chainId" });
    if (current === hex) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: CFG.chainName,
            nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
            rpcUrls: [CFG.rpcUrl],
            blockExplorerUrls: CFG.explorer ? [CFG.explorer] : [],
          },
        ],
      });
    }
  }

  function writeLaunchpad() {
    if (!signer) throw new Error("Hubungkan wallet terlebih dahulu.");
    return new ethers.Contract(CFG.launchpad, LAUNCHPAD_ABI, signer);
  }

  // ---------- views ----------
  async function viewList() {
    app.innerHTML = `<div class="empty">Memuat token…</div>`;
    const len = Number(await readLaunchpad.allTokensLength());
    if (len === 0) {
      app.innerHTML = `<div class="empty">Belum ada token. <a href="#/create" class="btn btn-primary">Launch yang pertama</a></div>`;
      return;
    }
    const start = Math.max(0, len - 60);
    const addrs = (await readLaunchpad.getTokens(start, 60)).slice().reverse();
    const rows = await Promise.all(
      addrs.map(async (addr) => {
        const t = new ethers.Contract(addr, TOKEN_ABI, readProvider);
        const [name, symbol, uri, pool, progress, price] = await Promise.all([
          t.name(),
          t.symbol(),
          t.metadataURI(),
          readLaunchpad.getPool(addr),
          readLaunchpad.progressBps(addr),
          readLaunchpad.currentPrice(addr),
        ]);
        const meta = await loadMetadata(uri);
        return { addr, name, symbol, pool, progress, price, meta };
      })
    );
    app.innerHTML = `<h2>Token terbaru</h2><div class="grid">${rows
      .map((r) => {
        const pct = Number(r.progress) / 100;
        const mcap = r.price * 1_000_000_000n; // price per whole token x 1B supply
        return `<a class="card" href="#/token/${r.addr}">
          ${avatar(r.meta, r.symbol)}
          <div style="flex:1;min-width:0">
            <h3>${esc(r.name)} <span class="muted">$${esc(r.symbol)}</span>${r.pool.graduated ? '<span class="tag">DEX</span>' : ""}</h3>
            <div class="muted">by ${short(r.pool.creator)} · MC ${fmt(mcap, 2)} HYPE</div>
            <div class="progress"><div style="width:${pct}%"></div></div>
            <div class="muted">${pct.toFixed(1)}% bonding curve</div>
          </div></a>`;
      })
      .join("")}</div>`;
  }

  async function viewCreate() {
    let feeTxt = "";
    try {
      const f = await readLaunchpad.creationFee();
      feeTxt = f > 0n ? `Biaya pembuatan: ${fmt(f)} HYPE. ` : "Tanpa biaya pembuatan. ";
    } catch {}
    app.innerHTML = `<div class="panel" style="max-width:640px;margin:0 auto">
      <h2 style="margin-top:0">Launch token baru</h2>
      <p class="muted">${esc(feeTxt)}Supply tetap 1B, 80% dijual di bonding curve, sisanya otomatis masuk DEX (LP dikunci) saat curve penuh.</p>
      <form id="createForm">
        <label>Nama</label><input name="name" maxlength="32" required />
        <label>Ticker</label><input name="symbol" maxlength="12" required style="text-transform:uppercase" />
        <label>URL gambar (https:// atau ipfs://)</label><input name="image" />
        <label>Deskripsi</label><textarea name="description" maxlength="280"></textarea>
        <label>Website</label><input name="website" />
        <label>X / Twitter</label><input name="twitter" />
        <label>Telegram</label><input name="telegram" />
        <label>Dev buy (HYPE, opsional)</label><input name="devBuy" type="number" min="0" step="any" placeholder="0" />
        <div style="margin-top:16px"><button class="btn btn-primary" type="submit">Launch</button></div>
      </form></div>`;

    $("#createForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const btn = ev.target.querySelector("button");
      try {
        const lp = writeLaunchpad();
        const uri = encodeMetadata({
          description: fd.get("description"),
          image: fd.get("image"),
          website: fd.get("website"),
          twitter: fd.get("twitter"),
          telegram: fd.get("telegram"),
        });
        if (uri.length > 1024) throw new Error("Metadata terlalu panjang; persingkat deskripsi/URL atau pakai IPFS.");
        const fee = await readLaunchpad.creationFee();
        const devBuy = fd.get("devBuy") ? ethers.parseEther(String(fd.get("devBuy"))) : 0n;
        btn.disabled = true;
        btn.textContent = "Mengirim…";
        const tx = await lp.createToken(String(fd.get("name")).trim(), String(fd.get("symbol")).trim().toUpperCase(), uri, 0n, {
          value: fee + devBuy,
        });
        banner("Transaksi dikirim: " + tx.hash, true);
        const rc = await tx.wait();
        const ev2 = rc.logs.map((l) => { try { return lp.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenCreated");
        location.hash = ev2 ? `#/token/${ev2.args.token}` : "#/";
        banner("Token berhasil dibuat!", true);
      } catch (e) {
        banner(errMsg(e));
      } finally {
        btn.disabled = false;
        btn.textContent = "Launch";
      }
    });
  }

  async function viewToken(addr) {
    if (!ethers.isAddress(addr)) return (app.innerHTML = `<div class="empty">Alamat tidak valid.</div>`);
    app.innerHTML = `<div class="empty">Memuat…</div>`;
    const t = new ethers.Contract(addr, TOKEN_ABI, readProvider);
    const [name, symbol, uri, pool, progress, price, toGrad, feeBps] = await Promise.all([
      t.name(),
      t.symbol(),
      t.metadataURI(),
      readLaunchpad.getPool(addr),
      readLaunchpad.progressBps(addr),
      readLaunchpad.currentPrice(addr),
      readLaunchpad.nativeToGraduate(addr),
      readLaunchpad.tradeFeeBps(),
    ]);
    const meta = await loadMetadata(uri);
    const [bal, creatorFees] = account
      ? await Promise.all([t.balanceOf(account), readLaunchpad.creatorFeesAccrued(account)])
      : [0n, 0n];
    const pct = Number(progress) / 100;
    const links = ["website", "twitter", "telegram"]
      .map((k) => (safeUrl(meta[k]) ? `<a href="${esc(safeUrl(meta[k]))}" target="_blank" rel="noopener">${k}</a>` : ""))
      .join("");

    app.innerHTML = `<div class="two-col">
      <div>
        <div class="panel">
          <div class="head">${avatar(meta, symbol, "lg")}
            <div><h1>${esc(name)} <span class="muted">$${esc(symbol)}</span>${pool.graduated ? '<span class="tag">Graduated</span>' : ""}</h1>
            <div class="muted">CA: <a href="${esc(explorerLink("address", addr))}" target="_blank" rel="noopener">${addr}</a></div>
            <div class="muted">Creator: ${short(pool.creator)}</div>
            <div class="links">${links}</div></div>
          </div>
          <p>${esc(meta.description || "")}</p>
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="muted">${pct.toFixed(2)}% bonding curve ${pool.graduated ? "· sudah listing di DEX" : `· ${fmt(toGrad)} HYPE lagi menuju graduation`}</div>
          <div class="stats">
            <div class="stat"><span class="muted">Harga</span><b>${fmt(price, 10)} HYPE</b></div>
            <div class="stat"><span class="muted">Market cap</span><b>${fmt(price * 1_000_000_000n, 2)} HYPE</b></div>
            <div class="stat"><span class="muted">HYPE di curve</span><b>${fmt(pool.realNative, 3)}</b></div>
            <div class="stat"><span class="muted">Terjual</span><b>${fmtBig(pool.tokensSold)} / ${fmtBig(pool.curveSupply)}</b></div>
          </div>
          ${pool.graduated ? `<div class="muted">Pair DEX: <a href="${esc(explorerLink("address", pool.pair))}" target="_blank" rel="noopener">${pool.pair}</a></div>` : ""}
        </div>
        <div class="panel" style="margin-top:16px"><h3 style="margin-top:0">Trade terakhir</h3><div id="trades" class="muted">Memuat…</div></div>
      </div>
      <div>
        <div class="panel">
          ${pool.graduated && !CFG.router
            ? `<p>Token ini sudah graduate. Trading sekarang di DEX (pair <code>${short(pool.pair)}</code>).</p>`
            : `${pool.graduated ? `<p class="muted">Sudah graduate — trade lewat DEX (Uniswap V2).</p>` : ""}
               <div class="tabs"><button class="btn active buy" data-side="buy">Buy</button><button class="btn sell" data-side="sell">Sell</button></div>
               <label id="amtLabel">Jumlah HYPE</label>
               <input id="amt" type="number" min="0" step="any" placeholder="0.0" />
               <div class="quote" id="quote"></div>
               <button id="tradeBtn" class="btn btn-buy" style="width:100%">Buy</button>
               <p class="muted">${pool.graduated ? "Fee LP DEX 0.3%" : `Fee trading ${Number(feeBps) / 100}%`} · slippage ${Number(SLIPPAGE_BPS) / 100}%</p>`}
          ${account ? `<p class="muted">Saldo kamu: ${fmt(bal)} ${esc(symbol)}</p>` : `<p class="muted">Hubungkan wallet untuk trading.</p>`}
          ${account && creatorFees > 0n ? `<button id="claimBtn" class="btn" style="width:100%">Klaim creator fee (${fmt(creatorFees)} HYPE)</button>` : ""}
        </div>
      </div></div>`;

    loadTrades(addr, symbol);
    if (!pool.graduated) bindTrade(symbol, curveVenue(addr, symbol), addr);
    else if (CFG.router) bindTrade(symbol, await dexVenue(addr, symbol), addr);
    const claim = $("#claimBtn");
    if (claim)
      claim.onclick = () =>
        send(async () => writeLaunchpad().claimCreatorFees(), () => viewToken(addr));
  }

  const withSlippage = (q) => (q * (10_000n - SLIPPAGE_BPS)) / 10_000n;

  // Bonding-curve venue (before graduation).
  function curveVenue(addr, symbol) {
    return {
      async quote(side, v) {
        if (side === "buy") {
          const q = await readLaunchpad.quoteBuy(addr, v);
          return {
            out: q.tokensOut,
            text: `≈ ${fmt(q.tokensOut, 2)} ${symbol} · fee ${fmt(q.fee)} HYPE${q.refund > 0n ? ` · refund ${fmt(q.refund)} HYPE (curve penuh → graduation)` : ""}`,
          };
        }
        const q = await readLaunchpad.quoteSell(addr, v);
        return { out: q.nativeOut, text: `≈ ${fmt(q.nativeOut)} HYPE · fee ${fmt(q.fee)} HYPE` };
      },
      async exec(side, v, out) {
        const lp = writeLaunchpad();
        return side === "buy" ? lp.buy(addr, withSlippage(out), { value: v }) : lp.sell(addr, v, withSlippage(out));
      },
    };
  }

  // Uniswap V2 venue (after graduation).
  async function dexVenue(addr, symbol) {
    const whype = await readLaunchpad.wrappedNative();
    const readRouter = new ethers.Contract(CFG.router, ROUTER_ABI, readProvider);
    const pathFor = (side) => (side === "buy" ? [whype, addr] : [addr, whype]);
    return {
      async quote(side, v) {
        const amounts = await readRouter.getAmountsOut(v, pathFor(side));
        const out = amounts[amounts.length - 1];
        return { out, text: side === "buy" ? `≈ ${fmt(out, 2)} ${symbol} (DEX)` : `≈ ${fmt(out)} HYPE (DEX)` };
      },
      async exec(side, v, out) {
        if (!signer) throw new Error("Hubungkan wallet terlebih dahulu.");
        const router = new ethers.Contract(CFG.router, ROUTER_ABI, signer);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        if (side === "buy") {
          return router.swapExactETHForTokens(withSlippage(out), pathFor(side), account, deadline, { value: v });
        }
        const token = new ethers.Contract(addr, TOKEN_ABI, signer);
        if ((await token.allowance(account, CFG.router)) < v) {
          banner("Approve token untuk router…", true);
          await (await token.approve(CFG.router, v)).wait();
        }
        return router.swapExactTokensForETH(v, withSlippage(out), pathFor(side), account, deadline);
      },
    };
  }

  function bindTrade(symbol, venue, addr) {
    let side = "buy";
    const amt = $("#amt");
    const quoteEl = $("#quote");
    const btn = $("#tradeBtn");
    let lastQuote = null;

    document.querySelectorAll(".tabs .btn").forEach((b) => {
      b.onclick = () => {
        side = b.dataset.side;
        document.querySelectorAll(".tabs .btn").forEach((x) => x.classList.toggle("active", x === b));
        $("#amtLabel").textContent = side === "buy" ? "Jumlah HYPE" : `Jumlah ${symbol}`;
        btn.textContent = side === "buy" ? "Buy" : "Sell";
        btn.className = `btn ${side === "buy" ? "btn-buy" : "btn-sell"}`;
        btn.style.width = "100%";
        amt.value = "";
        quoteEl.textContent = "";
        lastQuote = null;
      };
    });

    let timer;
    amt.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        lastQuote = null;
        if (!amt.value || Number(amt.value) <= 0) return (quoteEl.textContent = "");
        try {
          const v = ethers.parseEther(amt.value);
          const q = await venue.quote(side, v);
          lastQuote = { side, v, out: q.out };
          quoteEl.textContent = q.text;
        } catch (e) {
          quoteEl.textContent = errMsg(e);
        }
      }, 250);
    };

    btn.onclick = () =>
      send(
        async () => {
          if (!amt.value) throw new Error("Masukkan jumlah.");
          const v = ethers.parseEther(amt.value);
          const out =
            lastQuote && lastQuote.side === side && lastQuote.v === v ? lastQuote.out : (await venue.quote(side, v)).out;
          return venue.exec(side, v, out);
        },
        () => viewToken(addr)
      );
  }

  async function send(makeTx, after) {
    try {
      const tx = await makeTx();
      banner("Menunggu konfirmasi: " + tx.hash, true);
      await tx.wait();
      banner("Transaksi sukses ✓", true);
      after && after();
    } catch (e) {
      banner(errMsg(e));
    }
  }

  async function loadTrades(addr, symbol) {
    const el = $("#trades");
    try {
      const latest = await readProvider.getBlockNumber();
      const from = Math.max(Number(CFG.deployBlock || 0), latest - 50_000);
      const logs = await readLaunchpad.queryFilter(readLaunchpad.filters.Trade(addr), from, latest);
      if (!logs.length) return (el.textContent = "Belum ada trade.");
      el.innerHTML = `<table><tr><th>Tipe</th><th>Trader</th><th>HYPE</th><th>${esc(symbol)}</th><th>Waktu</th></tr>${logs
        .slice(-25)
        .reverse()
        .map((l) => {
          const a = l.args;
          const time = new Date(Number(a.timestamp) * 1000).toLocaleString();
          return `<tr><td class="${a.isBuy ? "buy-c" : "sell-c"}">${a.isBuy ? "Buy" : "Sell"}</td><td>${short(a.trader)}</td><td>${fmt(a.nativeAmount)}</td><td>${fmtBig(a.tokenAmount)}</td><td>${esc(time)}</td></tr>`;
        })
        .join("")}</table>`;
    } catch (e) {
      el.textContent = "Gagal memuat trade: " + errMsg(e);
    }
  }

  // ---------- router ----------
  async function route() {
    const h = location.hash || "#/";
    try {
      if (CFG.launchpad === ZERO) {
        app.innerHTML = `<div class="empty">Alamat launchpad belum diisi di <code>config.js</code>.</div>`;
        return;
      }
      if (h.startsWith("#/create")) return await viewCreate();
      if (h.startsWith("#/token/")) return await viewToken(h.slice(8));
      return await viewList();
    } catch (e) {
      app.innerHTML = `<div class="empty">Error: ${esc(errMsg(e))}</div>`;
    }
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
