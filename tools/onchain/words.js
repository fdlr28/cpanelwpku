const { ethers } = require("ethers");
const c = JSON.parse(require("fs").readFileSync((process.env.OUT || __dirname) + "/creation.json"));
const want = process.argv[2].split(",");
const show = (w) => { const b = BigInt(w); if (b === 0n) return "0"; if (w.startsWith("0x000000000000000000000000") && b > 2n**100n) return "addr 0x" + w.slice(26); if (b > 2n**250n) return "neg " + (b - 2n**256n); if (b < 10n**30n) return b.toString() + (b > 10n**12n ? ` (${ethers.formatEther(b)})` : ""); return w; };
for (const [tok, x] of Object.entries(c)) for (const l of x.logs) {
  const t0 = l.topics[0].slice(0, 10); if (!want.includes(t0)) continue;
  console.log(`\n${tok.slice(0, 8)} ${t0} @${l.address.slice(0, 8)} topics: ${l.topics.slice(1).map(show).join(" | ")}`);
  const d = l.data.slice(2); const ws = d.match(/.{64}/g) || [];
  ws.forEach((w, i) => { const s = show("0x" + w); let txt = ""; try { txt = Buffer.from(w, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, ""); } catch {} console.log(`   w${i}: ${s}${txt.length > 3 ? "   '" + txt + "'" : ""}`); });
}
