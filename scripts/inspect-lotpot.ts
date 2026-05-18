import { ethers } from "hardhat";

/**
 * Inspect a deployed LotPot integrator's per-user counters + credit.
 *
 * Usage:
 *   LOTPOT_INTEGRATOR_ADDRESS=0x... [USER_ADDRESS=0x...] \
 *   npx hardhat run scripts/inspect-lotpot.ts --network base
 */
async function main() {
  const integratorAddr = process.env.LOTPOT_INTEGRATOR_ADDRESS;
  if (!integratorAddr) {
    throw new Error("LOTPOT_INTEGRATOR_ADDRESS env var required");
  }
  const user = process.env.USER_ADDRESS || (await (await ethers.getSigners())[0].getAddress());
  const i = await ethers.getContractAt(
    [
      "function getTodayCount(address) view returns (uint256)",
      "function getRemainingDailyCount(address) view returns (uint256)",
      "function dailyTxCountLimit() view returns (uint256)",
      "function getUserTxLimit(address, bytes32) view returns (uint256)",
      "function availableCredit(address) view returns (uint256)",
      "function proxyAddress(address) view returns (address)",
    ],
    integratorAddr
  );
  const inr = ethers.encodeBytes32String("INR");
  console.log("integrator :", integratorAddr);
  console.log("user       :", user);
  console.log("today      :", (await i.getTodayCount(user)).toString());
  console.log("remaining  :", (await i.getRemainingDailyCount(user)).toString());
  console.log("dailyLimit :", (await i.dailyTxCountLimit()).toString());
  console.log("txLimitINR :", ethers.formatUnits(await i.getUserTxLimit(user, inr), 6), "USDC");
  console.log("availCred  :", ethers.formatUnits(await i.availableCredit(user), 6), "USDC");
  console.log("proxyAddr  :", await i.proxyAddress(user));
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
