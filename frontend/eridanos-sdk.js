/*
 * Eridanos SDK — minimal helpers for apps (integrators) building on the Eridanos launch protocol.
 * Works in Node (require("./sdk/eridanos-sdk.js")) and in the browser (<script> after ethers v6 UMD →
 * window.EridanosSDK). No build step.
 *
 *   hashLaunchParams(params)          → bytes32, identical to LaunchCore.hashParams (mode B binding)
 *   signLaunchIntent(signer, ctx, i)  → EIP-712 signature for IntegratorRegistry (mode B)
 *   listLaunches(provider, core, ...) → decoded `Launched` events
 *   scheduleFee / surchargeExactIn    → anti-sniper fee math (pips)
 *   describeSupply(record)            → human-readable disclosure of creator allocation + dev buy
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("ethers"));
  else root.EridanosSDK = factory(root.ethers);
})(typeof self !== "undefined" ? self : this, function (ethersLib) {
  "use strict";
  const { ethers } = ethersLib.ethers ? ethersLib : { ethers: ethersLib };

  const SUPPLY = 10n ** 27n;
  const PIPS = 1_000_000n;
  const BASE_FEE = 10_000n; // 1%
  const START_FEE = 900_000n; // 90%
  const DECAY_SECONDS = 10n;

  const LAUNCH_PARAMS =
    "tuple(string name,string symbol,string metadataURI,bytes32 salt,address creator,uint16 presetId," +
    "tuple(address recipient,uint16 bps)[] allocations,uint32 cliff,uint32 duration,uint256 devBuyTokens,uint256 maxDevBuyQuote)";
  const LAUNCH_RECORD =
    "tuple(bytes32 poolId,address creator,address caller,uint8 attribution,address quote,uint16 presetId," +
    "uint16 protocolBps,uint16 integratorBps,uint16 creatorBps,uint16 allocBps,uint32 cliff,uint32 duration," +
    "bool instantAllocation,uint256 devBuyTokens,uint256 devBuyQuoteSpent,uint32 devBuyLock,uint256 poolTokens)";
  const INTENT =
    "tuple(uint32 integratorId,address core,address caller,address creator,bytes32 paramsHash,uint256 nonce,uint64 deadline)";
  const POLICY = "tuple(uint16 integratorBps,uint16 maxAllocBps,uint16 maxDevBuyBps,uint32 minCliff,uint32 minDuration,uint32 devBuyLock)";

  const ABI = {
    LaunchCore: [
      `function launch(${LAUNCH_PARAMS} p) payable returns (address token, bytes32 poolId)`,
      `function launchSigned(${LAUNCH_PARAMS} p, ${INTENT} intent, bytes signature) payable returns (address token, bytes32 poolId)`,
      `function hashParams(${LAUNCH_PARAMS} p) pure returns (bytes32)`,
      `function predictToken(address caller, ${LAUNCH_PARAMS} p) view returns (address)`,
      "function poolOf(address token) view returns (bytes32)",
      "function launchCount() view returns (uint256)",
      "function paused() view returns (bool)",
      `event Launched(uint256 indexed launchId, address indexed token, uint32 indexed integratorId, ${LAUNCH_RECORD} record, uint16 coreVersion)`,
    ],
    HypelysRouter: [
      `function launch(${LAUNCH_PARAMS} p) payable returns (address token, bytes32 poolId)`,
      `function predictToken(address user, ${LAUNCH_PARAMS} p) view returns (address)`,
      "function buy(address token, uint256 amountIn, uint256 minOut, uint256 deadline) payable returns (uint256)",
      "function sell(address token, uint256 amountIn, uint256 minOut, uint256 deadline) returns (uint256)",
      "function integratorId() view returns (uint32)",
    ],
    CurveHook: [
      "function poolInfo(bytes32 poolId) view returns (tuple(address token,address quote,bool tokenIs0,uint40 launchedAt) info, tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, tuple(int24 tickLower,int24 tickUpper)[] bands)",
      "function spot(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick)",
      "function currentFee(bytes32 poolId) view returns (uint24)",
      "function collect(bytes32 poolId) returns (uint256 tokenFees, uint256 quoteFees)",
    ],
    FeeDistributor: [
      "function feeTerms(bytes32 poolId) view returns (tuple(address token,address quote,address creator,address pendingCreator,uint32 integratorId,uint16 integratorBps) terms, uint256 protocolBps, uint256 integratorBps, uint256 creatorBps)",
      "function creatorOwed(bytes32 poolId, address currency) view returns (uint256)",
      "function integratorOwed(uint32 integratorId, address currency) view returns (uint256)",
      "function claimCreator(bytes32 poolId)",
      "function claimIntegrator(uint32 integratorId, address currency)",
    ],
    IntegratorRegistry: [
      `function register(string name, string uri, address signer, address payout, ${POLICY} policy) returns (uint32)`,
      `function getIntegrator(uint32 id) view returns (tuple(address account,address pendingAccount,address signer,address payout,bool selfActive,bool suspended,bool approved,bool verified,uint64 pendingPolicyAt,${POLICY} policy,${POLICY} pendingPolicy,string name,string uri))`,
      "function integratorOf(address caller) view returns (uint32)",
      "function nonceUsed(uint32 id, uint256 nonce) view returns (bool)",
      `function policyOf(uint32 id) view returns (${POLICY})`,
    ],
    ProtocolConfig: [
      "function presetCount() view returns (uint16)",
      "function isPresetUsable(uint16 presetId) view returns (bool)",
      "function preset(uint16 presetId) view returns (tuple(address quote,int24 startTick,int24 curveTop,bool enabled,uint8 bandCount) info, tuple(int24 offsetLower,int24 offsetUpper,uint16 bps)[] bands)",
    ],
    EridanosToken: [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function metadataURI() view returns (string)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ],
  };

  const INTENT_TYPES = {
    LaunchIntent: [
      { name: "integratorId", type: "uint32" },
      { name: "core", type: "address" },
      { name: "caller", type: "address" },
      { name: "creator", type: "address" },
      { name: "paramsHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
  };

  function normalizeParams(p) {
    return {
      name: p.name,
      symbol: p.symbol,
      metadataURI: p.metadataURI ?? "",
      salt: p.salt ?? ethers.hexlify(ethers.randomBytes(32)),
      creator: p.creator,
      presetId: p.presetId,
      allocations: (p.allocations ?? []).map((a) => ({ recipient: a.recipient, bps: a.bps })),
      cliff: p.cliff ?? 0,
      duration: p.duration ?? 0,
      devBuyTokens: BigInt(p.devBuyTokens ?? 0),
      maxDevBuyQuote: BigInt(p.maxDevBuyQuote ?? 0),
    };
  }

  /** keccak256(abi.encode(params)) — the value LaunchCore.hashParams returns. */
  function hashLaunchParams(p) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([LAUNCH_PARAMS], [normalizeParams(p)]));
  }

  /** Mode B: the integrator's signer authorises one launch. ctx = { registry, chainId }. */
  async function signLaunchIntent(signer, ctx, intent) {
    const domain = { name: "Eridanos", version: "1", chainId: ctx.chainId, verifyingContract: ctx.registry };
    return signer.signTypedData(domain, INTENT_TYPES, intent);
  }

  /**
   * Decoded `Launched` events. Queries `step` blocks at a time (Elysium makes ~1M blocks a day, and its RPC
   * accepts multi-million-block ranges for a single address); a range the RPC refuses is split in half.
   */
  async function listLaunches(provider, coreAddress, { fromBlock = 0, toBlock = "latest", step = 5_000_000, minStep = 1_000 } = {}) {
    const core = new ethers.Contract(coreAddress, ABI.LaunchCore, provider);
    const last = toBlock === "latest" ? await provider.getBlockNumber() : toBlock;
    const out = [];
    for (let start = fromBlock; start <= last; ) {
      const end = Math.min(last, start + step - 1);
      let logs;
      try {
        logs = await core.queryFilter(core.filters.Launched(), start, end);
      } catch (e) {
        if (step <= minStep) throw e;
        step = Math.max(minStep, Math.floor(step / 2));
        continue;
      }
      start = end + 1;
      for (const l of logs) {
        out.push({
          launchId: l.args.launchId,
          token: l.args.token,
          integratorId: Number(l.args.integratorId),
          record: l.args.record.toObject(),
          blockNumber: l.blockNumber,
          txHash: l.transactionHash,
        });
      }
    }
    return out;
  }

  function scheduleFee(elapsedSeconds) {
    const e = BigInt(Math.max(0, Math.floor(Number(elapsedSeconds))));
    if (e >= DECAY_SECONDS) return BASE_FEE;
    return BASE_FEE + ((START_FEE - BASE_FEE) * (DECAY_SECONDS - e)) / DECAY_SECONDS;
  }

  /** Surcharge on an exact-input swap of `amount` at `elapsedSeconds` after launch (same formula as CurveHook). */
  function surchargeExactIn(amount, elapsedSeconds) {
    const f = scheduleFee(elapsedSeconds);
    return f <= BASE_FEE ? 0n : (BigInt(amount) * (f - BASE_FEE)) / (PIPS - BASE_FEE);
  }

  /** Share of the fixed supply as a percentage string; tiny non-zero amounts show as "<0.01%". */
  function supplyPct(tokens) {
    const t = BigInt(tokens);
    if (t === 0n) return "0%";
    const bps = (t * 10000n) / SUPPLY;
    return bps === 0n ? "<0.01%" : (Number(bps) / 100).toFixed(2) + "%";
  }

  function describeSupply(r) {
    const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
    const days = (s) => (Number(s) / 86400).toFixed(Number(s) % 86400 ? 2 : 0) + " hari";
    const lines = [];
    if (Number(r.allocBps) === 0) lines.push("Alokasi creator: 0%");
    else if (r.instantAllocation) lines.push(`Alokasi creator: ${pct(r.allocBps)} — INSTAN (cair saat peluncuran)`);
    else lines.push(`Alokasi creator: ${pct(r.allocBps)} — cliff ${days(r.cliff)}, vesting ${days(r.duration)}`);
    const dev = BigInt(r.devBuyTokens);
    if (dev === 0n) lines.push("Dev buy: tidak ada");
    else lines.push(`Dev buy: ${supplyPct(dev)} supply${Number(r.devBuyLock) ? `, dikunci ${days(r.devBuyLock)}` : ""}`);
    lines.push(`Fee dasar 1%: protokol ${pct(r.protocolBps)} · integrator ${pct(r.integratorBps)} · creator ${pct(r.creatorBps)}`);
    return lines;
  }

  return {
    SUPPLY, PIPS, BASE_FEE, START_FEE, DECAY_SECONDS, ABI, INTENT_TYPES, LAUNCH_PARAMS, LAUNCH_RECORD,
    normalizeParams, hashLaunchParams, signLaunchIntent, listLaunches, scheduleFee, surchargeExactIn, describeSupply, supplyPct,
  };
});
