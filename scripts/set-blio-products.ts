import { ethers } from "hardhat";
import type { Contract, Interface } from "ethers";
import { writeFileSync } from "fs";

/**
 * Register/refresh the blio Premium products (productId 1..4) on the deployed
 * BlioCheckoutIntegrator. Idempotent: it only writes when the on-chain value
 * differs from the target, so it is safe to re-run.
 *
 * Prices match the web/app PLANS (9.99 / 26.99 / 49.99 / 79.99 USDC) and must
 * stay within the buyer's tier limit (INR/liveness $20, passport $100; other
 * currencies $50/$200) or userPlaceOrder reverts with AmountExceedsLimit.
 *
 * setProductPrice/setProductActive are onlyOwner. On Base mainnet the owner is
 * the blio Safe, so a plain EOA transaction cannot execute them. Two modes:
 *
 *   MODE=safe (default on mainnet, or when owner is a contract)
 *     Builds a Safe Transaction Builder batch JSON for the queued calls and
 *     writes it to SAFE_BATCH_OUT (default blio-products-safe-<chainId>.json).
 *     Import it at Safe → Apps → Transaction Builder, then sign/execute.
 *
 *   MODE=direct (Base Sepolia only, owner must be the EOA signer)
 *     Sends the transactions directly.
 *
 * Env:
 *   INTEGRATOR=0x...        the BlioCheckoutIntegrator deployed for blio
 *   MODE=safe|direct        optional; otherwise auto-detected
 *   SAFE_ADDRESS=0x...      optional; must match owner() when provided
 *   SAFE_BATCH_OUT=path     optional; batch output path (safe mode)
 *
 * Run (Base mainnet, owner = Safe):
 *   INTEGRATOR=0x... MODE=safe \
 *     npx hardhat run scripts/set-blio-products.ts --network base
 *
 * Run (Base Sepolia, owner = EOA signer):
 *   INTEGRATOR=0x... MODE=direct \
 *     npx hardhat run scripts/set-blio-products.ts --network baseSepolia
 */

const INTEGRATOR = process.env.INTEGRATOR || "";
const SAFE_ADDRESS = process.env.SAFE_ADDRESS || "";
const SAFE_BATCH_OUT = process.env.SAFE_BATCH_OUT || "";
const MODE_SAFE =
  process.env.MODE === "safe" ||
  process.env.SAFE === "1" ||
  process.argv.includes("--safe") ||
  process.argv.includes("--build");
const MODE_DIRECT =
  process.env.MODE === "direct" || process.env.DIRECT === "1" || process.argv.includes("--direct");

const PRODUCTS: Record<number, bigint> = {
  1: 9_990_000n,
  2: 26_990_000n,
  3: 49_990_000n,
  4: 79_990_000n,
};

const ABI = [
  "function productPrice(uint256) view returns (uint256)",
  "function productActive(uint256) view returns (bool)",
  "function owner() view returns (address)",
  "function setProductPrice(uint256 productId, uint256 price)",
  "function setProductActive(uint256 productId, bool active)",
];

interface SafeMethodInput {
  internalType: string;
  name: string;
  type: string;
}

interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: number;
  contractMethod: {
    inputs: SafeMethodInput[];
    name: string;
    payable: boolean;
  };
  contractInputsValues: Record<string, string>;
}

const SET_PRICE_METHOD = {
  inputs: [
    { internalType: "uint256", name: "productId", type: "uint256" },
    { internalType: "uint256", name: "price", type: "uint256" },
  ],
  name: "setProductPrice",
  payable: false,
};

const SET_ACTIVE_METHOD = {
  inputs: [
    { internalType: "uint256", name: "productId", type: "uint256" },
    { internalType: "bool", name: "active", type: "bool" },
  ],
  name: "setProductActive",
  payable: false,
};

function safeTx(
  iface: Interface,
  productId: bigint,
  method: "setProductPrice" | "setProductActive",
  value: bigint | boolean
): SafeTransaction {
  const args = [productId, value];
  const contractMethod = method === "setProductPrice" ? SET_PRICE_METHOD : SET_ACTIVE_METHOD;
  return {
    to: INTEGRATOR,
    value: "0",
    data: iface.encodeFunctionData(method, args),
    operation: 0,
    contractMethod,
    contractInputsValues: {
      productId: productId.toString(),
      [method === "setProductPrice" ? "price" : "active"]: value.toString(),
    },
  };
}

