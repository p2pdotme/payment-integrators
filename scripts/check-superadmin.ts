import { ethers } from "hardhat";

const INTEGRATOR = "0xC78222FFead42c8fc05A128966eb29590aD384d3";
const RECORDED_SA = "0x4f45446a6E934Fd03A353eC4DAc7Cd544f03d426";

async function main() {
  const net = await ethers.provider.getNetwork();
  const c = await ethers.getContractAt("MerchantTerminalIntegrator", INTEGRATOR);
  const sa: string = await c.superAdmin();
  console.log("chainId            :", net.chainId.toString(), net.chainId === 84532n ? "(Base Sepolia)" : "(UNEXPECTED)");
  console.log("integrator         :", INTEGRATOR);
  console.log("on-chain superAdmin:", sa);
  console.log("recorded superAdmin:", RECORDED_SA);
  console.log("match              :", sa.toLowerCase() === RECORDED_SA.toLowerCase());
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
