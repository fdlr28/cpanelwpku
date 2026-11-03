const { ethers } = require("ethers");
const p = new ethers.JsonRpcProvider("https://rpc-live.elyspump.com", 99901, { staticNetwork: true, batchMaxCount: 1 });
const fs = require("fs");
const A = { kleosFactory: "0x2dA68edFF4588A77B55A829689C382F2acB39502", kleosHook: "0xD5068e7f4e2D70d5eFbaC6fD28A8407252E1EAcC", kleosPlatform: "0xc9EaECE8829eBCe9aF2a6E15d01b4C586B0faf7E", boxaLauncher: "0x00d4C904f74f74c6920C95E3Ee807ab3C52DD205", boxaHook: "0xBCc1f22d137C1D98DFa5548E4d4261D7AeE06acC", obolV1: "0x7D1904Bfb2472A0Ef97d886139A4236060e064aB", obolV2: "0xfeE823BE55EE12b8C3A76aff0bd69470aFAf2348" };
(async () => {
  const head = await p.getBlockNumber(); const span = Number(process.env.SPAN || 80000);
  const all = {};
  for (const [name, addr] of Object.entries(A)) {
    const hist = {}; const samples = {};
    for (let from = head - span; from <= head; from += 10000) {
      const logs = await p.getLogs({ address: addr, fromBlock: from, toBlock: Math.min(head, from + 9999) });
      for (const l of logs) { const t = l.topics[0]; hist[t] = (hist[t] || 0) + 1; (samples[t] = samples[t] || []).length < 3 && samples[t].push(l); }
    }
    all[name] = { addr, hist, samples };
    console.log(`\n${name} ${addr}`); for (const [t, n] of Object.entries(hist).sort((a, b) => b[1] - a[1])) console.log(`   ${t.slice(0, 10)} x${n}  topics=${samples[t][0].topics.length - 1} words=${(samples[t][0].data.length - 2) / 64}`);
  }
  fs.writeFileSync((process.env.OUT || __dirname) + "/scan.json", JSON.stringify(all, null, 1));
})().catch(e => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
