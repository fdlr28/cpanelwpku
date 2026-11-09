// End-to-end check: index a chain, then compare the database and the API with on-chain state.
//   DATABASE_URL=postgres://... RPC_URL=http://127.0.0.1:8545 DEPLOYMENT_FILE=../deployments/localhost-v2.json node test/e2e.js
// Expects a chain with launches and trades (e.g. a local node after scripts/deploy-local-v2.js and
// scripts/smoke-testnet-v2.js). Read-only towards the chain; writes only to the given database.
process.env.CONFIRMATIONS = process.env.CONFIRMATIONS || "0";
const { ethers } = require("ethers");
const { load } = require("../src/config");
const { makePool, migrate } = require("../src/db");
const { makeProvider } = require("../src/rpc");
const { Indexer, priceOf } = require("../src/sync");
const { createApi } = require("../src/api");
const abi = require("../src/abi");

const results = [];
const check = (name, ok, info = "") => {
  results.push(!!ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${info !== "" ? " — " + info : ""}`);
};

async function main() {
  const cfg = load();
  const pool = makePool(cfg);
  await migrate(pool, cfg);
  const provider = makeProvider(cfg);
  const A = cfg.addresses;
  const quiet = { log() {}, warn: console.warn, error: console.error };

  const indexer = new Indexer(cfg, provider, pool, quiet);
  await indexer.init();

  // API up before the first sync, and queried while the database is still empty (as on a fresh Railway deploy).
  const server = createApi(cfg, pool, indexer);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json(), cors: r.headers.get("access-control-allow-origin") };
  };
  await get("/stats");
  await get("/tokens");

  const t0 = Date.now();
  await indexer.syncOnce();
  console.log(`indexed to block ${indexer.cursor} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---------------------------------------------------------------- launches
  const coreC = new ethers.Contract(A.core, ["function launchCount() view returns (uint256)"], provider);
  const launchCount = Number(await coreC.launchCount());
  const { rows: tokens } = await pool.query("select * from tokens order by launch_id");
  check("every launch indexed", tokens.length === launchCount && launchCount > 0, `${tokens.length}/${launchCount}`);

  // ---------------------------------------------------------------- balances vs chain
  let balOk = true;
  let holdersChecked = 0;
  for (const t of tokens) {
    const erc = new ethers.Contract(t.address, ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"], provider);
    const { rows: bals } = await pool.query("select holder, balance from balances where token = $1", [t.address]);
    const sum = bals.reduce((s, b) => s + BigInt(b.balance), 0n);
    if (sum !== (await erc.totalSupply())) { balOk = false; console.log("  supply mismatch", t.symbol, sum); }
    for (const b of bals) {
      holdersChecked++;
      const onchain = await erc.balanceOf(b.holder);
      if (onchain !== BigInt(b.balance)) { balOk = false; console.log("  balance mismatch", t.symbol, b.holder, b.balance, onchain); }
    }
  }
  check("balances match balanceOf for every holder, and sum to totalSupply", balOk, `${holdersChecked} holder rows`);

  // ---------------------------------------------------------------- swaps vs PoolManager events
  const pm = new ethers.Contract(A.poolManager, abi.poolManager, provider);
  const routerC = new ethers.Contract(A.router, abi.router, provider);
  const hook = new ethers.Contract(A.hook, ["function spot(bytes32) view returns (uint160 sqrtPriceX96, int24 tick)"], provider);
  const swappedLogs = await routerC.queryFilter(routerC.filters.Swapped(), cfg.startBlock);
  let swapsOk = true;
  let priceOk = true;
  let devOk = true;
  for (const t of tokens) {
    const logs = await pm.queryFilter(pm.filters.Swap(t.pool_id), cfg.startBlock);
    const { rows: s } = await pool.query("select * from swaps where token = $1 order by block, log_index", [t.address]);
    if (logs.length !== s.length) { swapsOk = false; console.log("  swap count", t.symbol, logs.length, s.length); }
    const spot = await hook.spot(t.pool_id);
    const qdec = t.quote === ethers.ZeroAddress ? 18 : (await pool.query("select decimals from quotes where address=$1", [t.quote])).rows[0].decimals;
    const expect = priceOf(spot.sqrtPriceX96, t.token_is0, Number(qdec));
    if (Math.abs(t.last_price / expect - 1) > 1e-9) { priceOk = false; console.log("  price", t.symbol, t.last_price, expect); }
    if (BigInt(t.dev_buy_tokens) > 0n) {
      const d = s.find((x) => x.kind === "devbuy");
      if (!d || d.trader !== t.creator || d.side !== "buy" || BigInt(d.token_amount) !== BigInt(t.dev_buy_tokens)) {
        devOk = false; console.log("  devbuy", t.symbol, d);
      }
    }
  }
  check("one swap row per PoolManager Swap event", swapsOk);
  check("last price equals the pool's current spot price", priceOk);
  check("dev buys recorded as buys by the creator, exact token amount", devOk);

  let sideOk = swappedLogs.length > 0;
  for (const l of swappedLogs) {
    const { rows } = await pool.query("select * from swaps where tx = $1 and token = $2", [l.transactionHash.toLowerCase(), l.args.token.toLowerCase()]);
    const r = rows.find((x) => x.trader === l.args.trader.toLowerCase());
    const wantSide = l.args.buy ? "buy" : "sell";
    if (!r || r.side !== wantSide || BigInt(r.user_amount_in) !== l.args.amountIn || BigInt(r.user_amount_out) !== l.args.amountOut) {
      sideOk = false; console.log("  router trade", l.transactionHash, wantSide, rows);
    }
    // pool-level amounts: what the user received equals what left the pool
    if (r && BigInt(r[wantSide === "buy" ? "token_amount" : "quote_amount"]) !== l.args.amountOut) {
      sideOk = false; console.log("  amountOut vs pool", l.transactionHash);
    }
  }
  check("router trades: side, trader and user amounts match Swapped events", sideOk, `${swappedLogs.length} router trades`);

  // ---------------------------------------------------------------- idempotency
  const snapshot = async () => (await pool.query(
    "select (select count(*) from swaps) s, (select count(*) from transfers) t, (select coalesce(sum(balance),0) from balances) b, (select count(*) from fees) f")).rows[0];
  const before = await snapshot();
  const again = new Indexer(cfg, provider, pool, quiet);
  await again.init();
  again.cursor = cfg.startBlock - 1; // re-process everything
  await again.syncOnce();
  const after = await snapshot();
  check("re-indexing the same blocks changes nothing", JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));

  // ---------------------------------------------------------------- API
  const h = await get("/health");
  check("GET /health", h.status === 200 && h.body.ok && h.body.sync.indexedBlock === indexer.cursor && h.cors === "*");
  const list = await get("/tokens?limit=100");
  check("GET /tokens lists every token, newest first", list.status === 200 && list.body.tokens.length === launchCount
    && list.body.tokens[0].launchId === launchCount);
  const byVol = await get("/tokens?sort=volume&quote=hype");
  check("GET /tokens?sort=volume&quote=hype", byVol.status === 200 && byVol.body.tokens.every((x) => x.quote.symbol === "HYPE"));
  const traded = tokens.find((t) => swappedLogs.some((l) => l.args.token.toLowerCase() === t.address));
  const one = await get(`/tokens/${traded.address}`);
  check("GET /tokens/:address", one.status === 200 && one.body.symbol === traded.symbol && one.body.tradesTotal > 0
    && one.body.holders > 0 && one.body.marketCap > 0, `${one.body.symbol}: mcap ${one.body.marketCap?.toFixed(2)} ${one.body.quote?.symbol}, ${one.body.holders} holders, vol24h ${one.body.volume24h}`);
  const tr = await get(`/tokens/${traded.address}/trades?limit=2`);
  check("GET /tokens/:address/trades (paginated)", tr.status === 200 && tr.body.trades.length > 0
    && (tr.body.trades.length < 2 || tr.body.next !== null));
  if (tr.body.next) {
    const tr2 = await get(`/tokens/${traded.address}/trades?limit=2&before=${tr.body.next}`);
    check("trades page 2 continues after page 1", tr2.status === 200 && tr2.body.trades.every((x) => x.block <= tr.body.trades[1].block));
  }
  const cd = await get(`/tokens/${traded.address}/candles?interval=1m`);
  check("GET /tokens/:address/candles", cd.status === 200 && cd.body.candles.length > 0
    && cd.body.candles.every((c) => c.high >= c.low && c.high >= c.open && c.high >= c.close), `${cd.body.candles.length} candles`);
  const hd = await get(`/tokens/${traded.address}/holders`);
  check("GET /tokens/:address/holders", hd.status === 200 && hd.body.holders === one.body.holders && hd.body.top.length > 0);
  const it = await get("/integrators");
  check("GET /integrators", it.status === 200 && it.body.integrators.some((x) => x.id === 1 && x.name));
  const st = await get("/stats");
  check("GET /stats", st.status === 200 && st.body.tokens === launchCount);
  const { rows: qrows } = await pool.query("select address, symbol, decimals from quotes");
  const qmap = new Map(qrows.map((r) => [r.address, r]));
  const allList = list.body.tokens;
  check("quote symbol/decimals in API match the quotes table (no stale cache)",
    allList.every((x) => x.quote.address === ethers.ZeroAddress ? x.quote.symbol === "HYPE" && x.quote.decimals === 18
      : qmap.get(x.quote.address)?.symbol === x.quote.symbol && qmap.get(x.quote.address)?.decimals === x.quote.decimals)
    && st.body.volume24h.every((v) => v.symbol !== "?"), JSON.stringify(st.body.volume24h));
  const bad = await get("/tokens/0x0000000000000000000000000000000000000001");
  const bad2 = await get("/tokens?sort=nope");
  check("unknown token → 404, bad parameter → 400", bad.status === 404 && bad2.status === 400);

  // ---------------------------------------------------------------- hidden tokens
  const hideMe = tokens[0].address;
  const hiddenApi = createApi({ ...cfg, hiddenTokens: [hideMe] }, pool, indexer);
  await new Promise((r) => hiddenApi.listen(0, "127.0.0.1", r));
  const hb = `http://127.0.0.1:${hiddenApi.address().port}`;
  const hl = await (await fetch(hb + "/tokens?limit=100")).json();
  const hs = await (await fetch(hb + "/stats")).json();
  const hdet = await fetch(hb + `/tokens/${hideMe}`);
  check("hidden tokens: left out of /tokens and /stats, detail still served",
    hl.tokens.length === launchCount - 1 && !hl.tokens.some((x) => x.address === hideMe) && hs.tokens === launchCount - 1 && hdet.status === 200,
    `${hl.tokens.length} listed, stats ${hs.tokens}`);
  hiddenApi.close();

  // ---------------------------------------------------------------- image uploads
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const post = (body, type) => fetch(base + "/upload", { method: "POST", headers: { "content-type": type }, body });
  const up = await post(png, "image/png");
  const upBody = await up.json();
  check("POST /upload stores a PNG and returns its URL", up.status === 201 && /\/images\/[0-9a-f]{64}\.png$/.test(upBody.url), upBody.url);
  const imgPath = new URL(upBody.url).pathname;
  const got = await fetch(base + imgPath);
  const gotBytes = Buffer.from(await got.arrayBuffer());
  check("GET /images/:hash serves the same bytes with safe headers", got.status === 200 && gotBytes.equals(png)
    && got.headers.get("content-type") === "image/png" && got.headers.get("x-content-type-options") === "nosniff"
    && /sandbox/.test(got.headers.get("content-security-policy") || ""));
  const dup = await (await post(png, "image/png")).json();
  check("same image uploaded twice → same URL", dup.url === upBody.url);
  const svg = await post('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml");
  const fake = await post(Buffer.from("not an image at all"), "image/png");
  check("SVG and non-images are refused (415)", svg.status === 415 && fake.status === 415);
  const big = Buffer.concat([png.subarray(0, 8), Buffer.alloc(cfg.maxUploadBytes + 10)]);
  const tooBig = await post(big, "image/png");
  check("oversized upload refused (413)", tooBig.status === 413);
  const missing = await fetch(base + "/images/" + "0".repeat(64) + ".png");
  check("unknown image → 404", missing.status === 404);

  server.close();
  await pool.end();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
