// Read-only REST API over the indexed data (JSON, CORS-enabled, no auth).
//
//   GET /health                               sync status
//   GET /tokens?sort=new|mcap|volume|trades&quote=&creator=&q=&limit=&offset=
//   GET /tokens/:address                      one token with stats
//   GET /tokens/:address/trades?limit=&before=<block>:<logIndex>
//   GET /tokens/:address/candles?interval=1m|5m|15m|1h|4h|1d&limit=
//   GET /tokens/:address/holders?limit=
//   GET /integrators
//   GET /stats
//   POST /upload                              token image (PNG/JPEG/WebP/GIF, raw body) → { url }
//   GET /images/:sha256[.ext]                 an uploaded image
//
// Amounts are decimal strings in human units (token: 18 decimals; quote: its own decimals). Prices are quote per
// token. Market cap = price × 1,000,000,000 (fixed supply). Sorting by mcap/volume compares raw numbers, so it is
// only meaningful within one quote (use ?quote=).
const http = require("http");
const crypto = require("crypto");
const { ethers } = require("ethers");

const SUPPLY = 10n ** 27n;
const DEAD = "0x000000000000000000000000000000000000dead";
const INTERVALS = { "1m": "1 minute", "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour", "4h": "4 hours", "1d": "1 day" };
const ATTRIBUTION = ["none", "caller", "signed"];

