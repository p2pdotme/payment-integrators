import { ethers } from "hardhat";

/** Read-only Base Sepolia state check for the v2 offramp stack.
 *  Optional: ALLOCATION_ID + ORDER_ID to verify a completed offramp. */
const ORDER_TUPLE = {
  type: "tuple",
  components: [
    { name: "amount", type: "uint256" },
    { name: "fiatAmount", type: "uint256" },
    { name: "placedTimestamp", type: "uint256" },
    { name: "completedTimestamp", type: "uint256" },
    { name: "userCompletedTimestamp", type: "uint256" },
    { name: "acceptedMerchant", type: "address" },
    { name: "user", type: "address" },
    { name: "recipientAddr", type: "address" },
    { name: "pubkey", type: "string" },
    { name: "encUpi", type: "string" },
    { name: "userCompleted", type: "bool" },
    { name: "status", type: "uint8" },
    { name: "orderType", type: "uint8" },
    {
      name: "disputeInfo",
      type: "tuple",
      components: [
        { name: "raisedBy", type: "uint8" },
        { name: "status", type: "uint8" },
        { name: "redactTransId", type: "uint256" },
        { name: "accountNumber", type: "uint256" },
      ],
    },
    { name: "id", type: "uint256" },
    { name: "userPubKey", type: "string" },
    { name: "encMerchantUpi", type: "string" },
    { name: "acceptedAccountNo", type: "uint256" },
    { name: "assignedAccountNos", type: "uint256[]" },
    { name: "currency", type: "bytes32" },
    { name: "preferredPaymentChannelConfigId", type: "uint256" },
    { name: "circleId", type: "uint256" },
  ],
} as const;
const STATUS = ["PLACED", "ACCEPTED", "PAID", "COMPLETED", "CANCELLED"];

async function main() {
  const VAULT = process.env.VAULT_ADDRESS!;
  const USDC = process.env.USDC_ADDRESS!;
  const AUSDC = process.env.AUSDC_ADDRESS!;
  const INTEGRATOR = process.env.INTEGRATOR_ADDRESS!;
  const DIAMOND = process.env.DIAMOND_ADDRESS!;
  const f = (n: bigint) => ethers.formatUnits(n, 6);

  const [me] = await ethers.getSigners();
  const vault = await ethers.getContractAt("RestrictedYieldVault", VAULT);
  const usdc = await ethers.getContractAt("IERC20", USDC);
  const aUsdc = AUSDC ? await ethers.getContractAt("IERC20", AUSDC) : null;

  console.log("deployer:           ", me.address);
  console.log("vault GG bal:       ", f(await usdc.balanceOf(VAULT)));
  if (aUsdc) console.log("vault aUSDC bal:    ", f(await aUsdc.balanceOf(VAULT)));
  console.log("vault totalPrincipal:", f(await vault.totalPrincipal()));
  console.log("vault offrampWithdrawn:", f(await vault.offrampWithdrawn()));
  console.log("vault offrampQuota: ", f(await vault.offrampQuota()));

  if (INTEGRATOR) {
    const ig = await ethers.getContractAt("TradeStarsCheckoutIntegratorV2", INTEGRATOR);
    console.log("integrator GG bal:  ", f(await usdc.balanceOf(INTEGRATOR)));
    console.log("availableOfframp(me):", f(await ig.availableOfframp(me.address)));
    const proxy = await ig.proxyAddress(me.address);
    console.log("user proxy:         ", proxy, " GG bal:", f(await usdc.balanceOf(proxy)));
    if (process.env.ALLOCATION_ID) {
      const a = await ig.getAllocation(process.env.ALLOCATION_ID);
      console.log("allocation:", {
        user: a.user,
        amount: f(a.amount),
        activeOrderId: a.activeOrderId.toString(),
        lastStatus: `${a.lastStatus} (${STATUS[Number(a.lastStatus)]})`,
        settled: a.settled,
      });
      console.log(
        "  proxy == allocation.user-proxy:",
        proxy.toLowerCase() === (await ig.proxyAddress(a.user)).toLowerCase()
      );
    }
  }

  if (DIAMOND && process.env.ORDER_ID) {
    const diamond = new ethers.Contract(
      DIAMOND,
      [
        {
          name: "getOrdersById",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "orderId", type: "uint256" }],
          outputs: [ORDER_TUPLE],
        },
      ],
      me
    );
    const o = await diamond.getOrdersById(process.env.ORDER_ID);
    const ig = await ethers.getContractAt("TradeStarsCheckoutIntegratorV2", INTEGRATOR);
    const proxy = await ig.proxyAddress(me.address);
    console.log(`order ${process.env.ORDER_ID}:`, {
      status: `${o.status} (${STATUS[Number(o.status)]})`,
      orderType: o.orderType.toString(),
      user: o.user,
      amount: f(o.amount),
    });
    console.log(
      "  order.user == user's proxy:",
      o.user.toLowerCase() === proxy.toLowerCase() ? "✓ (history attribution holds)" : "✗"
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
