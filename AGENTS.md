# AGENTS.md — BlioCheckoutIntegrator (fork de blio)

Guía para agentes que trabajen en este fork. **Responde en español.**

> **Versión del documento:** `2026-11-18.1` · **Última actualización:** 18-11-2026

## Qué es
Fork de `p2pdotme/payment-integrators` (`origin`) para el checkout de
**blio Premium**: el comprador paga en fiat y el integrador liquida USDC en Base
a la Safe de blio. Rama de trabajo **`feat/integrator-blio`** en el remote
`fork` (`blio-me/payment-integrators`).

## Archivos del integrador de blio
- `contracts/integrators/blio/BlioCheckoutIntegrator.sol` — el integrador.
- `docs/blio-mainnet-runbook.md` — deploy en Base mainnet.
- `scripts/deploy-blio.ts` — deploy (Hardhat) y registro opcional en el Diamond.
- `scripts/set-blio-products.ts` — productos y precios.
- `test/blio-integrator.test.ts` — suite principal.
- `test/blio-integrator-poc.test.ts` — PoC de cancelar/reabrir/completar.

El repo **no tiene `foundry.toml`**: `forge` no sirve aquí, todo va por Hardhat.

## Estado (18-11-2026)
- Código: **`1ee7a69`** (este documento llega en el commit siguiente).
- Suite de blio: **79 tests**; repo completo: **1.046 passing / 45 pending**.
- Tamaño desplegado: **10.694 B** (límite EIP-170: 24.576 B).

## Valores fijos de Base mainnet
| Parámetro | Valor |
|---|---|
| `DIAMOND_ADDRESS` | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` |
| `USDC_ADDRESS` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimales) |
| `RECIPIENT_ADDR` | `0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47` (Safe de blio) |
| `LIVENESS_ATTESTOR` | `0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978` |
| `KYC_ATTESTOR` | `0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda` |

Los attestors son **EOAs vacías a propósito**: firman fuera de cadena con una
clave para todas las cadenas y nunca envían una transacción. La cadena y el
contrato van dentro del dominio EIP-712, no en la clave.

## Invariantes de seguridad (no romper)
1. **`recipientAddr` siempre es la `treasury`** (la Safe): el integrador nunca
   custodia USDC. Con `usdcThroughIntegrator=true` el USDC quedaría atrapado.
2. **`nullifier != bytes32(0)`** (`InvalidNullifier`): aceptarlo quema el slot y
   bloquea a todas las demás wallets para siempre (no hay reset).
3. **`limit != 0`** (`InvalidLimit`): 0 no significa "sin tope".
4. **Pasaporte solo si la wallet ya ancló liveness** (`livenessNullifier[wallet]`
   distinto de cero, error `LivenessRequired`). El nullifier del tenant de
   pasaporte no es el del tenant de liveness, así que sin este ancla una persona
   attestaba dos wallets y doblaba el tope diario.
5. **Tiers monótonos dentro del TTL** (`TierDowngrade` vía `_tierOf`): un
   Pasaporte vigente no puede bajar a Liveness.
6. **Registro con `usdcThroughIntegrator=false` y `cancelCallbackEnabled=false`**.
7. **Attestors inmutables** en el constructor y **dominios EIP-712 separados**
   (`LivenessVerifier` / `KycVerifier`).
8. **`userPlaceOrder` es self-service** y `nonReentrant`; `validateOrder` es el
   gate del cupo diario (cancelar y reintentar también consume el cupo).
9. **Nunca `renounceOwnership`** (revierte `RenounceDisabled`).

## Lo que p2p confirmó (18-11-2026)
- **Attestors:** los dos de arriba, **iguales en todas las cadenas** (confirmado
  por escrito). Sirven para mainnet y Sepolia.
- **Nullifier:** **no** es estable entre tenants ni servicios; **sí** es estable
  por persona dentro de un tenant (reconocen a quien vuelve por la cara).
- **TTL:** es política nuestra; nada de su lado depende de él (hoy 180 días). Solo
  firman una ventana de 1 hora para presentar la claim.
- **Factory:** SimpleAccount v0.7 `0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985`,
  `salt = 0`, `X-Signer-Address` = llave del owner.
- **Egress:** su lista blanca compara la **IP de origen**; un hostname no les sirve
  y un DNS no cambia por dónde sale un Worker.
- **Registro en mainnet:** lo hace p2p después de verificar el bytecode. No usar
  `REGISTER=1`.
- **Tenants:** van atados a la **dirección del contrato**, así que cada dirección
  nueva necesita tenants nuevos de liveness y pasaporte.

## Pendiente
- **Egress:** decidir API key/HMAC en el endpoint de screening o proxy por un host
  propio (los Workers de Cloudflare no tienen salida fija).
- **Clave de cifrado del screening:** la envía p2p.
- Deploy **Sepolia**: **hecho** (`0xb63Ba8…`); pendientes el registro de p2p
  y los tenants nuevos. Después del E2E, **mainnet**.

## Comandos
```bash
npx hardhat test test/blio-integrator.test.ts   # suite de blio
npx hardhat test                                # repo completo
DRY_RUN=1 npx hardhat run scripts/deploy-blio.ts --network base
```
Si `npx` falla en el entorno, usar `./node_modules/.bin/hardhat`.

Deploy: `hardhat.config.ts` lee `BASE_RPC` y `DEPLOYER_PRIVATE_KEY` (o
`MNEMONIC_KEY`). El script toma `DIAMOND_ADDRESS`, `USDC_ADDRESS`,
`RECIPIENT_ADDR`, `DEPLOY_OWNER`, `LIVENESS_ATTESTOR`, `KYC_ATTESTOR` y
`DAILY_TX_COUNT_LIMIT`; en mainnet `DEPLOY_OWNER` es obligatorio.

## Convenciones
- **No commitear secretos** ni claves privadas.
- **No añadir comentarios** salvo que aporten: el contrato ya está documentado con
  NatSpec, mantener ese estilo.
- Antes de dar algo por terminado: la suite de blio y, si se tocó código
  compartido, `npx hardhat test` completo.
- **No bajar el tamaño** de la suite ni relajar un invariante para que pase un
  test: si un test choca con un invariante, el test está mal.
