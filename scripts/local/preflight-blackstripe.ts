import { ethers } from "hardhat";

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";

async function main() {
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(me);
  const diamondCode = await ethers.provider.getCode(DIAMOND_ADDRESS);
  const usdcCode = await ethers.provider.getCode(USDC_ADDRESS);

  console.log("chainId:            ", net.chainId.toString());
  console.log("deployer:           ", me);
  console.log("deployer ETH:       ", ethers.formatEther(bal));
  console.log("Diamond:            ", DIAMOND_ADDRESS, diamondCode === "0x" ? "  ⚠ NO CODE" : `  (code ${((diamondCode.length - 2) / 2)} bytes)`);
  console.log("USDC:               ", USDC_ADDRESS, usdcCode === "0x" ? "  ⚠ NO CODE" : `  (code ${((usdcCode.length - 2) / 2)} bytes)`);

  // Best-effort super-admin read (several common getter names).
  const probes = [
    "function superAdmin() view returns (address)",
    "function owner() view returns (address)",
    "function getSuperAdmin() view returns (address)",
  ];
  for (const sig of probes) {
    try {
      const c = new ethers.Contract(DIAMOND_ADDRESS, [sig], ethers.provider);
      const fn = sig.split(" ")[1].split("(")[0];
      const admin = await (c as any)[fn]();
      const isMe = admin.toLowerCase() === me.toLowerCase();
      console.log(`${fn}():`.padEnd(20), admin, isMe ? "  ✅ == deployer" : "  (not deployer)");
    } catch {
      /* getter not present on this Diamond — ignore */
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
