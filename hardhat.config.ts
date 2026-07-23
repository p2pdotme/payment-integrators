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
      // Pin the in-process EVM to the same hardfork the contracts are compiled
      // for (solidity.settings.evmVersion = "cancun"). Hardhat >= 2.26 defaults
      // to Osaka, which enforces the EIP-7825 per-transaction gas cap (2^24);
      // solidity-coverage honours that cap and its instrumented deployment of
      // MerchantTerminalIntegrator then runs out of gas, killing the coverage
      // run. On cancun the cap does not apply and coverage completes.
      hardfork: "cancun",
    },
  },
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
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
