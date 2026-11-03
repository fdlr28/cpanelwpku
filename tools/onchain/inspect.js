const { ethers } = require("ethers");
const RPCS = ["https://rpc-live.elyspump.com", "https://rpc.thekleos.xyz/rpc", "https://rpc-live.boxa.club"];
const p = new ethers.JsonRpcProvider(RPCS[Number(process.env.RPC || 0)], 99901, { staticNetwork: true, batchMaxCount: 1 });
const erc = new ethers.Interface([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)", "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const tokens = process.argv.slice(2);
(async () => {
  console.log("chainId", (await p.getNetwork()).chainId, "block", await p.getBlockNumber());
  for (const t of tokens) {
    const code = await p.getCode(t);
    const c = new ethers.Contract(t, erc, p);
    const r = async (f, ...a) => { try { return await c[f](...a); } catch { return null; } };
    console.log("\n==", t, "code bytes", (code.length - 2) / 2);
    if (code.length < 200) console.log("  code:", code);
    console.log("  ", await r("name"), await r("symbol"), await r("decimals"), ethers.formatEther((await r("totalSupply")) ?? 0n), "owner", await r("owner"));
    // EIP-1167 / proxy check
    const impl = await p.getStorage(t, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920c3ca505d382bbc");
    if (BigInt(impl) !== 0n) console.log("  EIP1967 impl", "0x" + impl.slice(26));
    // selectors present in bytecode (PUSH4)
    const sels = new Set(); const b = ethers.getBytes(code);
    for (let i = 0; i < b.length; i++) { const op = b[i]; if (op === 0x63 && i + 4 < b.length) sels.add(ethers.hexlify(b.slice(i + 1, i + 5))); if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; }
    console.log("  push4 count", sels.size);
    require("fs").writeFileSync(`${__dirname}/sel_${t}.txt`, [...sels].join("\n"));
  }
})().catch(e => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
