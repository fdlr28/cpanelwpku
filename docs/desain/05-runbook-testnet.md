# 05 · Runbook deploy testnet (fase 6)

Fase ini dijalankan **oleh pemilik proyek** di komputernya sendiri, dengan kunci sendiri. Skrip menolak chain selain
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
