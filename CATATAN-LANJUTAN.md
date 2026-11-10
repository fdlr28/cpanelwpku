# Catatan lanjutan (per 9 Nov 2026, setelah pindah ke PancakeSwap Infinity)

Ringkasan status dan langkah berikutnya, supaya pekerjaan bisa dilanjutkan di sesi baru (mis. Claude Code di Mac).
Branch kerja: **`claude/hopeful-pascal-icu4bu`** di `fdlr28/cpanelwpku`.

## 1. Melanjutkan di Mac

Repo sudah ada di Mac pemilik proyek: **`~/factory-detector/cpanelwpku/cpanelwpku`** (berisi `.env` dengan `PRIVATE_KEY` dompet admin).

```bash
cd ~/factory-detector/cpanelwpku/cpanelwpku
git pull origin claude/hopeful-pascal-icu4bu
npm install
claude
```

Lalu tulis ke Claude, misalnya: *"Baca CATATAN-LANJUTAN.md, lalu lanjutkan unggah website."*
`CLAUDE.md` dibaca otomatis dan berisi konteks proyek serta batasannya (testnet saja, jangan sentuh private key).

## 2. Yang sudah selesai

* **Mesin pool diganti ke PancakeSwap Infinity CL** (9 Nov 2026): Uniswap v4-core berlisensi BUSL-1.1 sampai
  2027-06-15, jadi tidak bisa dipakai di mainnet tanpa izin Uniswap. Infinity (GPL-2.0-or-later) di-vendor di
  `contracts/vendor/infinity`; semua kontrak, test, skrip, SDK, frontend dan indexer sudah di-port. Detail: `docs/desain/02`
  §5.1 dan `03` fase 6b.
