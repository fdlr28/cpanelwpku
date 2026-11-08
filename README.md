# Elysium Launchpad

Launchpad token dengan bonding curve (gaya fair-launch) untuk **Elysium**, L2 dari Kinetiq
(Arbitrum Orbit yang settle ke HyperEVM, gas pakai **HYPE**).

```
createToken ──► bonding curve (x·y=k, virtual reserve, HYPE) ──► curve penuh ──► auto-listing DEX
                 buy / sell, fee 1% (25% creator / 75% protokol)       LP dikunci di 0xdEaD
```

## Isi repo

| Path | Isi |
|---|---|
| `contracts/ElysiumLaunchpad.sol` | Kontrak utama: create token, buy/sell di curve, fee, graduation ke DEX |
| `contracts/LaunchToken.sol` | ERC20 supply tetap yang dibuat per launch |
| `contracts/interfaces/IUniswapV2.sol` | Interface factory/pair Uniswap-V2 & WHYPE |
| `contracts/test/WrappedNative.sol` | Mock WHYPE untuk test/lokal |
| `test/` | 21 test (Hardhat + Uniswap V2 asli dari `@uniswap/v2-core` / `v2-periphery`) |
| `scripts/deploy-dex.js` | Deploy Uniswap V2 Factory + Router02 (bytecode resmi) — Elysium belum punya DEX V2 |
| `scripts/deploy.js` | Deploy launchpad ke Elysium testnet/mainnet |
| `scripts/addresses.js` | Alamat kontrak resmi Elysium testnet (dari docs) |
| `scripts/deploy-local.js` | Deploy stack lengkap (WHYPE + UniV2 + launchpad) di node lokal |
| `frontend/` | Web statis (HTML/JS, tanpa build) — bisa langsung di-upload ke cPanel |

## Mekanisme

**Supply per token**: 1.000.000.000 (18 desimal). 800M dijual di bonding curve, sisanya untuk LP.

**Bonding curve**: constant product dengan virtual reserve.
`tokensOut = vT · netIn / (vN + netIn)`, harga = `vN / vT`.
`virtualToken = S² / (2S − N)` (S = curve supply, N = total supply) membuat harga listing di DEX
**sama persis** dengan harga terakhir di curve. Dengan default 1B/800M, HYPE yang terkumpul saat
graduation = `3 × virtualNative` (default `virtualNative` = 100 HYPE → ±300 HYPE, market cap
graduation ±1.500 HYPE). Atur lewat `VIRTUAL_NATIVE` saat deploy.

**Fee** (bisa diubah owner, ada batas atas):
- Trading fee: default 1% (maks 5%), dari HYPE di setiap buy/sell.
- Bagian creator: default 25% dari trading fee (seperti default Ascend), sisanya protokol.
- Graduation fee: default 0% (maks 10%) dari HYPE yang terkumpul.
- Creation fee: default 0 HYPE.
- Fee di-*accrue* dan diklaim sendiri (`claimCreatorFees`, `claimProtocolFees` → `feeRecipient`).

**Graduation**: buy yang menghabiskan sisa curve otomatis di-cap (kelebihan HYPE di-refund), lalu
dalam transaksi yang sama: HYPE di-wrap ke WHYPE, HYPE + token dikirim ke pair Uniswap-V2, `mint`
LP ke `0x…dEaD` (terkunci permanen), token sisa di-burn. Setelah itu trading pindah ke DEX —
frontend otomatis beralih ke swap lewat Router02 (`config.router`).

**Kompatibel dengan lifecycle Elysium → HyperCore.** `LaunchToken` adalah ERC-20 standar dengan
metadata tetap (name/symbol/decimals immutable), tanpa fee-on-transfer/rebase — persis syarat
*mirror bridge* Elysium → HyperEVM (`ElysiumBridgeFactory.createL2Wallet(token)`), sehingga token
yang sukses bisa lanjut ke HyperCore spot lalu HIP-3, sesuai jalur yang dijelaskan di docs.

**Keamanan yang sudah ditangani**
- Transfer token ke pair diblokir sebelum graduation → pool tidak bisa di-seed dengan harga palsu.
- Donasi WHYPE + `sync()` ke pair tidak bisa memblokir graduation (pair di-`mint` langsung, bukan lewat router).
- Front-run `createPair` dengan alamat token yang diprediksi tidak memblokir `createToken`.
- Slippage guard di buy/sell/create, `ReentrancyGuard`, pembayaran fee pakai pull-pattern.
- `pause` hanya menghentikan create & buy — **sell selalu bisa** (dana user tidak bisa dikunci owner).
- Sell tidak butuh `approve` (launchpad hanya bisa menarik token dari pemanggil `sell`).
- Tidak memakai `block.number` (di Arbitrum Orbit itu nomor blok parent chain).
- Test solvency acak: saldo HYPE kontrak selalu ≥ semua kewajiban, semua holder selalu bisa sell.

## Cara pakai

```bash
npm install
```

```bash
npm test
```

### Lokal (tanpa wallet sungguhan)

```bash
npx hardhat node
```

```bash
npm run deploy:local
```

Lalu di `frontend/index.html` aktifkan baris `config.local.js`, dan sajikan folder `frontend/`
(misal `python3 -m http.server 8080 -d frontend`). Import salah satu private key Hardhat ke MetaMask
dengan network `http://127.0.0.1:8545`, chainId 31337.

### Deploy ke Elysium testnet

1. `cp .env.example .env`, isi `PRIVATE_KEY` (HYPE testnet dari faucet: elysium.kinetiq.xyz → Faucet).
   Disarankan `ELYSIUM_TESTNET_RPC` diisi endpoint Alchemy
   (`https://elysium-testnet.g.alchemy.com/v2/{API_KEY}`) — RPC publik dipakai bersama.
