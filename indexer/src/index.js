// Entry point: migrate the database, start the REST API, and follow the chain.
const { load } = require("./config");
const { makePool, migrate } = require("./db");
const { makeProvider } = require("./rpc");
const { Indexer } = require("./sync");
const { createApi } = require("./api");

async function main() {
  const cfg = load();
  console.log(`[indexer] ${cfg.network} (chain ${cfg.chainId}), core ${cfg.addresses.core}, from block ${cfg.startBlock}`);
  const pool = makePool(cfg);
  await migrate(pool, cfg);

  const provider = makeProvider(cfg);
  const net = await provider.send("eth_chainId", []);
  if (Number(net) !== cfg.chainId) throw new Error(`RPC_URL is chain ${Number(net)}, deployment is chain ${cfg.chainId}`);

  const indexer = new Indexer(cfg, provider, pool);
  await indexer.init();

  let server;
  if (cfg.apiEnabled) {
    server = createApi(cfg, pool, indexer);
    await new Promise((r) => server.listen(cfg.port, "0.0.0.0", r));
    console.log(`[api] listening on :${cfg.port}`);
  }

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[indexer] ${sig}, shutting down`);
    if (server) server.close();
    setTimeout(() => process.exit(0), 5000).unref();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  if (cfg.syncEnabled) await indexer.run(() => stopping);
}

main().catch((e) => {
  console.error("[indexer] fatal:", e.message || e);
  process.exit(1);
});
