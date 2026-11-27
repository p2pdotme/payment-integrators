import { ethers } from "hardhat";
import { writeFileSync } from "fs";

/**
 * Enciende la allowlist de divisas del BlioCheckoutIntegrator.
 *
 * El constructor solo habilita `bytes32("INR")` y el wildcard `bytes32(0)`;
 * cualquier otra etiqueta revierte `CurrencyNotAllowed` en `userPlaceOrder`.
 * La etiqueta es el `bytes32` ASCII con ceros a la derecha que manda el widget
 * (`bytes32("VEN")`, `bytes32("BRL")`), no el código de presentación: Venezuela
 * es **`VEN`**, no `VES`. Antes de abrir hay que confirmar con p2p cada etiqueta
 * por país y encenderla aquí.
 *
 * Idempotente: solo escribe las que estén apagadas.
 *
 *   Sepolia (owner EOA) — solo INR, BRL, ARS e IDR; VEN no existe allí:
 *     INTEGRATOR=0x... CURRENCIES=BRL,INR MODE=direct \
 *       ./node_modules/.bin/hardhat run scripts/set-blio-foreigns.ts --network baseSepolia
 *
 *   Mainnet (owner = Safe 2-de-3): genera el lote para el Transaction Builder.
 *     INTEGRATOR=0x... CURRENCIES=VEN,BRL MODE=safe \
 *       ./node_modules/.bin/hardhat run scripts/set-blio-foreigns.ts --network base
 */

const INTEGRATOR = process.env.INTEGRATOR || "";
const CURRENCIES = (process.env.CURRENCIES || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const MODE_SAFE = process.env.MODE === "safe" || process.argv.includes("--safe");
const SAFE_BATCH_OUT = process.env.SAFE_BATCH_OUT || "";

const ABI = [
  "function setCurrencyAllowed(bytes32 currency, bool allowed)",
  "function allowedCurrency(bytes32 currency) view returns (bool)",
];

async function main() {
  if (!/^0x[0-9a-fA-F]{40}$/.test(INTEGRATOR)) {
    throw new Error("INTEGRATOR=0x... es obligatorio");
  }
  if (CURRENCIES.length === 0) {
    throw new Error(
      "CURRENCIES=VEN,BRL es obligatorio (etiqueta bytes32 del Diamond; Venezuela es VEN, no VES)"
    );
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const [signer] = await ethers.getSigners();
  const integrator = new ethers.Contract(INTEGRATOR, ABI, signer ?? ethers.provider);

  console.log(`integrador: ${INTEGRATOR}`);
  console.log(`chainId:    ${chainId}`);
  console.log(`modo:       ${MODE_SAFE ? "safe" : "direct"}`);

  const pending: { label: string; bytes32: string }[] = [];
  for (const label of CURRENCIES) {
    if (label.length > 31) throw new Error(`etiqueta demasiado larga: ${label}`);
    const bytes32 = ethers.encodeBytes32String(label);
    const on = await integrator.allowedCurrency(bytes32).catch(() => false);
    console.log(`  ${label} (${bytes32}): ${on ? "ya permitida" : "se enciende"}`);
    if (!on) pending.push({ label, bytes32 });
  }

  if (pending.length === 0) {
    console.log("Nada que hacer.");
    return;
  }

  if (MODE_SAFE) {
    const batch = {
      version: "1.0",
      chainId: String(chainId),
      createdAt: Date.now(),
      meta: {
        name: "blio: divisas p2p",
        description: `setCurrencyAllowed(${pending.map((p) => p.label).join(", ")}, true)`,
        createdFromSafeAddress: undefined,
      },
      transactions: pending.map((p) => ({
        to: INTEGRATOR,
        value: "0",
        data: integrator.interface.encodeFunctionData("setCurrencyAllowed", [p.bytes32, true]),
      })),
    };
    const out = SAFE_BATCH_OUT || `blio-currencies-safe-${chainId}.json`;
    writeFileSync(out, JSON.stringify(batch, null, 2));
    console.log(`\nLote de Safe escrito en ${out} (importar en Transaction Builder).`);
    return;
  }

  if (!signer) throw new Error("Falta DEPLOYER_PRIVATE_KEY para MODE=direct");
  for (const p of pending) {
    const tx = await integrator.setCurrencyAllowed(p.bytes32, true);
    console.log(`  ${p.label}: ${tx.hash}`);
    await tx.wait(1);
  }
  console.log("\nDivisas encendidas.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
