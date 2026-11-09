// Follows the chain and writes protocol events to Postgres.
//
// Each block range is fetched with a handful of eth_getLogs calls (protocol contracts, then the launched
// tokens' Transfer events) and written in ONE database transaction together with the new cursor, so a crash
// never leaves a half-written range. Inserts are keyed on (tx, log_index) and balance updates only apply to
// newly inserted transfers, so re-running a range is harmless.
const { ethers } = require("ethers");
const abi = require("./abi");
const { getLogs, hex, sleep } = require("./rpc");
const { tx } = require("./db");

const ZERO = ethers.ZeroAddress;
const lc = (a) => String(a).toLowerCase();

/** Quote per token in human units, from a pool's sqrtPriceX96 (same formula as the frontend). */
function priceOf(sqrtPriceX96, tokenIs0, quoteDecimals) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const raw = tokenIs0 ? r * r : 1 / (r * r); // quote-raw per token-raw
  return raw * 10 ** (18 - quoteDecimals);
}

/** Token metadata is a data: URI with base64 JSON ({ image, description }); anything else is left undecoded. */
function decodeMeta(uri) {
  try {
    const prefix = "data:application/json;base64,";
    if (uri && uri.startsWith(prefix)) {
      const obj = JSON.parse(Buffer.from(uri.slice(prefix.length), "base64").toString("utf8"));
      return {
        image: typeof obj.image === "string" ? obj.image.slice(0, 2000) : null,
        description: typeof obj.description === "string" ? obj.description.slice(0, 5000) : null,
      };
    }
  } catch {}
  return { image: null, description: null };
}

class Indexer {
  constructor(cfg, provider, pool, log = console) {
    this.cfg = cfg;
    this.provider = provider;
    this.pool = pool;
    this.log = log;
    this.step = cfg.maxStep;
    this.pools = new Map(); // poolId -> { token, tokenIs0, quote, quoteDecimals, creator }
    this.quotes = new Map(); // address -> { symbol, decimals }
    this.blockTs = new Map();
    this.head = null;
    this.cursor = null;
    this.lastSyncAt = null;
    this.lastError = null;
    const A = cfg.addresses;
    this.byAddress = new Map([
      [A.core, abi.core], [A.poolManager, abi.poolManager], [A.router, abi.router],
      [A.registry, abi.registry], [A.distributor, abi.distributor],
    ]);
  }

  async init() {
    const { rows: q } = await this.pool.query("select address, symbol, decimals from quotes");
    for (const r of q) this.quotes.set(r.address, { symbol: r.symbol, decimals: Number(r.decimals) });
    const { rows: t } = await this.pool.query("select address, pool_id, token_is0, quote, creator from tokens");
    for (const r of t) {
      this.pools.set(r.pool_id, { token: r.address, tokenIs0: r.token_is0, quote: r.quote, creator: r.creator,
        quoteDecimals: this.quotes.get(r.quote)?.decimals ?? 18 });
    }
    const { rows: s } = await this.pool.query("select block from sync_state where id = 'main'");
    this.cursor = s.length ? Number(s[0].block) : this.cfg.startBlock - 1;
  }

  // ---------------------------------------------------------------------------------------- fetching

  decode(l) {
    if (l.removed) return null;
    const iface = this.byAddress.get(lc(l.address));
    if (!iface) return null;
    let parsed;
    try { parsed = iface.parseLog({ topics: l.topics, data: l.data }); } catch { return null; }
    if (!parsed) return null;
    return {
      name: parsed.name, args: parsed.args, address: lc(l.address),
      block: Number(l.blockNumber), logIndex: Number(l.logIndex), tx: lc(l.transactionHash),
      ts: l.blockTimestamp != null ? Number(l.blockTimestamp) : null,
    };
  }

  async quoteInfo(address) {
    const a = lc(address);
    if (this.quotes.has(a)) return { ...this.quotes.get(a), fresh: false };
    if (a === ZERO) return { symbol: "HYPE", decimals: 18, fresh: true };
    const c = new ethers.Contract(a, abi.erc20, this.provider);
    const [symbol, decimals] = await Promise.all([c.symbol().catch(() => "?"), c.decimals()]);
    return { symbol: String(symbol).slice(0, 32), decimals: Number(decimals), fresh: true };
  }