async function main() {
  if (!ethers.isAddress(INTEGRATOR)) {
    throw new Error(`INTEGRATOR env var is missing or not a valid address: "${INTEGRATOR}"`);
  }
  if (MODE_SAFE && MODE_DIRECT) {
    throw new Error("Choose one mode: MODE=safe or MODE=direct.");
  }

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 84532n && net.chainId !== 8453n) {
    throw new Error(
      `Unsupported chainId ${net.chainId} — expected 84532 (Base Sepolia) or 8453 (Base).`
    );
  }
  const isMainnet = net.chainId === 8453n;
  const reader = new ethers.Contract(INTEGRATOR, ABI, ethers.provider);
  const owner: string = await reader.owner();
  const ownerHasCode = (await ethers.provider.getCode(owner)) !== "0x";
  const safeMode = MODE_DIRECT ? false : MODE_SAFE || isMainnet || ownerHasCode;

  console.log("chainId    :", net.chainId.toString());
  console.log("integrator :", INTEGRATOR);
  console.log("owner      :", owner);
  console.log("owner code :", ownerHasCode ? "contract (Safe)" : "EOA");
  console.log("mode       :", safeMode ? "safe (batch JSON)" : "direct");

  if (safeMode) {
    if (SAFE_ADDRESS) {
      if (!ethers.isAddress(SAFE_ADDRESS)) {
        throw new Error(`SAFE_ADDRESS is not a valid address: "${SAFE_ADDRESS}"`);
      }
      if (SAFE_ADDRESS.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(
          `SAFE_ADDRESS ${SAFE_ADDRESS} does not match the integrator owner ${owner}.`
        );
      }
    }
    if (isMainnet && !ownerHasCode) {
      throw new Error(
        `owner ${owner} has no code on mainnet — expected the blio Safe. ` +
          "Deploy with DEPLOY_OWNER as the Safe, then run this in safe mode."
      );
    }
  } else {
    if (isMainnet) {
      throw new Error(
        "Direct mode is not allowed on Base mainnet (owner = Safe). Use MODE=safe and " +
          "execute the generated batch from the Safe."
      );
    }
    if (ownerHasCode) {
      throw new Error(
        `owner ${owner} is a contract, so setProductPrice/setProductActive cannot be sent ` +
          "from an EOA. Use MODE=safe and execute the batch from the Safe."
      );
    }
    const [signer] = await ethers.getSigners();
    if (!signer) {
      throw new Error("No signer configured. Set DEPLOYER_PRIVATE_KEY or MNEMONIC_KEY.");
    }
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(
        `Signer ${signer.address} is NOT the integrator owner ${owner} — ` +
          "setProductPrice/setProductActive are onlyOwner."
      );
    }
  }

  let writer: Contract | null = null;
  if (!safeMode) {
    const [signer] = await ethers.getSigners();
    if (!signer) throw new Error("No signer configured. Set DEPLOYER_PRIVATE_KEY or MNEMONIC_KEY.");
    writer = new ethers.Contract(INTEGRATOR, ABI, signer);
  }
  const iface = new ethers.Interface(ABI);
  const transactions: SafeTransaction[] = [];

  for (const [idStr, price] of Object.entries(PRODUCTS)) {
    const productId = BigInt(idStr);
    const [currentPrice, active]: [bigint, boolean] = await Promise.all([
      reader.productPrice(productId),
      reader.productActive(productId),
    ]);

    if (currentPrice !== price) {
      if (safeMode) {
        transactions.push(safeTx(iface, productId, "setProductPrice", price));
      } else if (writer) {
        const tx = await writer.setProductPrice(productId, price);
        console.log(`product ${idStr}: setProductPrice ${currentPrice} → ${price} (tx ${tx.hash})`);
        await tx.wait(2);
      }
    } else {
      console.log(`product ${idStr}: price already ${price}`);
    }

    if (!active) {
      if (safeMode) {
        transactions.push(safeTx(iface, productId, "setProductActive", true));
      } else if (writer) {
        const tx = await writer.setProductActive(productId, true);
        console.log(`product ${idStr}: setProductActive → true (tx ${tx.hash})`);
        await tx.wait(2);
      }
    } else {
      console.log(`product ${idStr}: already active`);
    }
  }

  if (safeMode) {
    if (transactions.length === 0) {
      console.log("\n✓ blio products already configured — no Safe batch needed.");
      return;
    }
    const out = SAFE_BATCH_OUT || `blio-products-safe-${net.chainId}.json`;
    const batch = {
      version: "1.0",
      chainId: net.chainId.toString(),
      createdAt: Date.now(),
      meta: {
        name: `blio products (integrator ${INTEGRATOR})`,
        description:
          "Sets blio Premium product prices 1-4 and activates them on BlioCheckoutIntegrator.",
        txBuilderVersion: "1.16.3",
        createdFromSafeAddress: owner,
        createdFromOwnerAddress: "",
      },
      transactions,
    };
    writeFileSync(out, `${JSON.stringify(batch, null, 2)}\n`);
    console.log(`\n✓ Safe batch written to ${out} (${transactions.length} transactions).`);
    console.log("  Import it in Safe → Apps → Transaction Builder, then sign and execute.");
    console.log("  Re-run this script afterwards to confirm the on-chain values.");
    return;
  }

  console.log("\n✓ blio products configured.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
