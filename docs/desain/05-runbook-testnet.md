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
     `HYPELYS_OWNER`, `HYPELYS_PAYOUT`, `POOL_MANAGER` (bila memakai PoolManager v4 kanonik yang sudah ada).

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
   Timelock, seluruh kontrak Eridanos, preset HYPE + USDC, router Hypelys (integrator #1), lalu memindahkan owner
   ke Timelock. `acceptOwnership` dijadwalkan di Timelock bila deployer adalah proposer.

3. **Setelah jeda Timelock** (default 1 jam), siapa pun bisa menyelesaikan serah terima:

```bash
npx hardhat run scripts/timelock-execute-accept.js --network elysiumTestnet
```

4. **Frontend**: salin alamat dari `deployments/elysiumTestnet-v2.json` ke `frontend/config.js`
   (`core`, `router`, `hook`, `distributor`, `registry`, `config`, `vault`, `poolManager`, `deployBlock`), lalu
   unggah isi folder `frontend/` ke `public_html` di cPanel.

5. **Uji asap** di testnet: beberapa peluncuran lewat UI (dengan/tanpa alokasi dan dev buy), beli/jual di dalam dan
   di luar 10 detik pertama, `collect`, klaim creator; satu peluncuran mode B memakai `examples/agora-mode-b.js`
   sebagai acuan.

6. **Verifikasi source** di explorer testnet (halaman *Verify contract*): compiler 0.8.26, optimizer 200 runs,
   `viaIR: true`, EVM `cancun`.

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
(`scripts/handover-admin.js`): proposer/canceller Timelock, treasury, guardian, payout Hypelys, dan owner
`HypelysRouter` (setelah `acceptOwnership()` dipanggil dari dompet itu). Deployer sementara `0x0bC67Dea…F322` tidak
memegang peran lagi. Preset 1 = HYPE, preset 2 = USDC. Uji asap: `scripts/smoke-testnet-v2.js`, hasil di
`deployments/elysiumTestnet-v2-smoke.json` (33/33).

### Mengelola protokol dari dompet admin

Semua perubahan protokol lewat Timelock: `schedule`/`scheduleBatch` dari dompet admin, tunggu 900 dtk, lalu
`execute` (siapa pun boleh). Contoh: lihat `scripts/handover-admin.js`. Guardian bisa langsung `LaunchCore.pause()`
dan `IntegratorRegistry.pauseRegistration()`. Owner `HypelysRouter` bisa langsung `setPayout`, `setSigner`,
`setProfile`, `queuePolicy`. Dompet admin butuh sedikit HYPE di Elysium testnet untuk gas.