  async timestampOf(block) {
    if (this.blockTs.has(block)) return this.blockTs.get(block);
    const b = await this.provider.send("eth_getBlockByNumber", [hex(block), false]);
    const ts = Number(b.timestamp);
    if (this.blockTs.size > 50_000) this.blockTs.clear();
    this.blockTs.set(block, ts);
    return ts;
  }

  async fetchRange(from, to) {
    const A = this.cfg.addresses;
    const raw = await getLogs(this.provider, {
      address: [A.core, A.poolManager, A.router, A.registry, A.distributor], fromBlock: from, toBlock: to,
    });
    const events = raw.map((l) => this.decode(l)).filter(Boolean);

    // Launches in this range: read the token's immutable metadata once.
    const launches = [];
    for (const e of events.filter((x) => x.name === "Launched")) {
      const token = lc(e.args.token);
      const t = new ethers.Contract(token, abi.erc20, this.provider);
      const [name, symbol, metadataURI] = await Promise.all([t.name(), t.symbol(), t.metadataURI().catch(() => "")]);
      const r = e.args.record;
      const quote = lc(r.quote);
      launches.push({ e, token, name, symbol, metadataURI, quote, q: await this.quoteInfo(quote) });
    }

    // New integrators: the event lacks name/uri, so read the record.
    const registry = new ethers.Contract(A.registry, abi.registry, this.provider);
    const integrators = [];
    for (const e of events.filter((x) => x.name === "IntegratorRegistered")) {
      const it = await registry.getIntegrator(e.args.id);
      integrators.push({ e, it });
    }

    // Transfers of every launched token (known + launched in this range).
    const tokens = [...new Set([...[...this.pools.values()].map((p) => p.token), ...launches.map((l) => l.token)])];
    const transfers = [];
    for (let i = 0; i < tokens.length; i += 200) {
      const logs = await getLogs(this.provider, {
        address: tokens.slice(i, i + 200), topics: [abi.TRANSFER_TOPIC], fromBlock: from, toBlock: to,
      });
      for (const l of logs) {
        if (l.removed) continue;
        const p = abi.erc20.parseLog({ topics: l.topics, data: l.data });
        transfers.push({
          name: "Transfer", args: p.args, address: lc(l.address), block: Number(l.blockNumber),
          logIndex: Number(l.logIndex), tx: lc(l.transactionHash), ts: l.blockTimestamp != null ? Number(l.blockTimestamp) : null,
        });
      }
    }

    // Timestamps for nodes that don't return blockTimestamp in logs.
    for (const e of [...events, ...transfers]) if (e.ts == null) e.ts = await this.timestampOf(e.block);

    const all = [...events, ...transfers].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    return { all, launches, integrators, logCount: raw.length + transfers.length };
  }

  // ---------------------------------------------------------------------------------------- writing

