// JSON-RPC access tuned for Elysium's public RPC, which rate-limits bursts (error -32017 / HTTP 429):
// no batching, a few requests in flight, a minimum spacing, and retries with backoff.
const { ethers } = require("ethers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ThrottledProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId, { concurrency = 3, minIntervalMs = 120 } = {}) {
    super(url, chainId, { staticNetwork: true, batchMaxCount: 1 });
    this._max = concurrency;
    this._gap = minIntervalMs;
    this._active = 0;
    this._waiting = [];
    this._next = 0;
  }

  async _acquire() {
    if (this._active >= this._max) await new Promise((r) => this._waiting.push(r));
    this._active++;
    const now = Date.now();
    const at = Math.max(now, this._next);
    this._next = at + this._gap;
    if (at > now) await sleep(at - now);
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
      try {
        res = await super._send(payload);
      } catch (e) {
        this._release();
        if (attempt >= 6) throw e;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      this._release();
      const limited = res.some((r) => r.error && (r.error.code === -32017 || /rate limit/i.test(r.error.message || "")));
      if (!limited || attempt >= 8) return res;
      await sleep(300 * 2 ** Math.min(attempt, 5) + Math.random() * 200);
    }
  }
}

function makeProvider(cfg) {
  if (!cfg.rpcUrl) throw new Error("RPC_URL is required");
  return new ThrottledProvider(cfg.rpcUrl, cfg.chainId, { concurrency: cfg.rpcConcurrency, minIntervalMs: cfg.rpcMinIntervalMs });
}

const hex = (n) => "0x" + BigInt(n).toString(16);

/** Raw eth_getLogs (keeps `blockTimestamp`, which ethers' Log objects drop). */
async function getLogs(provider, filter) {
  const params = { ...filter, fromBlock: hex(filter.fromBlock), toBlock: hex(filter.toBlock) };
  return provider.send("eth_getLogs", [params]);
}

module.exports = { ThrottledProvider, makeProvider, getLogs, hex, sleep };
