# Catatan lanjutan (per 9 Nov 2026)

Ringkasan status dan langkah berikutnya, supaya pekerjaan bisa dilanjutkan di sesi baru (mis. Claude Code di Mac).
Branch kerja: **`claude/hopeful-pascal-icu4bu`** di `fdlr28/cpanelwpku`.

## 1. Melanjutkan di Mac

Repo sudah ada di Mac pemilik proyek: **`~/Downloads/cpanelwpku`** (berisi `.env` dengan `PRIVATE_KEY` dompet admin).

```bash
cd ~/Downloads/cpanelwpku
git pull origin claude/hopeful-pascal-icu4bu
npm install
claude
```

Lalu tulis ke Claude, misalnya: *"Baca CATATAN-LANJUTAN.md, lalu lanjutkan unggah website."*
`CLAUDE.md` dibaca otomatis dan berisi konteks proyek serta batasannya (testnet saja, jangan sentuh private key).

## 2. Yang sudah selesai

* **Kontrak di Elysium testnet (99801)**, deploy 5 Nov 2026, blok 23833762:

  | Kontrak | Alamat |
  |---|---|
  | PoolManager (Uniswap v4-core 1.0.2) | `0xD02875d7Ea89e7e1f61512066828196c09FBD58d` |
  | Timelock (jeda 900 dtk) | `0x47Bab40bB879bb6E207Ac6460eD5A874ce47Db07` |
  | LaunchCore | `0xEdAc9E32f2dCa8aAF61acB7D6F2a363e283cc08E` |
  | CurveHook | `0x9bcFA072d4d0cfA213bEb83242BcA5c1d50328cc` |
  | IntegratorRegistry | `0xB340bD11629fAd01a2D14d58057209c8F1512Ede` |
  | ProtocolConfig | `0x2F409ccAb0b1d39265a2D28436C7E413E67dd8b3` |
  | FeeDistributor | `0xa175683c380D15B2E3e49753fa048Dca05774495` |
  | VestingVault | `0xf8C1554E691F45877731fD72a25df658465512b3` |
  | Router Provenalt (`HypelysRouter`, integrator #1) | `0x7389E762b0b63d8A60D307554abA27D074762e4a` |
  | USDC testnet (quote) | `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` |

  Semua alamat ada di `deployments/elysiumTestnet-v2.json`.
* **Admin = dompet pemilik `0x78DceE56aD39180adDed458B8D09D445aAbFAde1`**: proposer + canceller Timelock, treasury,
  guardian, owner router Provenalt, payout integrator #1. Timelock memegang owner config/registry/core/PoolManager.
  Deployer sementara `0x0bC6…F322` tidak memegang peran apa pun (kuncinya hanya ada di sesi cloud lama).
* **Uji asap testnet**: HYPE 33/33 (`deployments/elysiumTestnet-v2-smoke.json`), USDC 15/15
  (`deployments/elysiumTestnet-v2-smoke-usdc.json`).
* **Source terverifikasi** di explorer (Sourcify Conduit): 15/15 kontrak + token. Token baru: `node scripts/verify-sourcify.js`.
* **Nama app Provenalt** di registry (integrator #1, situs `https://provenalt.xyz`).
* **Frontend** `frontend/` siap unggah (`bash scripts/package-frontend.sh` → `dist/provenalt-frontend.zip`, isi folder
  `provenalt/`). Teruji terhadap testnet.
* **Indexer** `indexer/` selesai, teruji (e2e 19/19), dan **live di Railway**: `https://provenalt-indexer-production.up.railway.app`.

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

* Deploy lewat **Vercel CLI dari Mac**, dari folder `frontend/` (bukan root repo, supaya `.env` tidak ikut):
  `cd ~/Downloads/cpanelwpku && git pull origin claude/hopeful-pascal-icu4bu && cd frontend && npx vercel --prod`.
  Project tidak terhubung ke Git (sambungan ke repo `Provenalt/cpanelwpku` milik akun GitHub lain dilepas karena repo
  itu tidak berisi pekerjaan ini). Root Directory project kosong.
* `frontend/vercel.json`: header keamanan (larang iframe, nosniff, referrer policy). `frontend/.vercelignore`: tidak
  mengunggah `config.local.js`, `legacy/`, `.vercel/`, `.env*`, `.gitignore`.
* Token Vercel yang disimpan di environment cloud hanya bisa membaca (403 saat membuat project), jadi deploy dari sesi
  cloud tidak dipakai; `scripts/deploy-vercel.js` tersedia untuk token dengan izin penuh.
* Berikutnya: domain `provenalt.xyz` di Vercel (*Settings → Domains*) lalu DNS di registrar.

### 3b-alt. Website di cPanel (alternatif)

1. `bash scripts/package-frontend.sh` (sudah memakai indexer Railway lewat `frontend/config.js`).
2. Unggah `dist/provenalt-frontend.zip` ke `provenalt.xyz`: cPanel (Domains → Create A New Domain dengan document
   root sendiri, ekstrak zip di home lalu arahkan document root ke folder `provenalt`; jangan di root `public_html`
   yang berisi WordPress), atau hosting statis (Cloudflare Pages / Netlify). Pastikan HTTPS aktif (AutoSSL).
3. Pemilik proyek tidak ingin memakai domain `bracketedz.com`.

### 3c. Opsional / nanti

* RPC sendiri (mis. Alchemy, dibatasi ke domain) untuk frontend (`frontend/config.js` `rpcUrl`) dan indexer (`RPC_URL`).
* Sisa saldo: dompet pemilik ±3,8 USDC + token uji di Elysium; deployer sementara ±0,074 HYPE (tidak bisa dipakai lagi).
* Fase 7 (butuh persetujuan terpisah): audit eksternal, keputusan PoolManager mainnet, multisig, Timelock 48 jam,
  tinjau ulang batas alokasi instan.

## 4. Skrip yang sering dipakai (dari folder repo, dompet pemilik di `.env`)

| Tujuan | Perintah |
|---|---|
| Ganti nama/situs app di registry | `APP_URI=https://... CONFIRM=yes npx hardhat run scripts/set-app-profile.js --network elysiumTestnet` |
| Bridge USDC HyperEVM → Elysium | `AMOUNT=5 CONFIRM=yes npx hardhat run scripts/bridge-usdc-to-elysium.js --network hyperevmTestnet` |
| Uji asap USDC | `CONFIRM=yes npx hardhat run scripts/smoke-usdc-v2.js --network elysiumTestnet` |
| Verifikasi source (tanpa kunci) | `node scripts/verify-sourcify.js` |
| Paket website | `INDEXER_URL=... bash scripts/package-frontend.sh` |
| Perubahan protokol | lewat Timelock dari dompet admin: `schedule` → tunggu 900 dtk → `execute` (contoh: `scripts/handover-admin.js`) |