  async writeRange(to, { all, launches, integrators }) {
    const A = this.cfg.addresses;
    const pools = new Map(this.pools);
    const quotes = new Map(this.quotes);
    await tx(this.pool, async (c) => {
      for (const l of launches) {
        if (l.q.fresh) {
          await c.query("insert into quotes (address, symbol, decimals) values ($1,$2,$3) on conflict do nothing", [l.quote, l.q.symbol, l.q.decimals]);
          quotes.set(l.quote, { symbol: l.q.symbol, decimals: l.q.decimals });
        }
        const r = l.e.args.record;
        const tokenIs0 = l.quote !== ZERO && BigInt(l.token) < BigInt(l.quote); // v4 sorts currencies by address
        const meta = decodeMeta(l.metadataURI);
        await c.query(
          `insert into tokens (address, launch_id, pool_id, name, symbol, metadata_uri, image, description, creator, caller,
             integrator_id, attribution, quote, token_is0, preset_id, protocol_bps, integrator_bps, creator_bps, alloc_bps,
             cliff, duration, instant_allocation, dev_buy_tokens, dev_buy_quote_spent, dev_buy_lock, pool_tokens, core_version,
             block, tx, ts)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,to_timestamp($30))
           on conflict (address) do nothing`,
          [l.token, l.e.args.launchId.toString(), lc(r.poolId), l.name, l.symbol, l.metadataURI, meta.image, meta.description,
            lc(r.creator), lc(r.caller), Number(l.e.args.integratorId), Number(r.attribution), l.quote, tokenIs0, Number(r.presetId),
            Number(r.protocolBps), Number(r.integratorBps), Number(r.creatorBps), Number(r.allocBps), Number(r.cliff), Number(r.duration),
            r.instantAllocation, r.devBuyTokens.toString(), r.devBuyQuoteSpent.toString(), Number(r.devBuyLock), r.poolTokens.toString(),
            Number(l.e.args.coreVersion), l.e.block, l.e.tx, l.e.ts],
        );
        pools.set(lc(r.poolId), { token: l.token, tokenIs0, quote: l.quote, creator: lc(r.creator), quoteDecimals: l.q.decimals });
      }

      for (const { e, it } of integrators) {
        await c.query(
          `insert into integrators (id, account, payout, name, uri, verified, suspended, registered_block, updated_block)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           on conflict (id) do update set account = excluded.account, payout = excluded.payout, name = excluded.name,
             uri = excluded.uri, verified = excluded.verified, suspended = excluded.suspended, registered_block = excluded.registered_block`,
          [Number(e.args.id), lc(it.account), lc(it.payout), it.name, it.uri, it.verified, it.suspended, e.block],
        );
      }

      for (const e of all) {
        switch (e.name) {
          case "Initialize": {
            const p = pools.get(lc(e.args.id));
            if (!p) break;
            const price = priceOf(e.args.sqrtPriceX96, p.tokenIs0, p.quoteDecimals);
            await c.query(
              `update tokens set init_price = $2, last_price = coalesce(last_price, $2),
                 last_sqrt_price = coalesce(last_sqrt_price, $3), last_tick = coalesce(last_tick, $4) where pool_id = $1`,
              [lc(e.args.id), price, e.args.sqrtPriceX96.toString(), Number(e.args.tick)],
            );
            break;
          }
          case "Swap": {
            const p = pools.get(lc(e.args.id));
            if (!p) break;
            // amount0/amount1 are the swapper's balance deltas: positive = received from the pool.
            const a0 = BigInt(e.args.amount0);
            const a1 = BigInt(e.args.amount1);
            const tokenDelta = p.tokenIs0 ? a0 : a1;
            const quoteDelta = p.tokenIs0 ? a1 : a0;
            const abs = (x) => (x < 0n ? -x : x);
            const sender = lc(e.args.sender);
            const devbuy = sender === A.hook;
            const price = priceOf(e.args.sqrtPriceX96, p.tokenIs0, p.quoteDecimals);
            await c.query(
              `insert into swaps (tx, log_index, block, ts, pool_id, token, kind, sender, trader, side, token_amount, quote_amount,
                 price, sqrt_price, tick, fee)
               values ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict do nothing`,
              [e.tx, e.logIndex, e.block, e.ts, lc(e.args.id), p.token, devbuy ? "devbuy" : "swap", sender, devbuy ? p.creator : null,
                tokenDelta > 0n ? "buy" : "sell", abs(tokenDelta).toString(), abs(quoteDelta).toString(), price,
                e.args.sqrtPriceX96.toString(), Number(e.args.tick), Number(e.args.fee)],
            );
            await c.query(
              `update tokens set last_price = $2, last_sqrt_price = $3, last_tick = $4, last_trade_at = to_timestamp($5) where pool_id = $1`,
              [lc(e.args.id), price, e.args.sqrtPriceX96.toString(), Number(e.args.tick), e.ts],
            );
            break;
          }
          case "Swapped": {
            // The router's own event names the end user and the amounts they paid/received.
            await c.query(
              `update swaps set trader = $3, user_amount_in = $4, user_amount_out = $5
               where (tx, log_index) = (select tx, log_index from swaps where tx = $1 and token = $2 and log_index < $6
                                        and trader is null order by log_index desc limit 1)`,
              [e.tx, lc(e.args.token), lc(e.args.trader), e.args.amountIn.toString(), e.args.amountOut.toString(), e.logIndex],
            );
            break;
          }
          case "FeesSplit":
            await c.query(
              `insert into fees (tx, log_index, block, ts, pool_id, currency, amount, to_protocol, to_integrator, to_creator)
               values ($1,$2,$3,to_timestamp($4),$5,$6,$7,$8,$9,$10) on conflict do nothing`,
              [e.tx, e.logIndex, e.block, e.ts, lc(e.args.poolId), lc(e.args.currency), e.args.amount.toString(),
                e.args.toProtocol.toString(), e.args.toIntegrator.toString(), e.args.toCreator.toString()],
            );
            break;
          case "ProfileUpdated":
            await c.query(
              `insert into integrators (id, name, uri, updated_block) values ($1,$2,$3,$4)
               on conflict (id) do update set name = excluded.name, uri = excluded.uri, updated_block = excluded.updated_block`,
              [Number(e.args.id), e.args.name, e.args.uri, e.block],
            );
            break;
          case "PayoutUpdated":
            await c.query("update integrators set payout = $2, updated_block = $3 where id = $1", [Number(e.args.id), lc(e.args.payout), e.block]);
            break;
          case "AccountTransferred":
            await c.query("update integrators set account = $2, updated_block = $3 where id = $1", [Number(e.args.id), lc(e.args.newAccount), e.block]);
            break;
          case "VerifiedSet":
            await c.query("update integrators set verified = $2, updated_block = $3 where id = $1", [Number(e.args.id), e.args.verified, e.block]);
            break;
          case "SuspendedSet":
            await c.query("update integrators set suspended = $2, updated_block = $3 where id = $1", [Number(e.args.id), e.args.suspended, e.block]);
            break;
          case "Transfer": {
            const from = lc(e.args.from);
            const toAddr = lc(e.args.to);
            const v = e.args.value;
            const ins = await c.query(
              `insert into transfers (tx, log_index, block, token, from_addr, to_addr, value) values ($1,$2,$3,$4,$5,$6,$7)
               on conflict do nothing returning 1`,
              [e.tx, e.logIndex, e.block, e.address, from, toAddr, v.toString()],
            );
            if (!ins.rowCount || v === 0n) break;
            const upsert = `insert into balances (token, holder, balance) values ($1,$2,$3)
                            on conflict (token, holder) do update set balance = balances.balance + excluded.balance`;
            if (from !== ZERO) await c.query(upsert, [e.address, from, (-v).toString()]);
            if (toAddr !== ZERO) await c.query(upsert, [e.address, toAddr, v.toString()]);
            break;
          }
          default:
            break;
        }
      }

      await c.query(
        `insert into sync_state (id, block, updated_at) values ('main', $1, now())
         on conflict (id) do update set block = excluded.block, updated_at = now()`,
        [to],
      );
    });
    this.pools = pools;
    this.quotes = quotes;
    this.cursor = to;
  }

