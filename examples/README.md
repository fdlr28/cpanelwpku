# Contoh integrasi Eridanos

| Contoh | Mode | Perintah |
|---|---|---|
| `agora-mode-a.js` | A · app punya router sendiri yang terdaftar di registry | `npx hardhat run examples/agora-mode-a.js` |
| `agora-mode-b.js` | B · tanpa kontrak; backend menandatangani `LaunchIntent` (EIP-712), pengguna memanggil `LaunchCore.launchSigned` | `npx hardhat run examples/agora-mode-b.js` |

Keduanya berjalan di jaringan Hardhat lokal (`setup.js` men-deploy stack lengkap). SDK ada di `sdk/eridanos-sdk.js`.
