import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "solidity-coverage";
import dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : process.env.MNEMONIC_KEY
          ? { mnemonic: process.env.MNEMONIC_KEY }
          : [],
    },
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : process.env.MNEMONIC_KEY
          ? { mnemonic: process.env.MNEMONIC_KEY }
          : [],
    },
    hardhat: {
      chainId: 1337,
      // Run the test network on the SAME fork the contracts are compiled for
      // (`evmVersion: "cancun"` below). Hardhat otherwise defaults to the
      // newest fork it knows, which is how the coverage job was failing:
      //
      // EIP-7825 (Osaka) caps a single transaction at 2**24 = 16,777,216 gas.
      // solidity-coverage reads the hardfork, sees >= Osaka, and sets
      // `networkConfig.gas` to that cap for EVERY transaction. The instrumented
      // MerchantTerminalIntegrator deploy — which also constructs a UserProxy —
      // needs more than that, so it died with "Transaction ran out of gas" at
      // DEPLOY and the gate scored a contract it never managed to exercise at
      // ~2%. Raising blockGasLimit could not help: the ceiling being hit was
      // the per-transaction cap, not the block's.
      hardfork: "cancun",
      // With the fork pinned, the four merchant-terminal suites run clean under
      // instrumentation: 192 passing, MerchantTerminalIntegrator 2.49% -> 82.44%
      // lines and PaymentLinksLib 0% -> 100%. Repo-wide the gate now passes at
      // 96.11% lines / 82.34% branches, which also clears the coverage failure
      // `main` was inheriting.
      //
      // Two earlier attempts are recorded so they are not retried: raising
      // `blockGasLimit` cannot help, because the limit being hit is the
      // per-transaction cap rather than the block's; and `.solcover.js`'s
      // `configureYulOptimizer` applies to EVERY compile, inflating the
      // integrator from 24,504 to 88,034 bytes — it would have shipped a
      // contract that cannot deploy.
      //
      // Note what is deliberately NOT set here: `allowUnlimitedContractSize`.
      // solidity-coverage turns it on for its own provider, which is correct
      // — instrumented bytecode is far past EIP-170 and is never deployed.
      // Setting it on the ordinary test network would hide a real size
      // violation on a contract sitting at 24,502 of 24,576 bytes, so the
      // first sign of going over would be a failed mainnet deploy.
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
    // MerchantTerminalIntegrator is the one contract at the EIP-170 ceiling.
    // At runs: 200 it measures 24,865 bytes — 289 over the 24,576 limit — even
    // after moving payment-link lifecycle into PaymentLinksLib. Lowering `runs`
    // for THIS FILE ONLY buys the difference without raising runtime gas for
    // every other integrator in the repo, which a global change would do.
    //
    // This is a stopgap, not a fix. It leaves 72 bytes of headroom, so the
    // next change to this contract will hit the ceiling again. The structural
    // answer is to move the withdrawal / fund-helper sections (1,079 lines,
    // ~44% of the contract) into their own library, or to split the contract
    // into facets — both of which touch audited custody code and belong in
    // their own reviewed change, not in a blocker fix.
    overrides: {
      "contracts/integrators/merchant-terminal/MerchantTerminalIntegrator.sol": {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: { enabled: true, runs: 50 },
        },
      },
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
