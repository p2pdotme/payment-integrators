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
    // This is a stopgap, not a fix. It leaves ~113 bytes of headroom, so the
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
