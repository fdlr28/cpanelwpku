# 05 · Runbook deploy testnet (fase 6)

Runbook ini ditulis untuk pemilik proyek yang men-deploy dengan kunci sendiri. Deploy pertama (5 Nov 2026) dijalankan
dari sesi Claude dengan kunci sementara; lihat §Deployment aktif. Skrip menolak chain selain
Elysium testnet (99801) dan jaringan lokal (31337); mainnet tidak didukung.

## Prasyarat

1. Node 22 dan repo ini (`npm install`).
2. Dompet deployer berisi HYPE testnet (faucet Elysium).
3. `.env` (salin dari `.env.example`):
   * `PRIVATE_KEY` — kunci deployer Anda (jangan pernah di-commit);
   * `ELYSIUM_TESTNET_RPC` — disarankan endpoint Alchemy sendiri;
   * opsional: `TREASURY`, `GUARDIAN`, `TIMELOCK_PROPOSER` (alamat Safe), `TIMELOCK_DELAY` (detik),
     `PROVENALT_OWNER`, `PROVENALT_PAYOUT`, `POOL_MANAGER` (bila memakai PoolManager v4 kanonik yang sudah ada).

## Langkah

1. **Dry run** (lokal, tanpa kunci, membuktikan skrip dan serah terima Timelock):

```bash
npx hardhat run scripts/deploy-testnet-v2.js
```

2. **Deploy live** ke testnet:

