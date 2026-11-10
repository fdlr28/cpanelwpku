# 06 · Runbook deploy mainnet

Untuk pemilik proyek: deploy dijalankan **dari Mac dengan dompet sendiri** (pilihan A, 10 Nov 2026). Skripnya
`scripts/deploy-mainnet-v2.js`; skrip tidak membaca, meminta, atau mencetak kunci (Hardhat menandatangani dengan
`PRIVATE_KEY` di `.env`). Status: **belum dijalankan**.

## Apa yang dilakukan skrip

Satu kali jalan, sekitar 25 transaksi:

1. Deploy Vault + CLPoolManager PancakeSwap Infinity sendiri (GPL-2.0-or-later).
2. Deploy Timelock dengan jeda **0** dan deployer sebagai satu-satunya proposer (sementara; deployer memang pemilik
   semua kontrak pada titik ini).
3. Deploy ProtocolConfig, IntegratorRegistry, VestingVault, CurveHook, FeeDistributor, LaunchCore.
4. Quote + preset kurva: preset 1 = HYPE, preset 2 = USDC kanonik.
5. Router Provenalt (`ProvenaltRouter`, integrator #1, situs `https://provenalt.xyz`), owner langsung = `PROVENALT_OWNER`.
6. Serah terima dalam satu batch Timelock yang langsung dieksekusi: Timelock menerima owner config, registry, core dan
   Vault Infinity; `ADMIN` mendapat peran proposer + canceller (dicabut dari deployer bila berbeda); jeda dinaikkan ke
   **48 jam**. CLPoolManager dipindah langsung ke Timelock.
7. Memeriksa semua owner, peran, treasury, guardian, router dan integrator #1. Bila ada yang tidak sesuai, skrip
   berhenti dengan error.

Jadi tidak ada jendela 48 jam di mana kunci deployer saja menguasai protokol: begitu skrip selesai, perubahan apa pun
harus lewat Timelock 48 jam dari dompet `ADMIN`.

Hasil: `deployments/elysiumMainnet-v2.json` (alamat saja, tanpa rahasia).

## Pagar pengaman di skrip

| Kondisi | Akibat |
|---|---|
| Chain selain 99901 (atau 31337 untuk latihan) | ditolak |
| Tanpa `CONFIRM=mainnet-99901` | ditolak (`CONFIRM=yes` tidak cukup) |
| Tanpa `ADMIN`, alamat nol, atau checksum alamat salah | ditolak |
| `MAINNET_TIMELOCK_DELAY` < 172800 (48 jam) | ditolak (default 48 jam; `TIMELOCK_DELAY` testnet di `.env` diabaikan) |
| `APP_URI` kosong | memakai `https://provenalt.xyz` |
| USDC bukan token kanonik `0xb47c…0B65` (dicek juga simbol, 6 desimal, `l1Address` = USDC Circle di HyperEVM) | ditolak |
| `TREASURY`, `GUARDIAN`, `PROVENALT_OWNER` atau `PROVENALT_PAYOUT` berbeda dari `ADMIN` | ditandai di rencana yang dicetak |
| Saldo deployer < 1,5× perkiraan biaya | ditolak |
| `deployments/elysiumMainnet-v2.json` atau `.partial.json` sudah ada | ditolak (mencegah deploy ganda) |
| Sebelum transaksi pertama | rencana dicetak, lalu 15 detik untuk batal (Ctrl+C) |

Semua pagar di atas sudah diuji di node lokal yang menyamar sebagai chain 99901 (10 Nov 2026).

## Keputusan sebelum menjalankan

1. **Dompet.** Paling sederhana: deployer = dompet di `.env` (`0x78Dc…Fade1`) dan `ADMIN` = alamat yang sama.
   Disarankan: `ADMIN` = hardware wallet, deployer = dompet `.env`. Skrip mencabut semua peran deployer di akhir run.
2. **Harga awal kurva** (default sama dengan testnet; skrip mencetaknya):
   * preset HYPE: tick −173200 ≈ 3,0 × 10⁻⁸ HYPE/token, market cap awal ≈ **30 HYPE**;
   * preset USDC: tick −393800 ≈ 7,9 × 10⁻⁶ USDC/token, market cap awal ≈ **$7.913**.

   Ubah dengan `HYPE_START_TICK` / `USDC_START_TICK` bila perlu. Setelah deploy, preset baru hanya bisa ditambah lewat
   Timelock 48 jam.
3. **Audit eksternal** belum dilakukan (disarankan sebelum dana publik masuk; lihat catatan di `04-review-fase4.md`).

## Prasyarat

* Repo di Mac sudah di-`git pull` dari branch `claude/hopeful-pascal-icu4bu`, lalu `npm install`.
* `.env`: `PRIVATE_KEY` (dompet deployer Anda), dan disarankan `ELYSIUM_MAINNET_RPC` = endpoint Alchemy mainnet
  (`https://elysium-mainnet.g.alchemy.com/v2/<KEY>`). Tanpa itu skrip memakai RPC publik `https://rpc.elysium.kinetiq.xyz`.
* **HYPE di Elysium mainnet** pada dompet deployer. Biaya ±23–25 juta gas: pada 0,5 gwei (10 Nov 2026) ±0,012 HYPE.
  Siapkan **≥ 0,05 HYPE**. HYPE dibawa dari HyperEVM lewat bridge `https://elysium.kinetiq.xyz` (menu Bridge).
* Dompet `ADMIN` juga butuh sedikit HYPE untuk transaksi Timelock nanti.

## Langkah

1. **Test**:

```bash
npx hardhat test
```

2. **Latihan** (lokal, tanpa kunci, tanpa biaya). Ganti `0x...` dengan alamat ADMIN:

```bash
ADMIN=0x... npx hardhat run scripts/deploy-mainnet-v2.js
```

   Periksa rencana yang dicetak (admin, treasury, guardian, `timelock delay 172800 s (48.0 h)`,
   `app uri https://provenalt.xyz`, harga awal) dan baris `end state checked ✓`. Deployer di latihan adalah akun uji
   Hardhat; saat live, dompet dari `PRIVATE_KEY`.

   Opsional, latihan di salinan mainnet (USDC asli). Butuh RPC **archive** (Alchemy); RPC komunitas hanya menyimpan state
   beberapa detik sehingga fork berhenti di tengah jalan. Terminal 1:

```bash
FORK_URL=https://elysium-mainnet.g.alchemy.com/v2/KEY npx hardhat node
```

   Terminal 2:

```bash
ADMIN=0x... npx hardhat run scripts/deploy-mainnet-v2.js --network localhost
```

```bash
npx hardhat run scripts/smoke-testnet-v2.js --network localhost
```

3. **Deploy live** (transaksi sungguhan, HYPE sungguhan):

```bash
ADMIN=0x... CONFIRM=mainnet-99901 npx hardhat run scripts/deploy-mainnet-v2.js --network elysiumMainnet
```

   Butuh beberapa menit. Bila berhenti di tengah jalan, jangan diulang: `deployments/elysiumMainnet-v2.partial.json`
   mencatat apa yang sudah ada (skrip juga menolak jalan lagi selama file itu ada). Kirim isi file dan output-nya ke Claude.

4. **Simpan hasil** ke repo (alamat saja):

```bash
git add deployments/elysiumMainnet-v2.json && git commit -m "Mainnet deployment record" && git push origin claude/hopeful-pascal-icu4bu
```

5. **Verifikasi source** (tanpa kunci, tanpa gas; bisa juga dari sesi Claude di cloud). Sourcify Conduit mendukung chain 99901:

```bash
node scripts/verify-sourcify.js deployments/elysiumMainnet-v2.json
```

6. **Indexer ke mainnet.** Service Railway `provenalt-indexer` yang sama dipindah ke mainnet. Data testnet di database
   dihapus; gambar upload tetap. Alternatifnya, buat service baru dan biarkan yang testnet.

```bash
node indexer/scripts/copy-deployment.js elysiumMainnet
```

   Di Railway (service `provenalt-indexer` → Variables): `RESET_DB_FOR_DEPLOYMENT=99901:<alamat core huruf kecil>` dan
   disarankan `RPC_URL=<endpoint Alchemy mainnet>`. Lalu dari folder `indexer/`:

```bash
railway up --service provenalt-indexer --detach
```

   Cek `https://provenalt-indexer-production.up.railway.app/health`: `chainId` 99901, `core` = alamat core mainnet,
   `lastError` null.

7. **Website ke mainnet** (setelah indexer). Badge "Testnet" hilang otomatis. Website mengabaikan indexer yang masih
   melayani chain atau core lain, dan membaca chain langsung.

```bash
node scripts/make-frontend-config.js deployments/elysiumMainnet-v2.json
```

```bash
cd frontend && npx vercel --prod
```

8. **Peluncuran pertama**: satu peluncuran kecil lewat website (dev buy kecil), cek beli/jual dan halaman token. Uji asap
   otomatis (`smoke-testnet-v2.js`) sengaja menolak mainnet.

## Setelah deploy

* Semua perubahan protokol lewat Timelock: `schedule` dari dompet `ADMIN`, tunggu 48 jam, lalu `execute` (siapa pun).
  Owner Timelock juga memegang `pause()` CLPoolManager (membekukan swap semua pool); kewenangan itu pun hanya lewat
  jeda 48 jam.
* Guardian bisa langsung `LaunchCore.pause()` (peluncuran baru) dan `IntegratorRegistry.pauseRegistration()`.
* Owner `ProvenaltRouter` bisa langsung `setPayout`, `setSigner`, `setProfile`, `queuePolicy`.
* Skrip admin yang ada (`handover-admin.js`, `set-app-profile.js`, `timelock-execute-accept.js`) sengaja hanya untuk
  testnet; versi mainnet dibuat saat dibutuhkan.

## Data jaringan mainnet

Sumber: `elysium.kinetiq.xyz/docs` (Connecting to Elysium, Contract addresses; diperbarui 9 Nov 2026). Dicek di chain
10 Nov 2026. Juga ada di `scripts/lib/networks.js`.

| | |
|---|---|
| Chain ID | `99901` |
| RPC publik | `https://rpc.elysium.kinetiq.xyz` (dipakai bersama; produksi sebaiknya Alchemy) |
| RPC Alchemy | `https://elysium-mainnet.g.alchemy.com/v2/{KEY}` |
| Explorer | `https://elysium.kinetiq.xyz` (`/address/0x…`, `/tx/0x…`) |
| Verifikasi source | Sourcify Conduit `https://contracts.conduit.xyz` (mendukung 99901) |
| USDC | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` (6 desimal; `l1Address` = USDC Circle HyperEVM `0xb88339CB7199b77E23DB6E890353E22632Ba630f`) |
| WHYPE | `0xbA876237B0F021A6c6D852d6c26E107997cC5E81` |
| Gas | ±0,5 gwei (10 Nov 2026) |

## Uji skrip (10 Nov 2026, sesi Claude, tanpa kunci)

* Latihan lokal: deploy lengkap, semua pengecekan akhir lulus, 23,2 juta gas; jalur `ADMIN` = deployer dan `ADMIN` ≠
  deployer.
* Fork mainnet (USDC asli): deploy lengkap lulus. Uji asap di fork tidak selesai karena RPC komunitas kehilangan state.
* Chain lokal dengan output skrip mainnet: uji asap HYPE 33/33, USDC 15/15, e2e indexer 26/26.
* Mode live di node lokal yang menyamar sebagai 99901: semua pagar di atas, file progres, penolakan deploy kedua,
  saldo kurang.
* Website dengan config mainnet: badge Testnet hilang, indexer testnet diabaikan, estimasi dev buy dari chain, tanpa error.