* **Kontrak di Elysium testnet (99801)**, deploy ulang 9 Nov 2026 di atas Infinity, blok 26697151:

  | Kontrak | Alamat |
  |---|---|
  | Infinity Vault | `0x88e40DB361BF4502c0d323e6e607F8FF22C90D15` |
  | Infinity CLPoolManager | `0xba097E61b96e3675cFB860a69ADA85727F99f262` |
  | Timelock (jeda 900 dtk) | `0xe445040EFfE64F79C3398DC1996b0ECEf03A64Ea` |
  | LaunchCore | `0xdEb59B67B47B5988AB5897dBd5A203356ABd4A66` |
  | CurveHook | `0xD17875B985e9c9945913d210f9253C9D11a13CF9` |
  | IntegratorRegistry | `0xa3fF1Ad25c379Dd234AcaB0963ac0594389f10ef` |
  | ProtocolConfig | `0x413c7BF2Dc57AEDca3Bc7DE606c23225a4AeA93E` |
  | FeeDistributor | `0x5464c879772fFe587E1f0e28BC8e4b08EA01d0A8` |
  | VestingVault | `0xf46d8ade57a0580BbA3fdEbB4E82f5aa6c190883` |
  | `ProvenaltRouter` (integrator #1) | `0xE46cA91Ee64E07f3F2061D2E046C2f91B223c758` |
  | USDC testnet (quote) | `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` |

  Semua alamat ada di `deployments/elysiumTestnet-v2.json`. Deployment lama (Uniswap v4, 5 Nov 2026) disimpan di
  `deployments/legacy-uniswapv4/`; token di sana tidak lagi tampil di website.
* **Admin = dompet pemilik `0x78DceE56aD39180adDed458B8D09D445aAbFAde1`**: satu-satunya proposer + canceller Timelock,
  treasury, guardian, owner `ProvenaltRouter`, payout integrator #1. Timelock memegang owner config, registry, core,
  Vault dan CLPoolManager Infinity. Deployer sementara `0x0bC6…F322` tidak memegang peran apa pun; integrator uji #2
  miliknya dinonaktifkan. Catatan: owner CLPoolManager (Timelock) bisa mem-pause swap, hanya lewat jeda Timelock.
* **Uji**: 112 test kontrak; uji asap testnet HYPE 33/33 (`deployments/elysiumTestnet-v2-smoke.json`). Uji USDC belum
  diulang di deployment baru karena deployer tidak memegang USDC: jalankan dari Mac (dompet pemilik memegang ±3,8 USDC):
  `CONFIRM=yes npx hardhat run scripts/smoke-usdc-v2.js --network elysiumTestnet`.
* **Source terverifikasi** di explorer (Sourcify Conduit): 14/14 (kontrak + 4 token uji). Token baru:
  `node scripts/verify-sourcify.js`.
* **Nama app Provenalt** di registry (integrator #1, situs `https://provenalt.xyz`), diatur saat deploy.
* **Indexer** di Railway sudah dipindah ke deployment baru (`RESET_DB_FOR_DEPLOYMENT`, gambar upload tetap) dan diuji.
* **Website**: `frontend/config.js` sudah berisi alamat baru dan diuji di browser terhadap testnet + indexer Railway.
  **Belum di-deploy ulang ke Vercel**: jalankan dari Mac (lihat 3b).

## 3. Pekerjaan berikutnya

### 3a. Indexer di Railway ✅ (9 Nov 2026)

Live: **`https://provenalt-indexer-production.up.railway.app`** (`/health`, `/tokens`, …; lihat `indexer/README.md`).

* Railway workspace "provenalt's Projects" (akun `aurinlynadya@gmail.com`), project **`provenalt-indexer`**
  (id `67e60f97-1386-474c-a4c7-a9f9d677fc5f`), environment `production`, service `provenalt-indexer` + `Postgres`.
  Variabel: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (RPC default: publik testnet). Healthcheck `/health`, 1 replika,
  restart on failure.
* Kode diunggah dari folder `indexer/` dengan `railway up` (tidak terhubung ke GitHub). **Untuk update:** dari folder
  `indexer/`, `railway link` (pilih project `provenalt-indexer`) sekali, lalu `railway up --service provenalt-indexer --detach`.
* Diverifikasi: sinkronisasi 5 peluncuran ±7 detik setelah start, mengikuti chain dengan jeda 20 blok; API publik
  (HTTPS, CORS `*`) sama dengan hasil uji lokal; website memakai API ini (`frontend/config.js` `indexerUrl`).
* Project lama di workspace yang sama, **jangan diubah tanpa izin**: `passionate-truth` (service `provenalt` dari repo
  `Provenalt/provenalt`, deploy terakhir FAILED) dan `gracious-harmony` (Postgres yang belum pernah jalan).

### 3b. Website di Vercel (9 Nov 2026)

Live: **https://cpanelwpku.vercel.app** — Vercel team "provenalt's projects" (akun `provenalt`), project `cpanelwpku`.

* **Deploy ulang setelah pindah ke Infinity (perlu dijalankan):** perintah di bawah. Setelah itu provenalt.xyz memakai
  kontrak baru; daftar token kosong sampai ada peluncuran baru (token uji disembunyikan).
* Deploy lewat **Vercel CLI dari Mac**, dari folder `frontend/` (bukan root repo, supaya `.env` tidak ikut):
  `cd ~/factory-detector/cpanelwpku/cpanelwpku && git pull origin claude/hopeful-pascal-icu4bu && cd frontend && npx vercel --prod`.
  Project tidak terhubung ke Git (sambungan ke repo `Provenalt/cpanelwpku` milik akun GitHub lain dilepas karena repo
  itu tidak berisi pekerjaan ini). Root Directory project kosong.
* `frontend/vercel.json`: header keamanan (larang iframe, nosniff, referrer policy). `frontend/.vercelignore`: tidak
  mengunggah `config.local.js`, `legacy/`, `.vercel/`, `.env*`, `.gitignore`.
* Token Vercel yang disimpan di environment cloud hanya bisa membaca (403 saat membuat project), jadi deploy dari sesi
  cloud tidak dipakai; `scripts/deploy-vercel.js` tersedia untuk token dengan izin penuh.
* Diverifikasi (deploy kedua): memakai indexer Railway, header keamanan aktif, `legacy/`, `.env*`, `.gitignore` dan
  `config.local.js` tidak terunggah (404); daftar token, grafik, trade dan holder tampil tanpa error di browser.
* Berikutnya: domain `provenalt.xyz` di Vercel (*Settings → Domains*) lalu DNS di registrar.

### 3d. Mainnet (status 10 Nov 2026) ✅ ter-deploy

**Kontrak mainnet live** (deploy pemilik dari Mac, 10 Nov 2026, blok 4121634, biaya 0,01155 HYPE):

| Kontrak | Alamat |
|---|---|
| Infinity Vault | `0xB717E028b28bEfF5772F302b62fce8F7B6d181AA` |
| Infinity CLPoolManager | `0x55AE3f252A33b9B2bc2B895aD9cA6EFf7E5FFe41` |
| Timelock (jeda 48 jam) | `0xEd92c2C1E00B8B1Cb29e0A674a29CDE2D779956F` |
| LaunchCore | `0x837Ac78d09bC0F4A9DcbEd3d849Cbc3A81C30CAE` |
| CurveHook | `0xa4c1EfD7Ff0c1346e83ca7473F86B905A6521f96` |
| IntegratorRegistry | `0x19f01283336114CCe15119D1CA9016816C33633B` |
| ProtocolConfig | `0x8d87a79dbFB6C25999f534e52f6e037519Ca5221` |
| FeeDistributor | `0x36601E2d58D9e8a8f232d840C0d2199651Ba01be` |
| VestingVault | `0x19F47fc151f8703e6ac55dafdd0896c062219f3D` |
| `ProvenaltRouter` (integrator #1) | `0xef144c913834F3e1977e9E387cf50ad600c31E7e` |
| USDC (quote, kanonik) | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` |

Admin = `0x78DceE56aD39180adDed458B8D09D445aAbFAde1` (proposer/canceller Timelock 48 jam, treasury, guardian, owner +
payout router). Dicek di chain 44/44, source 10/10 di Sourcify Conduit, **indexer Railway sudah melayani mainnet**,
dan **website https://provenalt.xyz sudah mainnet** (deploy Vercel dari Mac 10 Nov 2026; dicek di browser: chain 99901,
tanpa badge Testnet, memakai indexer mainnet, tanpa error; `config.local.js` dan `.env` tidak terunggah). Deploy dari
Mac sebaiknya dari jaringan tepercaya (bukan Wi-Fi dengan firewall Fortinet yang menyadap HTTPS).
Testnet tetap ada di chain (`deployments/elysiumTestnet-v2.json`), tapi tidak lagi punya indexer maupun website.

Riwayat persiapan (pilihan A: deploy dari Mac dengan dompet sendiri). Panduan:
**`docs/desain/06-runbook-mainnet.md`**. Ringkasnya, dari folder repo di Mac:

1. `git pull origin claude/hopeful-pascal-icu4bu && npm install`
2. latihan: `ADMIN=0x... npx hardhat run scripts/deploy-mainnet-v2.js`
3. live: `ADMIN=0x... CONFIRM=mainnet-99901 npx hardhat run scripts/deploy-mainnet-v2.js --network elysiumMainnet`
4. commit `deployments/elysiumMainnet-v2.json`, lalu verifikasi source, indexer, website (runbook langkah 4–7).

Siapkan ≥ 0,05 HYPE di deployer (perkiraan biaya ±0,012 HYPE pada 0,5 gwei). Dompet pemilik di mainnet: 0,029 HYPE
(10 Nov 2026). Serah terima admin selesai dalam run yang sama (Timelock mulai dengan jeda 0, lalu dinaikkan ke
48 jam di batch yang sama). Data mainnet (RPC, explorer, USDC kanonik) ada di `scripts/lib/networks.js`.


* Pemilik proyek meminta mainnet (99901). Keputusan: **tanpa Safe multisig**; admin mainnet = satu dompet milik
  pemilik (seperti testnet: proposer/canceller Timelock, treasury, guardian, owner router). Saran yang tetap berlaku:
  dompet itu di hardware wallet, kunci tidak disimpan di `.env`/cloud, jeda Timelock mainnet 48 jam sesuai desain.
* ✅ Penghalang lisensi selesai: mesin pool kini PancakeSwap Infinity CL (GPL-2.0-or-later), di-deploy sendiri.
* Belum: audit eksternal (disarankan sebelum dana publik masuk); RPC Alchemy untuk indexer (`RPC_URL` di Railway) bila
  RPC publik membatasi; peluncuran pertama di mainnet sebagai uji nyata.
* Indexer testnet sengaja **tidak dihapus**: provenalt.xyz bergantung padanya. Saat kontrak mainnet ada, service
  Railway yang sama diarahkan ke mainnet (`indexer/deployment.json` mainnet + `RESET_DB_FOR_DEPLOYMENT`, atau database
  baru). Website mengabaikan indexer yang melayani chain/core lain, jadi urutan peralihan aman: indexer dulu, lalu
  website (`node scripts/make-frontend-config.js deployments/elysiumMainnet-v2.json`).
* Kontrak Safe 1.3.0 ada di Elysium mainnet dan testnet (dicek on-chain), bila kelak berubah pikiran.

### 3e. Logo (10 Nov 2026)

Logo dari pemilik proyek (monogram P merah marun di atas krem) disimpan di `docs/brand/provenalt-logo.jpg`. Dari situ
dibuat: logo header `frontend/logo.png`, `favicon.ico` (16/32/48), `icon-192.png`, `apple-touch-icon.png`, dan
gambar pratinjau link `og-image.png` (1200×630, meta Open Graph + kartu X). Teks "Provenalt" di header kini putih
agar logo menonjol. `docs/brand/provenalt-icon-512.png` bisa dipakai untuk foto profil (mis. X). Butuh deploy
ulang Vercel dari Mac agar tampil di provenalt.xyz.

### 3c. Pembaruan website (9 Nov 2026)

Permintaan pemilik proyek, sudah dikerjakan dan **live di https://provenalt.xyz** (deploy dari Mac 9 Nov 2026; domain
Namecheap → Vercel, HTTPS + HSTS aktif; `cpanelwpku.vercel.app` dialihkan ke provenalt.xyz). Dicek di browser: UI
Inggris tanpa kata "Eridanos", upload gambar dari origin provenalt.xyz berhasil, estimasi dev buy tampil, tanpa error:
* UI dalam **bahasa Inggris**; kata "Eridanos" tidak tampil lagi (sumber peluncuran: "via Provenalt", "via app #N",
  "direct launch"); label **Testnet** di header; link **X https://x.com/provenalt** di header dan footer.
* **Upload gambar** di form peluncuran: diperkecil ke 512 px di browser lalu diunggah ke indexer (`POST /upload`,
  hanya dari origin website, PNG/JPEG/WebP/GIF, maks 1 MB). Masih bisa menempel URL gambar.
* **Dev buy** cukup pilih None/1%/2,5%/5%/10%; biaya dihitung dari kurva (`SDK.estimateBuyCost`, cocok dengan dev buy
  nyata) dan batas dana dikirim otomatis (+1%, sisa dikembalikan). Kolom "dana maks" dihapus.
* Kolom alokasi creator, cliff dan vesting **disembunyikan** (hanya UI; kontrak tetap mendukung, website mengirim 0).
* Indexer Railway sudah di-deploy ulang dengan endpoint upload (variabel `PUBLIC_URL`, `UPLOAD_ORIGINS`).
* **Token uji asap disembunyikan** dari daftar dan statistik (kini 4 token uji deployment Infinity di `indexer/deployment.json` `hiddenTokens`,
  bisa ditimpa variabel `HIDDEN_TOKENS`; cadangan yang sama di `frontend/config.js` `hiddenTokens`). Halaman detailnya
  tetap bisa dibuka lewat link langsung. Live di indexer Railway; daftar di provenalt.xyz kini kosong.
* Uji: E2E browser lokal tanpa indexer dan dengan indexer (termasuk upload) lulus; e2e indexer 25/25; 112 test kontrak.

### 3b-alt. Website di cPanel (alternatif)

1. `bash scripts/package-frontend.sh` (sudah memakai indexer Railway lewat `frontend/config.js`).
2. Unggah `dist/provenalt-frontend.zip` ke `provenalt.xyz`: cPanel (Domains → Create A New Domain dengan document
   root sendiri, ekstrak zip di home lalu arahkan document root ke folder `provenalt`; jangan di root `public_html`
   yang berisi WordPress), atau hosting statis (Cloudflare Pages / Netlify). Pastikan HTTPS aktif (AutoSSL).
3. Pemilik proyek tidak ingin memakai domain `bracketedz.com`.

### 3c. Opsional / nanti

* RPC sendiri (mis. Alchemy, dibatasi ke domain) untuk frontend (`frontend/config.js` `rpcUrl`) dan indexer (`RPC_URL`).
* Sisa saldo: dompet pemilik ±3,8 USDC + token uji di Elysium; deployer sementara ±0,067 HYPE (kuncinya hanya di sesi cloud).
* Fase 7: audit eksternal, Timelock 48 jam, tinjau ulang batas alokasi instan (pool engine dan multisig sudah diputuskan).

## 4. Skrip yang sering dipakai (dari folder repo, dompet pemilik di `.env`)

| Tujuan | Perintah |
|---|---|
| Ganti nama/situs app di registry | `APP_URI=https://... CONFIRM=yes npx hardhat run scripts/set-app-profile.js --network elysiumTestnet` |
| Bridge USDC HyperEVM → Elysium | `AMOUNT=5 CONFIRM=yes npx hardhat run scripts/bridge-usdc-to-elysium.js --network hyperevmTestnet` |
| Uji asap USDC | `CONFIRM=yes npx hardhat run scripts/smoke-usdc-v2.js --network elysiumTestnet` |
| Verifikasi source (tanpa kunci) | `node scripts/verify-sourcify.js` |
| Paket website | `INDEXER_URL=... bash scripts/package-frontend.sh` |
| Perubahan protokol | lewat Timelock dari dompet admin: `schedule` → tunggu 900 dtk → `execute` (contoh: `scripts/handover-admin.js`) |