// Accepted image formats, recognised by their leading bytes (never by the client's content-type). SVG is refused:
// it can carry script.
const IMAGE_TYPES = [
  { mime: "image/png", ext: "png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", test: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
  { mime: "image/webp", ext: "webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const clampInt = (v, def, min, max) => {
  const n = v === undefined || v === null || v === "" ? def : Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, "bad integer parameter");
  return Math.max(min, Math.min(max, n));
};

function createApi(cfg, pool, indexer) {
  const A = cfg.addresses;
  const protocolHolders = [ethers.ZeroAddress, DEAD, A.poolManager, A.hook, A.core, A.router, A.vault, A.distributor]
    .filter(Boolean).map((a) => a.toLowerCase());
  const labels = new Map([[A.poolManager, "pool (PoolManager)"], [A.hook, "hook"], [DEAD, "burned"], [A.vault, "vesting vault"],
    [A.core, "launch core"], [A.router, "app router"], [A.distributor, "fee distributor"]].filter(([a]) => a));

  let quoteCache = new Map();
  /** Quote symbols/decimals; reloads when asked for a quote it doesn't know yet (e.g. right after a first sync). */
  async function quotes(need = []) {
    if (quoteCache.size === 0 || need.some((a) => !quoteCache.has(a))) {
      const { rows } = await pool.query("select address, symbol, decimals from quotes");
      quoteCache = new Map(rows.map((r) => [r.address, { symbol: r.symbol, decimals: Number(r.decimals) }]));
      if (!quoteCache.has(ethers.ZeroAddress)) quoteCache.set(ethers.ZeroAddress, { symbol: "HYPE", decimals: 18 });
    }
    return quoteCache;
  }
  setInterval(() => { quoteCache = new Map(); }, 60_000).unref();

  const fmt = (v, dec) => (v === null || v === undefined ? null : ethers.formatUnits(BigInt(v), dec));

  const TOKEN_SELECT = `
    select t.*, i.name as integrator_name, i.account as integrator_account, i.verified as integrator_verified, i.uri as integrator_uri,
      coalesce(v.volume24h, 0) as volume24h, coalesce(v.trades24h, 0) as trades24h,
      (select count(*) from swaps s where s.token = t.address) as trades_total,
      (select count(*) from balances b where b.token = t.address and b.balance > 0 and b.holder <> all($1::text[])) as holders,
      p.price_24h
    from tokens t
    left join integrators i on i.id = t.integrator_id
    left join lateral (select sum(quote_amount) as volume24h, count(*) as trades24h from swaps s
                       where s.token = t.address and s.ts > now() - interval '24 hours') v on true
    left join lateral (select price as price_24h from swaps s where s.token = t.address and s.ts <= now() - interval '24 hours'
                       order by block desc, log_index desc limit 1) p on true`;

  function tokenJson(r, Q) {
    const q = Q.get(r.quote) || { symbol: "?", decimals: 18 };
    const price = r.last_price ?? r.init_price;
    const ref = r.price_24h ?? r.init_price;
    const devBps = Number((BigInt(r.dev_buy_tokens) * 1_000_000n) / SUPPLY) / 100; // in bps, 2 decimals
    return {
      address: r.address, launchId: Number(r.launch_id), poolId: r.pool_id,
      name: r.name, symbol: r.symbol, image: r.image, description: r.description, metadataURI: r.metadata_uri,
      creator: r.creator, caller: r.caller, attribution: ATTRIBUTION[r.attribution] ?? String(r.attribution),
      integrator: r.integrator_id ? { id: r.integrator_id, name: r.integrator_name, account: r.integrator_account,
        uri: r.integrator_uri, verified: !!r.integrator_verified } : null,
      quote: { address: r.quote, symbol: q.symbol, decimals: q.decimals },
      presetId: r.preset_id,
      split: { protocolBps: r.protocol_bps, integratorBps: r.integrator_bps, creatorBps: r.creator_bps },
      allocation: { bps: r.alloc_bps, instant: r.instant_allocation, cliff: r.cliff, duration: r.duration },
      devBuy: { tokens: fmt(r.dev_buy_tokens, 18), supplyBps: devBps, quoteSpent: fmt(r.dev_buy_quote_spent, q.decimals), lock: r.dev_buy_lock },
      launchedAt: r.ts, launchBlock: Number(r.block), launchTx: r.tx,
      price, marketCap: price != null ? price * 1e9 : null,
      priceChange24h: price != null && ref ? (price / ref - 1) * 100 : null,
      volume24h: fmt(r.volume24h, q.decimals), trades24h: Number(r.trades24h), tradesTotal: Number(r.trades_total),
      holders: Number(r.holders), lastTradeAt: r.last_trade_at,
    };
  }

  const hidden = cfg.hiddenTokens || [];

  async function listTokens(qs) {
    const where = [];
    const params = [protocolHolders];
    const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (hidden.length) add("t.address <> all(?::text[])", hidden);
    if (qs.get("quote")) {
      const q = qs.get("quote").toLowerCase();
      if (q === "hype") add("t.quote = ?", ethers.ZeroAddress);
      else if (isAddr(q)) add("t.quote = ?", q);
      else if (q === "usdc" && A.usdc) add("t.quote = ?", A.usdc);
      else throw new HttpError(400, "quote must be an address, hype or usdc");
    }
    if (qs.get("creator")) {
      if (!isAddr(qs.get("creator"))) throw new HttpError(400, "bad creator");
      add("t.creator = ?", qs.get("creator").toLowerCase());
    }
    if (qs.get("integrator")) add("t.integrator_id = ?", clampInt(qs.get("integrator"), 0, 0, 2 ** 31));
    if (qs.get("q")) {
      const term = qs.get("q").slice(0, 64);
      if (isAddr(term)) add("t.address = ?", term.toLowerCase());
      else add("(t.name ilike ? or t.symbol ilike $" + (params.length + 1) + ")", `%${term.replace(/[%_\\]/g, "\\$&")}%`);
    }
    const order = { new: "t.block desc", mcap: "coalesce(t.last_price, t.init_price) desc nulls last, t.block desc",
      volume: "volume24h desc, t.block desc", trades: "trades_total desc, t.block desc" }[qs.get("sort") || "new"];
    if (!order) throw new HttpError(400, "sort must be new, mcap, volume or trades");
    const limit = clampInt(qs.get("limit"), 50, 1, 100);
    const offset = clampInt(qs.get("offset"), 0, 0, 100_000);
    const sql = `select * from (${TOKEN_SELECT} ${where.length ? "where " + where.join(" and ") : ""}) t
                 order by ${order} limit ${limit} offset ${offset}`;
    const { rows } = await pool.query(sql, params);
    const Q = await quotes(rows.map((r) => r.quote));
    return { tokens: rows.map((r) => tokenJson(r, Q)), limit, offset };
  }

  async function getToken(address) {
    const { rows } = await pool.query(`${TOKEN_SELECT} where t.address = $2`, [protocolHolders, address]);
    if (!rows.length) throw new HttpError(404, "token not indexed");
    const Q = await quotes([rows[0].quote]);
    const token = tokenJson(rows[0], Q);
    const { rows: f } = await pool.query(
      `select currency, sum(amount) as amount, sum(to_protocol) as to_protocol, sum(to_integrator) as to_integrator,
              sum(to_creator) as to_creator from fees where pool_id = $1 group by currency`, [rows[0].pool_id]);
    token.feesCollected = f.map((x) => {
      const dec = x.currency === address ? 18 : (Q.get(x.currency)?.decimals ?? 18);
      return { currency: x.currency, amount: fmt(x.amount, dec), toProtocol: fmt(x.to_protocol, dec),
        toIntegrator: fmt(x.to_integrator, dec), toCreator: fmt(x.to_creator, dec) };
    });
    return token;
  }

  async function tokenRow(address) {
    const { rows } = await pool.query("select address, quote from tokens where address = $1", [address]);
    if (!rows.length) throw new HttpError(404, "token not indexed");
    const Q = await quotes([rows[0].quote]);
    return { ...rows[0], qdec: Q.get(rows[0].quote)?.decimals ?? 18 };
  }

  async function trades(address, qs) {
    const t = await tokenRow(address);
    const limit = clampInt(qs.get("limit"), 50, 1, 200);
    const params = [address];
    let cursor = "";
    if (qs.get("before")) {
      const m = /^(\d+):(\d+)$/.exec(qs.get("before"));
      if (!m) throw new HttpError(400, "before must be <block>:<logIndex>");
      params.push(m[1], m[2]);
      cursor = "and (block, log_index) < ($2::bigint, $3::int)";
    }
    const { rows } = await pool.query(
      `select * from swaps where token = $1 ${cursor} order by block desc, log_index desc limit ${limit}`, params);
    const inDec = (r) => (r.side === "buy" ? t.qdec : 18);
    const outDec = (r) => (r.side === "buy" ? 18 : t.qdec);
    return {
      trades: rows.map((r) => ({
        tx: r.tx, logIndex: r.log_index, block: Number(r.block), ts: r.ts, kind: r.kind, side: r.side,
        trader: r.trader ?? r.sender, sender: r.sender,
        tokenAmount: fmt(r.token_amount, 18), quoteAmount: fmt(r.quote_amount, t.qdec),
        userAmountIn: fmt(r.user_amount_in, inDec(r)), userAmountOut: fmt(r.user_amount_out, outDec(r)),
        price: r.price, fee: r.fee,
      })),
      next: rows.length === limit ? `${rows[rows.length - 1].block}:${rows[rows.length - 1].log_index}` : null,
    };
  }

  async function candles(address, qs) {
    const t = await tokenRow(address);
    const interval = INTERVALS[qs.get("interval") || "5m"];
    if (!interval) throw new HttpError(400, `interval must be one of ${Object.keys(INTERVALS).join(", ")}`);
    const limit = clampInt(qs.get("limit"), 200, 1, 1000);
    const { rows } = await pool.query(
      `select * from (
         select date_bin($2::interval, ts, timestamptz '2000-01-01') as t,
           (array_agg(price order by block, log_index))[1] as open, max(price) as high, min(price) as low,
           (array_agg(price order by block desc, log_index desc))[1] as close,
           sum(quote_amount) as volume, count(*) as trades
         from swaps where token = $1 group by 1 order by 1 desc limit ${limit}) c order by t`,
      [address, interval]);
    // Each candle opens at the previous close, so the series has no gaps between buckets.
    const out = rows.map((r) => ({ t: r.t, open: r.open, high: r.high, low: r.low, close: r.close,
      volume: fmt(r.volume, t.qdec), trades: Number(r.trades) }));
    for (let i = 1; i < out.length; i++) {
      const c = out[i];
      c.open = out[i - 1].close;
      c.high = Math.max(c.high, c.open);
      c.low = Math.min(c.low, c.open);
    }
    return { interval: qs.get("interval") || "5m", candles: out };
  }

  async function holders(address, qs) {
    await tokenRow(address);
    const limit = clampInt(qs.get("limit"), 50, 1, 200);
    const { rows } = await pool.query(
      `select holder, balance from balances where token = $1 and balance > 0 order by balance desc limit ${limit}`, [address]);
    const { rows: c } = await pool.query(
      "select count(*) as n from balances where token = $1 and balance > 0 and holder <> all($2::text[])", [address, protocolHolders]);
    return {
      holders: Number(c[0].n),
      top: rows.map((r) => ({
        address: r.holder, balance: fmt(r.balance, 18), supplyPct: Number((BigInt(r.balance) * 1_000_000n) / SUPPLY) / 10_000,
        label: labels.get(r.holder) || null, protocol: protocolHolders.includes(r.holder),
      })),
    };
  }

  async function integrators() {
    const { rows } = await pool.query(
      `select i.*, (select count(*) from tokens t where t.integrator_id = i.id and t.address <> all($1::text[])) as launches
       from integrators i order by i.id`, [hidden]);
    return { integrators: rows.map((r) => ({ id: r.id, name: r.name, uri: r.uri, account: r.account, payout: r.payout,
      verified: r.verified, suspended: r.suspended, launches: Number(r.launches) })) };
  }

  async function stats() {
    const { rows: [t] } = await pool.query(
      `select (select count(*) from tokens where address <> all($1::text[])) as tokens,
              (select count(*) from swaps where token <> all($1::text[])) as trades,
              (select count(distinct coalesce(trader, sender)) from swaps where token <> all($1::text[])) as traders`, [hidden]);
    const { rows: v } = await pool.query(
      `select t.quote, sum(s.quote_amount) as volume, count(*) as trades from swaps s join tokens t on t.address = s.token
       where s.ts > now() - interval '24 hours' and s.token <> all($1::text[]) group by t.quote`, [hidden]);
    const Q = await quotes(v.map((r) => r.quote));
    return {
      tokens: Number(t.tokens), trades: Number(t.trades), traders: Number(t.traders),
      volume24h: v.map((r) => ({ quote: r.quote, symbol: Q.get(r.quote)?.symbol ?? "?",
        volume: fmt(r.volume, Q.get(r.quote)?.decimals ?? 18), trades: Number(r.trades) })),
    };
  }

  // ------------------------------------------------------------------------------------- images
  const uploadLog = new Map(); // client ip -> timestamps of recent uploads
  setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [ip, ts] of uploadLog) {
      const keep = ts.filter((t) => t > cutoff);
      if (keep.length) uploadLog.set(ip, keep); else uploadLog.delete(ip);
    }
  }, 600_000).unref();

  const clientIp = (req) => String(req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "").trim();

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > limit) return reject(new HttpError(413, `image too large (max ${limit} bytes)`));
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (c) => {
        if (over) return; // keep draining so the 413 response can still be delivered
        size += c.length;
        if (size > limit) { over = true; chunks.length = 0; reject(new HttpError(413, `image too large (max ${limit} bytes)`)); return; }
        chunks.push(c);
      });
      req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
      req.on("error", reject);
    });
  }

  async function upload(req) {
    if (!cfg.uploadsEnabled) throw new HttpError(404, "uploads disabled");
    const origin = req.headers.origin || "";
    if (cfg.uploadOrigins.length && !cfg.uploadOrigins.includes(origin)) throw new HttpError(403, "origin not allowed");
    const ip = clientIp(req);
    const recent = (uploadLog.get(ip) || []).filter((t) => t > Date.now() - 3600_000);
    if (recent.length >= cfg.uploadsPerHour) throw new HttpError(429, "too many uploads, try again later");
    const body = await readBody(req, cfg.maxUploadBytes);
    const type = IMAGE_TYPES.find((t) => t.test(body));
    if (!type) throw new HttpError(415, "only PNG, JPEG, WebP or GIF images are accepted");
    const { rows: [u] } = await pool.query("select coalesce(sum(size), 0)::bigint as used from images");
    if (Number(u.used) + body.length > cfg.maxImageStorageBytes) throw new HttpError(507, "image storage is full");
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    await pool.query("insert into images (sha256, mime, size, bytes) values ($1,$2,$3,$4) on conflict (sha256) do nothing",
      [sha256, type.mime, body.length, body]);
    recent.push(Date.now());
    uploadLog.set(ip, recent);
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
    const base = cfg.publicUrl || `${proto}://${req.headers.host}`;
    return { url: `${base}/images/${sha256}.${type.ext}`, sha256, mime: type.mime, size: body.length };
  }

  async function serveImage(req, res, hash, headers) {
    const { rows } = await pool.query("select mime, bytes from images where sha256 = $1", [hash]);
    if (!rows.length) throw new HttpError(404, "image not found");
    res.writeHead(200, {
      "access-control-allow-origin": "*",
      "content-type": rows[0].mime,
      "content-length": rows[0].bytes.length,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      etag: `"${hash}"`,
    });
    res.end(req.method === "HEAD" ? undefined : rows[0].bytes);
  }

  async function route(method, url) {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const qs = url.searchParams;
    if (p === "/" || p === "/health") {
      const s = indexer ? indexer.status() : null;
      return { ok: !!s && !s.lastError, service: "provenalt-indexer", sync: s };
    }
    if (p === "/tokens") return listTokens(qs);
    if (p === "/integrators") return integrators();
    if (p === "/stats") return stats();
    const m = /^\/tokens\/(0x[0-9a-fA-F]{40})(?:\/(trades|candles|holders))?$/.exec(p);
    if (m) {
      const addr = m[1].toLowerCase();
      if (!m[2]) return getToken(addr);
      if (m[2] === "trades") return trades(addr, qs);
      if (m[2] === "candles") return candles(addr, qs);
      return holders(addr, qs);
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer(async (req, res) => {
    const headers = {
      "access-control-allow-origin": cfg.corsOrigin, "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type", "content-type": "application/json; charset=utf-8",
    };
    if (req.method === "OPTIONS") { res.writeHead(204, headers); return res.end(); }
    let status = 200;
    let body;
    try {
      const url = new URL(req.url, "http://localhost");
      const img = /^\/images\/([0-9a-f]{64})(?:\.(?:png|jpg|gif|webp))?$/.exec(url.pathname);
      if (img && (req.method === "GET" || req.method === "HEAD")) return await serveImage(req, res, img[1], headers);
      if (url.pathname === "/upload") {
        if (req.method !== "POST") throw new HttpError(405, "use POST");
        body = await upload(req);
        status = 201;
      } else {
        body = await route(req.method, url);
        headers["cache-control"] = "public, max-age=2";
      }
    } catch (e) {
      status = e.status || 500;
      body = { error: status === 500 ? "internal error" : e.message };
      if (status === 500) console.error("[api]", e);
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  });
  return server;
}

module.exports = { createApi };