```bash
CONFIRM=yes npx hardhat run scripts/deploy-testnet-v2.js --network elysiumTestnet
```

   Hasil: `deployments/elysiumTestnet-v2.json`. Skrip men-deploy PoolManager kanonik (atau memakai `POOL_MANAGER`),
   Timelock, seluruh kontrak Eridanos, preset HYPE + USDC, router Provenalt (integrator #1), lalu memindahkan owner
   ke Timelock. `acceptOwnership` dijadwalkan di Timelock bila deployer adalah proposer.

3. **Setelah jeda Timelock** (default 1 jam), siapa pun bisa menyelesaikan serah terima:

```bash
npx hardhat run scripts/timelock-execute-accept.js --network elysiumTestnet
```

4. **Frontend**: salin alamat dari `deployments/elysiumTestnet-v2.json` ke `frontend/config.js`
   (`core`, `router`, `hook`, `distributor`, `registry`, `config`, `vault`, `poolManager`, `deployBlock`), lalu
   `bash scripts/package-frontend.sh` dan unggah `dist/provenalt-frontend.zip` ke cPanel (File Manager → Upload →
   Extract) di folder subdomain atau subfolder, **bukan** root `public_html` yang berisi WordPress.

5. **Uji asap** di testnet: beberapa peluncuran lewat UI (dengan/tanpa alokasi dan dev buy), beli/jual di dalam dan
   di luar 10 detik pertama, `collect`, klaim creator; satu peluncuran mode B memakai `examples/agora-mode-b.js`
   sebagai acuan.

   Uji USDC (dompet yang memegang beberapa USDC testnet):

```bash
CONFIRM=yes npx hardhat run scripts/smoke-usdc-v2.js --network elysiumTestnet
```

6. **Verifikasi source**: explorer testnet (`explorer-elysium-testnet.t.conduit.xyz`) membaca Sourcify milik Conduit.
   Tanpa kunci dan tanpa gas:

```bash
NODE_USE_ENV_PROXY=1 node scripts/verify-sourcify.js
```

   (`NODE_USE_ENV_PROXY=1` hanya perlu di balik proxy.) Skrip juga memverifikasi semua token yang sudah diluncurkan.

## Yang diubah Timelock nanti (semuanya hanya untuk peluncuran baru)

`ProtocolConfig.setQuote`, `addCurvePreset`, `setCurvePresetEnabled`, `setTreasury`, `setGuardian`;
`IntegratorRegistry.setAllowlistEnabled`, `setApproved`, `setVerified`, `setSuspended`, `setCore`;
`LaunchCore.unpause`. Guardian hanya bisa `pause` (launch baru) dan `pauseRegistration`.

## Deployment aktif (Elysium testnet, 5 Nov 2026)

| Kontrak | Alamat |
|---|---|
| poolManager | `0xD02875d7Ea89e7e1f61512066828196c09FBD58d` |
| timelock | `0x47Bab40bB879bb6E207Ac6460eD5A874ce47Db07` |
| config | `0x2F409ccAb0b1d39265a2D28436C7E413E67dd8b3` |
| registry | `0xB340bD11629fAd01a2D14d58057209c8F1512Ede` |
| core | `0xEdAc9E32f2dCa8aAF61acB7D6F2a363e283cc08E` |
| hook | `0x9bcFA072d4d0cfA213bEb83242BcA5c1d50328cc` |
| distributor | `0xa175683c380D15B2E3e49753fa048Dca05774495` |
| vault | `0xf8C1554E691F45877731fD72a25df658465512b3` |
| router | `0x7389E762b0b63d8A60D307554abA27D074762e4a` |
| usdc | `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` |

Blok deploy 23833762. Timelock (jeda 900 dtk) owner config, registry, core dan PoolManager. Admin dipindah ke `0x78DceE56aD39180adDed458B8D09D445aAbFAde1`
(`scripts/handover-admin.js`): proposer/canceller Timelock, treasury, guardian, payout Provenalt, dan owner
`HypelysRouter` (diterima lewat `scripts/accept-router-ownership.js`). Serah terima selesai 5 Nov 2026. Deployer sementara `0x0bC67Dea…F322` tidak
memegang peran lagi. Preset 1 = HYPE, preset 2 = USDC. Uji asap: `scripts/smoke-testnet-v2.js`, hasil di
`deployments/elysiumTestnet-v2-smoke.json` (33/33). Source terverifikasi di Sourcify Conduit (15/15). Uji USDC 15/15 (`deployments/elysiumTestnet-v2-smoke-usdc.json`).

### Mengelola protokol dari dompet admin

Semua perubahan protokol lewat Timelock: `schedule`/`scheduleBatch` dari dompet admin, tunggu 900 dtk, lalu
`execute` (siapa pun boleh). Contoh: lihat `scripts/handover-admin.js`. Guardian bisa langsung `LaunchCore.pause()`
dan `IntegratorRegistry.pauseRegistration()`. Owner `HypelysRouter` bisa langsung `setPayout`, `setSigner`,
`setProfile`, `queuePolicy`. Dompet admin butuh sedikit HYPE di Elysium testnet untuk gas.

### Nama app di registry

Profil integrator #1 (nama dan situs yang dibaca frontend/explorer) diubah owner router tanpa Timelock:

```bash
CONFIRM=yes npx hardhat run scripts/set-app-profile.js --network elysiumTestnet
```

Default `APP_NAME=Provenalt`; isi `APP_URI` bila domain sudah ada.
Sudah dijalankan 9 Nov 2026 (tx `0x51a76a45…78f0`): integrator #1 kini "Provenalt".
URI diisi `https://provenalt.xyz` (tx `0x5564ce8e…e074`).

### USDC testnet untuk uji

USDC Elysium testnet (`0x7D29…47b2`, 6 desimal) adalah representasi bridge kanonik dari USDC HyperEVM testnet
`0x2B3370eE501B4a559b57D449569354196457D8Ab` (dicek: `calculateL2TokenAddress` di router HyperEVM). Jalur dari saldo
faucet Hyperliquid:

1. HyperCore → HyperEVM: transfer USDC spot ke EVM di app Hyperliquid testnet.
2. HyperEVM → Elysium: bridge UI `https://testnet.elysium.kinetiq.xyz/bridge`, atau manual: `approve` ke standard gateway
   `0x792487eF5E423104bec94e8c58E814e5E0450cEA`, lalu `outboundTransfer` di router HyperEVM
   `0x1aAE2caD8B0249905492087EF230FcCEa3707C45` dengan HYPE untuk biaya pengiriman (lihat docs Elysium
   "Bridging HyperEVM tokens to Elysium"). Sampai di Elysium ±1 menit. Skrip untuk jalur manual (dompet pemegang
   USDC di HyperEVM):

```bash
CONFIRM=yes npx hardhat run scripts/bridge-usdc-to-elysium.js --network hyperevmTestnet
```

   Default 5 USDC (`AMOUNT`), penerima dompet yang sama (`RECIPIENT`); biaya pengiriman 0,00046 HYPE, kelebihannya
   dikembalikan di Elysium. Disimulasikan tanpa kunci (eth_call dari alamat pemilik): `approve` dan `outboundTransfer`
   lolos.

### Indexer

Live di Railway: `https://provenalt-indexer-production.up.railway.app` (panduan dan cara update: `indexer/README.md`, `CATATAN-LANJUTAN.md`).
