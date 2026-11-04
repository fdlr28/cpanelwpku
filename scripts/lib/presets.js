// Curve presets shipped with Eridanos v2 (canonical ticks; see ProtocolConfig).
// Shape: the 15-band curve live on Ascend testnet (MIT source, zynorr/ascendkit LIVE_CURVE).
const ASCEND_SHAPE = [
  [0, 19_400, 3_519], [19_400, 20_600, 146], [20_600, 21_800, 160], [21_800, 23_000, 175],
  [23_000, 40_000, 1_888], [40_000, 41_200, 97], [41_200, 42_400, 108], [42_400, 43_600, 121],
  [43_600, 44_800, 135], [44_800, 46_000, 151], [46_000, 66_600, 1_853], [66_600, 67_800, 70],
  [67_800, 69_000, 77], [69_000, 92_000, 1_000], [92_000, 200_000, 500],
];
// HYPE (18 decimals): canonical tick ≈ log1.0001(3e-8 HYPE/token) → initial market cap ≈ 30 HYPE.
const HYPE_START_TICK = -173200;
// USDC (6 decimals): ≈ 7.9e-6 USDC/token → initial FDV ≈ $7,900.
const USDC_START_TICK = -393800;

function buildPresetFromCurve(shape) {
  return shape.map(([offsetLower, offsetUpper, bps]) => ({ offsetLower, offsetUpper, bps }));
}

module.exports = { ASCEND_SHAPE, HYPE_START_TICK, USDC_START_TICK, buildPresetFromCurve };
