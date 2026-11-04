// Gas report for key Eridanos operations: npx hardhat test scripts/gas-report.js
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { SUPPLY } = require("../test/v2/helpers");
const { E, fixture, params, clean, doLaunch, swap } = require("../test/v2/launchFixture");
describe("gas", function () {
  it("measures", async function () {
    const ctx = await loadFixture(fixture);
    const out = {};
    let r = await doLaunch(ctx, ctx.user, params(ctx.creator.address)); out["launch mode C (no alloc, no dev buy)"] = r.rc.gasUsed;
    r = await doLaunch(ctx, ctx.app, params(ctx.creator.address, { saltLabel: "g2", allocations: [{ recipient: ctx.creator.address, bps: 1000 }, { recipient: ctx.bob.address, bps: 1000 }], duration: 365 * 86400, devBuyTokens: SUPPLY / 10n, maxDevBuyQuote: E(500) }), E(500));
    out["launch mode A (2 vested allocations + 10% dev buy)"] = r.rc.gasUsed;
    await time.setNextBlockTimestamp(r.launchedAt + 1);
    out["swap buy exact-in, in anti-sniper window"] = (await swap(ctx, ctx.alice, r.poolId, { buy: true, amount: E(1) })).gasUsed;
    await time.setNextBlockTimestamp(r.launchedAt + 60);
    out["swap buy exact-in, after window"] = (await swap(ctx, ctx.alice, r.poolId, { buy: true, amount: E(1) })).gasUsed;
    out["collect (15 bands)"] = (await (await ctx.hook.collect(r.poolId)).wait()).gasUsed;
    out["claimCreator"] = (await (await ctx.distributor.claimCreator(r.poolId)).wait()).gasUsed;
    for (const [k, v] of Object.entries(out)) console.log(String(v).padStart(9), " ", k);
  });
});
