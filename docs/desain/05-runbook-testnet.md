# 05 · Runbook deploy testnet (fase 6)

Runbook ini ditulis untuk pemilik proyek yang men-deploy dengan kunci sendiri. Deploy pertama (5 Nov 2026, Uniswap v4)
dan deploy ulang di atas PancakeSwap Infinity CL (9 Nov 2026) dijalankan dari sesi Claude dengan kunci sementara;
lihat §Deployment aktif. Skrip menolak chain selain
Elysium testnet (99801) dan jaringan lokal (31337); mainnet tidak didukung.

## Prasyarat

1. Node 22 dan repo ini (`npm install`).
2. Dompet deployer berisi HYPE testnet (faucet Elysium).
3. `.env` (salin dari `.env.example`):
   * `PRIVATE_KEY` — kunci deployer Anda (jangan pernah di-commit);
   * `ELYSIUM_TESTNET_RPC` — disarankan endpoint Alchemy sendiri;
   * opsional: `TREASURY`, `GUARDIAN`, `TIMELOCK_PROPOSER`, `TIMELOCK_DELAY` (detik), `ADMIN` (dompet admin akhir:
     batch Timelock yang sama memberinya peran proposer + canceller dan mencabutnya dari deployer, jadi cukup satu kali
     tunggu), `PROVENALT_OWNER`, `PROVENALT_PAYOUT`, `APP_URI`, `POOL_MANAGER` (CLPoolManager Infinity yang sudah ada;
     kosong = deploy Vault + CLPoolManager sendiri dari sumber vendored).

## Langkah

1. **Dry run** (lokal, tanpa kunci, membuktikan skrip dan serah terima Timelock):

```bash
npx hardhat run scripts/deploy-testnet-v2.js
```

2. **Deploy live** ke testnet:

```bash
CONFIRM=yes npx hardhat run scripts/deploy-testnet-v2.js --network elysiumTestnet
```

   Hasil: `deployments/elysiumTestnet-v2.json`. Skrip men-deploy Vault + CLPoolManager PancakeSwap Infinity (atau
   memakai `POOL_MANAGER`), Timelock, seluruh kontrak Eridanos, preset HYPE + USDC, router Provenalt (integrator #1),
   lalu memindahkan owner ke Timelock: CLPoolManager langsung (Ownable satu langkah milik Infinity), config, registry,
   core dan Vault Infinity lewat `acceptOwnership` yang dijadwalkan di Timelock bila deployer adalah proposer.

3. **Setelah jeda Timelock** (default 1 jam), siapa pun bisa menyelesaikan serah terima:

```bash
npx hardhat run scripts/timelock-execute-accept.js --network elysiumTestnet
```

4. **Frontend**: salin alamat dari `deployments/elysiumTestnet-v2.json` ke `frontend/config.js`
   (`core`, `router`, `hook`, `distributor`, `registry`, `config`, `vault`, `poolManager`, `infinityVault`,
   `deployBlock`), lalu
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

## Deployment aktif (Elysium testnet, 9 Nov 2026, PancakeSwap Infinity CL)

| Kontrak | Alamat |
|---|---|
| infinityVault (Infinity `Vault`) | `0x88e40DB361BF4502c0d323e6e607F8FF22C90D15` |
| poolManager (Infinity `CLPoolManager`) | `0xba097E61b96e3675cFB860a69ADA85727F99f262` |
| timelock | `0xe445040EFfE64F79C3398DC1996b0ECEf03A64Ea` |
| config | `0x413c7BF2Dc57AEDca3Bc7DE606c23225a4AeA93E` |
| registry | `0xa3fF1Ad25c379Dd234AcaB0963ac0594389f10ef` |
| core | `0xdEb59B67B47B5988AB5897dBd5A203356ABd4A66` |
| hook | `0xD17875B985e9c9945913d210f9253C9D11a13CF9` |
| distributor | `0x5464c879772fFe587E1f0e28BC8e4b08EA01d0A8` |
| vault (VestingVault) | `0xf46d8ade57a0580BbA3fdEbB4E82f5aa6c190883` |
| router (`ProvenaltRouter`) | `0xE46cA91Ee64E07f3F2061D2E046C2f91B223c758` |
| usdc | `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` |

Blok deploy 26697151, biaya deploy 0,0023 HYPE. Timelock (jeda 900 dtk) owner config, registry, core, Vault Infinity
dan CLPoolManager. Dompet admin `0x78DceE56aD39180adDed458B8D09D445aAbFAde1` = satu-satunya proposer/canceller
Timelock, treasury, guardian, owner `ProvenaltRouter` (langsung dari konstruktor) dan payout Provenalt; diatur saat
deploy (`ADMIN`, `TREASURY`, `GUARDIAN`, `PROVENALT_OWNER`, `PROVENALT_PAYOUT`) dan selesai lewat satu batch Timelock
(9 Nov 2026). Deployer sementara `0x0bC67Dea…F322` tidak memegang peran lagi; integrator uji #2 miliknya dinonaktifkan.
Preset 1 = HYPE, preset 2 = USDC. Uji asap HYPE 33/33 (`deployments/elysiumTestnet-v2-smoke.json`). Source
terverifikasi di Sourcify Conduit 14/14 (kontrak + 4 token uji). Uji USDC (`smoke-usdc-v2.js`) dijalankan dari dompet
admin karena deployer tidak memegang USDC.

Owner CLPoolManager (Timelock) bisa `pause()` swap di semua pool dan memasang protocol fee controller (tidak dipasang).
Ini kewenangan yang tidak ada di Uniswap v4; perubahan apa pun tetap harus lewat jeda Timelock.

Deployment lama di atas Uniswap v4 (5 Nov 2026, core `0xEdAc…c08E`) ditinggalkan karena lisensi BUSL-1.1;
catatannya di `deployments/legacy-uniswapv4/`. Token di sana tetap ada on-chain tetapi tidak lagi tampil di website.

### Mengelola protokol dari dompet admin

Semua perubahan protokol lewat Timelock: `schedule`/`scheduleBatch` dari dompet admin, tunggu 900 dtk, lalu
`execute` (siapa pun boleh). Contoh: lihat `scripts/handover-admin.js`. Guardian bisa langsung `LaunchCore.pause()`
dan `IntegratorRegistry.pauseRegistration()`. Owner `ProvenaltRouter` bisa langsung `setPayout`, `setSigner`,
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