  // ---------------------------------------------------------------------------------------- loop

  /** Indexes up to (head − confirmations). Returns the new cursor. */
  async syncOnce() {
    this.head = await this.provider.getBlockNumber();
    const target = this.head - this.cfg.confirmations;
    let from = this.cursor + 1;
    while (from <= target) {
      const to = Math.min(target, from + this.step - 1);
      let data;
      try {
        data = await this.fetchRange(from, to);
      } catch (e) {
        if (this.step > this.cfg.minStep) {
          this.step = Math.max(this.cfg.minStep, Math.floor((to - from + 1) / 2));
          this.log.warn(`[sync] range ${from}-${to} failed (${e.shortMessage || e.message}); step → ${this.step}`);
          continue;
        }
        throw e;
      }
      await this.writeRange(to, data);
      if (data.logCount) this.log.log(`[sync] ${from}-${to}: ${data.logCount} logs, ${data.launches.length} launches`);
      from = to + 1;
      this.step = Math.min(this.cfg.maxStep, this.step * 2);
    }
    this.lastSyncAt = new Date();
    this.lastError = null;
    return this.cursor;
  }

  async run(stopped = () => false) {
    let backoff = this.cfg.pollMs;
    while (!stopped()) {
      try {
        await this.syncOnce();
        backoff = this.cfg.pollMs;
      } catch (e) {
        this.lastError = e.shortMessage || e.message;
        this.log.error(`[sync] ${this.lastError}`);
        backoff = Math.min(backoff * 2, 60_000);
      }
      await sleep(backoff);
    }
  }

  status() {
    return {
      chainId: this.cfg.chainId, network: this.cfg.network, headBlock: this.head, indexedBlock: this.cursor,
      lagBlocks: this.head != null ? Math.max(0, this.head - this.cursor) : null,
      lastSyncAt: this.lastSyncAt, lastError: this.lastError,
    };
  }
}

module.exports = { Indexer, priceOf, decodeMeta };