2. Deploy DEX Uniswap V2 sendiri (karena di Elysium Uniswap masih berstatus *Announced*):

```bash
npm run deploy:dex:testnet
```

3. Deploy launchpad (otomatis memakai factory dari langkah 2 dan WHYPE resmi testnet).
   Opsional: `VIRTUAL_NATIVE=1` agar cepat graduate saat testing, `FEE_RECIPIENT`.

```bash
npm run deploy:testnet
```

4. Salin `launchpad`, `router`, `deployBlock` yang dicetak ke `frontend/config.js`.

Kalau nanti ada DEX V2-compatible resmi di Elysium, cukup isi `DEX_FACTORY` dan `DEX_ROUTER` di
`.env` dan lewati langkah 2. Verifikasi kontrak: halaman *Verify contract* di explorer Elysium.

### Hosting frontend di cPanel

Jalankan `bash scripts/package-frontend.sh` → `dist/provenalt-frontend.zip`, berisi satu folder `provenalt/`
(`index.html`, `app.js`, `style.css`, `config.js`, `eridanos-sdk.js`, `vendor/`). Di cPanel: File Manager → folder
home → Upload zip → klik kanan → Extract, lalu jadikan `/home/<user>/provenalt` document root domain/subdomain-nya
(Domains → Create A New Domain). Bisa juga diunggah ke hosting statis seperti Cloudflare Pages atau Netlify.
Jangan taruh isinya di root `public_html` bila di sana ada WordPress: `index.html` akan menimpa halaman depan
WordPress. Tidak perlu Node.js di server; semuanya statis dan ethers.js sudah dibundel di `vendor/`.

## Data jaringan (dari docs resmi Elysium)

Sumber: [elysium.kinetiq.xyz/docs](https://elysium.kinetiq.xyz/docs) (diperbarui 20 Okt – 2 Nov 2026).

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | `99801` | diumumkan saat launch |
| RPC publik | `https://testnet-rpc.elysium.kinetiq.xyz` | diumumkan saat launch |
| RPC Alchemy | `https://elysium-testnet.g.alchemy.com/v2/{KEY}` | `https://elysium-mainnet.g.alchemy.com/v2/{KEY}` |
| Explorer | `https://explorer-elysium-testnet.t.conduit.xyz` (verifikasi: Sourcify `https://contracts.conduit.xyz`) | diumumkan saat launch |
| Settle ke | HyperEVM testnet (998) | HyperEVM (999) |
| WHYPE | `0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234` | — |
| USDC | `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` | — |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | — |
| Bridge factory (mirror ke HyperEVM) | `0xb94A38a4aC46970559E89E566f2486a3Fc56BE5a` | — |

- Stack: Arbitrum Orbit (stock ArbOS) dijalankan Conduit, blok 100 ms, target 300 Mgas/s, gas HYPE native (1:1 dari HyperEVM).
- Standar EVM — Hardhat/Foundry/ethers/viem jalan tanpa interface khusus. Precompile data HyperCore & `ElysiumCoreWriter` baru datang ±4 minggu setelah mainnet.
- Uniswap, 0x, KyberSwap masih *Announced*; belum ada alamat DEX resmi, makanya ada `deploy-dex.js`.
- Urutan transaksi berdasarkan priority fee, single sequencer, tanpa jalur khusus.
- ⚠️ viem `elysiumTestnet` bawaan adalah chain lain (Vulcan Forged, 1338) — definisikan 99801 manual.

## Perbedaan dengan Ascend & roadmap

Dari [docs Ascend](https://ascendlaunch.gitbook.io/docs) (litepaper Sept 2026):

| | Ascend | Launchpad ini |
|---|---|---|
| Mekanisme launch | Langsung ke *closed hook pool* (Uniswap V4 hooks), **tanpa** fase bonding curve | Bonding curve → graduation ke pool Uniswap V2 |
| Quote asset | USDC & RWA ter-tokenisasi | HYPE native |
| Fee token | 1% selamanya: 25% deployer (default), 50% creator/operator takeover yang disetujui | 1% selama di curve, 25% creator (bisa diatur); setelah graduation hanya fee LP 0.3% |
| Fee lain | Swap fee terpisah, 20% ke referrer (USDC) | — |
| Revenue protokol | 50% beli HYPE (40% staking milik protokol, 30% buyback token ekosistem, 20% ops, 10% reward staker), 50% beli KNTQ (60% burn, 20% LP KNTQ/kHYPE, 20% poin) | Diklaim ke `feeRecipient` |
| Lifecycle | Launch → Ascended → HyperCore spot → HIP-3 perps | Token kompatibel mirror bridge; alurnya belum diotomasi |
| Ekstra | Staking HYPE→kHYPE (yield untuk beli token ekosistem), NFT boost, referral, tanpa token Ascend | — |

Roadmap untuk mendekati model Ascend:

- [ ] Graduation/launch ke Uniswap V4 hook pool → fee 1% tetap berjalan setelah listing (menunggu Uniswap V4 di Elysium)
- [ ] Opsi quote USDC (`0x7D29…47b2` di testnet) selain HYPE
- [ ] Split fee creator 25%/50% (creator terverifikasi) + takeover operator
- [ ] Modul revenue: buyback HYPE/KNTQ, staking kHYPE
- [ ] Referral dari swap fee, profil trader & poin
- [ ] Otomasi mirror ke HyperEVM (`createL2Wallet`) untuk token yang lolos kriteria
- [ ] Indexer (subgraph/Ponder) + chart harga, upload gambar ke IPFS
- [ ] Audit keamanan sebelum mainnet

**Kode ini belum diaudit.** Jangan dipakai di mainnet dengan dana nyata sebelum audit.
