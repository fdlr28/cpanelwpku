// Runtime configuration from environment variables (Railway sets PORT and, with a Postgres plugin, DATABASE_URL).
const fs = require("fs");
const path = require("path");

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function load() {
  const file = process.env.DEPLOYMENT_FILE || path.join(__dirname, "..", "deployment.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["chainId", "poolManager", "core", "hook", "router", "registry", "distributor"]) {
    if (!d[k]) throw new Error(`${file}: missing ${k}`);
  }
  const lc = (a) => (a ? String(a).toLowerCase() : a);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (Railway: add a Postgres service and reference its DATABASE_URL)");
  return {
    deploymentFile: file,
    chainId: Number(d.chainId),
    network: d.network || `chain-${d.chainId}`,
    addresses: {
      poolManager: lc(d.poolManager), core: lc(d.core), hook: lc(d.hook), router: lc(d.router),
      registry: lc(d.registry), distributor: lc(d.distributor), vault: lc(d.vault), usdc: lc(d.usdc),
      infinityVault: lc(d.infinityVault), // holds the pools' tokens (PancakeSwap Infinity)
    },
    startBlock: int("START_BLOCK", Number(d.deployBlock || 0)),
    // Launches left out of listings and stats (e.g. test launches); their detail endpoints still work.
    hiddenTokens: (process.env.HIDDEN_TOKENS !== undefined ? process.env.HIDDEN_TOKENS.split(",") : d.hiddenTokens || [])
      .map((a) => String(a).trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
    rpcUrl: process.env.RPC_URL || d.rpcUrl || "",
    databaseUrl,
    // "<chainId>:<core>" of a new deployment: wipes chain data recorded for an older one (see db.migrate).
    resetDbForDeployment: (process.env.RESET_DB_FOR_DEPLOYMENT || "").trim().toLowerCase() || null,
    // Railway's private network (postgres.railway.internal) needs no TLS. For a public endpoint set
    // DATABASE_SSL=true (verified TLS) or, only for a provider with a self-signed certificate, no-verify.
    databaseSsl: process.env.DATABASE_SSL === "no-verify" ? "no-verify" : process.env.DATABASE_SSL === "true" ? "verify" : null,
    port: int("PORT", 8080),
    corsOrigin: process.env.CORS_ORIGIN || "*",
    confirmations: int("CONFIRMATIONS", 20), // Elysium: ~12 blocks/s, so 20 blocks ≈ 2 s behind the head
    pollMs: int("POLL_MS", 2000),
    maxStep: int("MAX_STEP", 2_000_000), // Elysium's RPC accepts multi-million-block ranges filtered by address
    minStep: int("MIN_STEP", 1_000),
    rpcConcurrency: int("RPC_CONCURRENCY", 3),
    rpcMinIntervalMs: int("RPC_MIN_INTERVAL_MS", 120),
    // Token images uploaded from the website (POST /upload), stored in Postgres and served at /images/<sha256>.
    publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
    uploadsEnabled: process.env.UPLOADS !== "false",
    uploadOrigins: (process.env.UPLOAD_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    maxUploadBytes: int("MAX_UPLOAD_BYTES", 1_000_000),
    uploadsPerHour: int("UPLOADS_PER_HOUR", 30),
    maxImageStorageBytes: int("MAX_IMAGE_STORAGE_BYTES", 1_000_000_000),
    syncEnabled: process.env.SYNC !== "false",
    apiEnabled: process.env.API !== "false",
  };
}

module.exports = { load };
