const { ethers } = require("ethers");
const fs = require("fs");
const c = JSON.parse(fs.readFileSync((process.env.OUT || __dirname) + "/creation.json"));
const pm = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)",
]);
const erc = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)", "event Deposit(address indexed dst, uint256 wad)", "event Withdrawal(address indexed src, uint256 wad)"]);
const FLAGS = ["AFTER_REMOVE_LIQ_RETURNS_DELTA","AFTER_ADD_LIQ_RETURNS_DELTA","AFTER_SWAP_RETURNS_DELTA","BEFORE_SWAP_RETURNS_DELTA","AFTER_DONATE","BEFORE_DONATE","AFTER_SWAP","BEFORE_SWAP","AFTER_REMOVE_LIQ","BEFORE_REMOVE_LIQ","AFTER_ADD_LIQ","BEFORE_ADD_LIQ","AFTER_INIT","BEFORE_INIT"];
const flags = (a) => { const f = Number(BigInt(a) & 0x3fffn); return FLAGS.filter((_, i) => (f >> i) & 1).join("|") || "none"; };
for (const [tok, x] of Object.entries(c)) {
  console.log(`\n### ${tok}  (tx ${x.tx.slice(0, 12)}…, to ${x.to})`);
  for (const l of x.logs) {
    let ev = null; try { ev = pm.parseLog(l); } catch {} if (!ev) try { ev = erc.parseLog(l); } catch {}
    if (!ev) { console.log(`  [${l.address.slice(0, 8)}] unknown ${l.topics[0].slice(0, 10)} topics=${l.topics.length - 1} data=${(l.data.length - 2) / 64} words`); continue; }
    const a = ev.args;
    if (ev.name === "Initialize") {
      const price = (Number(a.sqrtPriceX96) / 2 ** 96) ** 2;
      console.log(`  [${l.address.slice(0, 8)}] Initialize c0=${a.currency0} c1=${a.currency1} fee=${a.fee} (${Number(a.fee) & 0x800000 ? "DYNAMIC" : Number(a.fee) / 1e4 + "%"}) tickSpacing=${a.tickSpacing} hooks=${a.hooks} [${flags(a.hooks)}] tick=${a.tick} price(c1/c0)=${price.toExponential(4)}`);
    } else if (ev.name === "ModifyLiquidity") console.log(`  [${l.address.slice(0, 8)}] ModifyLiquidity sender=${a.sender} ticks=[${a.tickLower},${a.tickUpper}] dL=${a.liquidityDelta}`);
    else if (ev.name === "Swap") console.log(`  [${l.address.slice(0, 8)}] Swap sender=${a.sender} a0=${ethers.formatEther(a.amount0)} a1=${ethers.formatEther(a.amount1)} tick=${a.tick} fee=${a.fee}`);
    else if (ev.name === "Transfer" && l.topics.length === 4 && ev.fragment.inputs.length === 5) console.log(`  [${l.address.slice(0, 8)}] ERC6909 Transfer ${a.from}->${a.to} id=${a.id} amt=${a.amount}`);
    else console.log(`  [${l.address.slice(0, 8)}] ${ev.name} ${a.map((v) => (typeof v === "bigint" ? ethers.formatEther(v) : v)).join(" ")}`);
  }
}
