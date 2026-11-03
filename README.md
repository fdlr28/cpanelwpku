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
| `test/` | 20 test (Hardhat + Uniswap V2 asli dari `@uniswap/v2-core`) |
| `scripts/deploy.js` | Deploy ke Elysium testnet/mainnet |
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
LP ke `0x…dEaD` (terkunci permanen), token sisa di-burn. Setelah itu trading pindah ke DEX.

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

1. `cp .env.example .env`, isi `PRIVATE_KEY` (ambil HYPE testnet dari faucet Elysium).
2. Isi `DEX_FACTORY` (factory Uniswap-V2-compatible di Elysium) dan `WRAPPED_NATIVE` (WHYPE).
   Alamatnya **ambil dari dokumentasi resmi** — lihat catatan di bawah.
3. Opsional: `VIRTUAL_NATIVE` (mis. `1` untuk testnet agar cepat graduate), `FEE_RECIPIENT`.
4. Deploy:

```bash
npm run deploy:testnet
```

Alamat tersimpan di `deployments/elysiumTestnet.json`. Salin `launchpad` dan `deployBlock` ke
`frontend/config.js`.

### Hosting frontend di cPanel

Upload isi folder `frontend/` (`index.html`, `app.js`, `style.css`, `config.js`, `vendor/`) ke
`public_html` lewat File Manager/FTP. Tidak perlu Node.js di server — semua statis, ethers.js
sudah dibundel di `vendor/`.

## Catatan penting / yang perlu diverifikasi

Dokumentasi `elysium.kinetiq.xyz/docs` dan `ascendlaunch.gitbook.io` **tidak bisa diakses** dari
lingkungan tempat kode ini dibuat. Data jaringan di bawah diambil dari sumber sekunder
(Chainstack, Alchemy, QuickNode, berita) dan **harus dicek ulang di docs resmi**:

| | Nilai | Status |
|---|---|---|
| Testnet chain ID | `99801` | dikonfirmasi beberapa sumber |
| Testnet RPC publik | `https://testnet-rpc.elysium.kinetiq.xyz` | sumber tidak resmi — lebih aman pakai endpoint Alchemy/Chainstack/QuickNode sendiri |
| Explorer testnet | `https://explorer-elysium-testnet.t.conduit.xyz` | sumber berbeda-beda |
| Gas token | HYPE | dikonfirmasi |
| Mainnet | dijadwalkan 9 Nov 2026; chain ID/RPC belum dipublikasikan | isi `ELYSIUM_RPC` & `ELYSIUM_CHAIN_ID` nanti |
| DEX | Nest (live sejak blok pertama mainnet), Uniswap V2 & V4 direncanakan | alamat factory & WHYPE belum didapat |

⚠️ viem punya export `elysiumTestnet` bawaan — itu chain **lain** (Vulcan Forged, chainId 1338).
Definisikan chain 99801 manual.

Graduation di kontrak ini mengasumsikan DEX **Uniswap-V2-compatible** (`getPair`/`createPair`/`mint`).
Kalau Nest bukan V2 (mis. V3/ve(3,3)), bagian `_graduate` perlu adaptor.

## Perbedaan dengan Ascend & roadmap

Menurut sumber publik, Ascend memakai pool **Uniswap V4 hook** yang di-quote dalam **USDC**, dengan
fee 1% yang tetap berlaku setelah launch (25% deployer / 75% protokol) dan revenue protokol untuk
buyback HYPE/KNTQ. Versi ini adalah MVP yang lebih sederhana:

- [ ] Graduation ke Uniswap V4 dengan hook fee → creator tetap dapat fee setelah listing
- [ ] Opsi quote token USDC (selain HYPE native)
- [ ] Modul buyback/treasury untuk revenue protokol
- [ ] Indexer (subgraph/Ponder) untuk chart harga & daftar token yang cepat
- [ ] Upload gambar ke IPFS dari frontend
- [ ] Audit keamanan sebelum mainnet

**Kode ini belum diaudit.** Jangan dipakai di mainnet dengan dana nyata sebelum audit.
