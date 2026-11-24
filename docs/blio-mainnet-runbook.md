# Runbook: deploy de `BlioCheckoutIntegrator` en Base mainnet

> **Estado: NO ejecutado.** Este documento y el script dejan todo preparado para
> desplegar en cuanto p2p confirme el whitelist y las divisas. El deploy es
> **irreversible** (el contrato no es proxy) y cuesta gas: leer entero antes.

## 1. Valores que hay que fijar antes de desplegar

El script `scripts/deploy-blio.ts` trae los presets de Base mainnet ya
verificados on-chain; solo hay que confirmar lo que **no** está en el preset.

| Parámetro | Valor | Notas |
|---|---|---|
| `DIAMOND_ADDRESS` | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | Preset. Verificado on-chain el 13-nov-2026 (334 B de runtime). |
| `USDC_ADDRESS` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Preset. USDC nativo de Base: 1.852 B de runtime y **6 decimales**, checksum EIP-55 correcto. |
| `RECIPIENT_ADDR` | `0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47` | Preset: Safe de blio. **La misma dirección en Base mainnet y en Sepolia** (Safe v1.5.0 **2-de-3**, owners `0xC9b6…fd12`, `0xb097…8Ee6`, `0x768b…778B`). Tiene que seguir siendo una Safe (no EOA) y coincidir con `P2P_SAFE_TREASURY` del Worker. |
| `DEPLOY_OWNER` | Safe de blio (`0xFB25…df47`) | **Obligatorio en mainnet**: el script se niega a usar la EOA del deployer. El owner cambia límites, productos, pausa y barre USDC suelto, así que en mainnet debe ser la Safe. ⚠️ La EOA del deployer (`0x58B1…32d2`) **no es owner de la Safe**: cada cambio de admin necesita **2 de 3** firmas (`MODE=safe` genera el lote para el Transaction Builder). |
| `DAILY_TX_COUNT_LIMIT` | `5` | Tope diario de **colocaciones** por usuario (cancelar y reintentar también consume el cupo). |
| `LIVENESS_ATTESTOR` | `0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978` | **Mismo valor en Base mainnet y en Sepolia.** Confirmado por escrito por p2p. |
| `KYC_ATTESTOR` | `0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda` | **Mismo valor en Base mainnet y en Sepolia.** Confirmado por escrito por p2p. |

Los attestors son **EOAs vacías a propósito**: cada servicio firma las
attestations fuera de cadena con una única clave para todas las cadenas y nunca
envía una transacción. La cadena y el contrato van dentro del dominio EIP-712,
no en la clave. Se comprueba de dos formas: `GET /v1/attestor` en ambos servicios
devuelve esas direcciones, y el contrato de Sepolia `0x415627D9…` ya aceptó
attestations reales de las dos claves (liveness el 31-oct, pasaporte el 4-nov).

`ATTESTATION_TTL` (180 días) es **política nuestra**: a p2p no le afecta.
p2p solo firma una ventana de 1 hora para presentar el claim; la identidad
verificada no caduca de su lado.

## 2. Checklist previo

- [ ] p2p confirma **qué etiqueta exacta `bytes32` manda el widget** por país
      (`VEN`, `BRL`, `INR`…). La etiqueta es ASCII con ceros a la derecha; para
      Venezuela es **`VEN`**, no el código de presentación `VES`. El constructor
      solo habilita `bytes32("INR")` y el
      wildcard `bytes32(0)`; cualquier otra revierte `CurrencyNotAllowed` en el
      primer pedido. Se enciende con `setCurrencyAllowed` (en mainnet, por la Safe).
      En Sepolia solo existen **INR, BRL, ARS e IDR**: `VEN` no se puede probar ahí.
- [ ] p2p confirma **divisas** permitidas y el whitelist del integrador en mainnet.
- [ ] p2p confirma el **tenant** de producción. Los tenants están atados a la
      **dirección del contrato**. Sepolia ya tiene los suyos atados al contrato
      nuevo `0xb63Ba818…`: `blio-liveness-sepolia` y `blio-kyc-sepolia`. Las
      attestations de `blio-liveness`/`blio-kyc` siguen atadas al contrato viejo
      `0x415627D9…` y **no verifican** en el nuevo: los compradores de prueba
      tienen que verificar otra vez.
- [ ] p2p confirma `usdcThroughIntegrator=false` y `cancelCallbackEnabled=false`
      en el registro (el script lo verifica si se registra desde aquí).
- [ ] Safe de tesorería y owner creadas y con firmantes suficientes.
- [ ] `P2P_TREASURY_ADDRESS` de producción **coincide** con la Safe (el código la pinea contra `P2P_SAFE_TREASURY`).
- [ ] Fondos de gas en la cuenta de despliegue (solo creación; los userOps van por Pimlico).
- [ ] **Política nueva de Pimlico** creada con presupuesto (la anterior está inservible).
- [ ] Redirect de liveness/KYC permitido para `https://blio.me/checkout?kyc=1`.
- [ ] **Egress de liveness/KYC**: los proxies solo aceptan servidor-a-servidor
      desde IPs fijas y devuelven `403 client_not_supported` a las IPs de
      Cloudflare. O se llaman desde el navegador en `staging.blio.me` (origen
      permitido) o p2p añade la IP del VPS (`89.58.59.27`) a su lista de
      servidores. El `/relay` on-chain va al RPC, no a los proxies.
- [ ] Al cambiar de integrador, leer cada orden del contrato que la creó
      (`getOrderIntegrator(orderId)` en el Diamond). El integrador viejo
      `0x415627D9…` conserva su estado: no hay que drenar ni desactivar nada.

## 3. Deploy

El único camino válido es **Hardhat** (`scripts/deploy-blio.ts`). El repo no
tiene `foundry.toml`, así que `forge` no puede compilar ni desplegar esto.

```bash
cd payment-integrators

# hardhat.config.ts lee BASE_RPC y DEPLOYER_PRIVATE_KEY (o MNEMONIC_KEY).
export BASE_RPC="https://mainnet.base.org"        # o un RPC propio
export DEPLOYER_PRIVATE_KEY="0x..."               # cuenta de deploy (no la Safe)

# El resto se pasa al script; DIAMOND/USDC/RECIPIENT salen del preset si se omiten.
export DEPLOY_OWNER=0x...                         # Safe / multisig (obligatorio)
export LIVENESS_ATTESTOR=0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978
export KYC_ATTESTOR=0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda
export DAILY_TX_COUNT_LIMIT=5

# 1) Simulación sin gas y SIN clave de deploy (solo getCode: presets, guard
#    del owner y metadata del USDC). Así la clave no viaja hasta el paso 2.
env -u DEPLOYER_PRIVATE_KEY DRY_RUN=1 \
  DEPLOY_OWNER=0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47 \
  LIVENESS_ATTESTOR=0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978 \
  KYC_ATTESTOR=0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda \
  ./node_modules/.bin/hardhat run scripts/deploy-blio.ts --network base

# 2) Deploy real (en este servidor `npx` no existe: usa el binario local)
./node_modules/.bin/hardhat run scripts/deploy-blio.ts --network base
```

El script imprime la **dirección del integrador**, el `proxyImpl`, el **hash del
bytecode** desplegado, las variables para el `.env` de la app y los comandos de
verificación (Hardhat y Blockscout). **No** imprime una comprobación de tamaño:
el tamaño se mide en `hardhat test` (`BlioCheckoutIntegrator deployment size`,
hoy 10.694 B, límite EIP-170 24.576 B).

**No registrar desde aquí.** El registro en el Diamond de mainnet lo hace el
admin de p2p después de verificar el bytecode (`REGISTER=1` existe en el script,
pero ese paso no es nuestro).

## 4. Después del deploy

- [ ] Verificar el contrato en Blockscout (Base) con el comando que imprime el script.
- [ ] Comparar el runtime con `eth_getCode` y confirmar `runtime size <= 24576`.
      El hash que imprime el script es el del runtime **con las inmutables ya
      puestas**: nunca coincide con `keccak(deployedBytecode)` del artefacto. Y el
      de **mainnet será otro** (chainId 8453 y direcciones distintas): hay que
      mandárselo a p2p después del deploy.
- [ ] Enviar a p2p la dirección **y su `proxyImpl`** para el **whitelist** y
      pedir los **tenants nuevos** (liveness y pasaporte) atados a esa dirección.
      ⚠️ El `proxyImpl` de mainnet es **distinto** del de Sepolia
      (`address(new UserProxy())` en el constructor): el Diamond lo re-deriva y
      exige el registrado. Si p2p registra el de Sepolia, **todo `placeB2BOrder`
      revierte** y el integrador queda muerto: hay que redesplegar.
- [ ] Configurar el Worker de producción:
      `P2P_CHAIN_ID=8453`, `P2P_INTEGRATOR_ADDRESS`, `P2P_DIAMOND_ADDRESS`,
      `P2P_TREASURY_ADDRESS`, `P2P_RPC_URL`, `P2P_LIVENESS_*`, `P2P_KYC_*`.
- [ ] Validar auth de disputas con `eth_call` (`NotAuthorized` / `NotDisputeUser`).
- [ ] Compra real pequeña (mensual, 9,99) → verificar orden, activación y suscripción.
- [ ] Solo entonces, abrir el checkout al público.

## 5. Integrador de Sepolia (staging)

Desplegado el **19-11-2026** con el código `1ee7a69` (10.694 B), para el
end-to-end del checkout antes de mainnet.

| Dato | Valor |
|---|---|
| `BlioCheckoutIntegrator` | `0xb63Ba8185e6e45561D77eF0070a609228A3aE990` |
| `proxyImpl` | `0xC94D30aF42f031BEBA250CA9E70932Facb0d8aF7` |
| Hash del bytecode | `0x438662572fd5548b24cafd5e0aeecf2819832d463a398e8b21b5bee75e6f1751` |
| `owner` (deployer) | `0x58B1F3090386d5c2220FE1985f0fFcB1877B32d2` |
| `treasury` | `0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47` (la Safe de blio) |
| Attestors | los de mainnet (`0x6cC7…2978`, `0xA0bE…3Eda`) |
| Productos | 1..4 con 9,99 / 26,99 / 49,99 / 79,99 y activos |

**Pendiente de p2p** (no se puede probar el checkout hasta tenerlo):
- Registrar `0xb63Ba8…` en el Diamond de Sepolia:
  `registerIntegrator(0xb63Ba8…, proxyImpl, false)` con
  `cancelCallbackEnabled = false`. Hoy `getIntegratorConfig` devuelve
  `isActive = false`.
- **Tenants nuevos** de liveness y pasaporte atados a esa dirección (los
  tenants cuelgan del contrato).

**A tener en cuenta:**
- La Safe de tesorería es **la misma dirección en Sepolia y en mainnet**
  (`0xFB25…df47`, Safe v1.5.0 **2-de-3**), así que el `treasury()` del
  integrador y el `P2P_TREASURY_ADDRESS` del Worker coinciden en las dos
  cadenas y el USDC liquidado en Sepolia también es recuperable.
- El integrador viejo (`0x415627D9…`, 10.523 B) **no tiene** el ancla de liveness
  (`livenessNullifier`): en staging siguen vivos el exploit de la segunda wallet y
  el `limit == 0`. Su `treasury()` **sí es la Safe** (`0x58B1…` es su `owner()`),
  así que la tesorería nunca fue el problema: el motivo del redespliegue es el
  **código**, no la liquidación.
- El `owner` en Sepolia es la **EOA del deployer** para iterar rápido; antes de
  mainnet se puede pasar a la Safe con `transferOwnership` + `acceptOwnership`
  (2 de 3 firmas) para ensayar el flujo real.
- Los productos ya están puestos, pero `setProductPrice`/`setProductActive` son
  `onlyOwner` y el owner es la EOA del deployer: en mainnet hay que hacerlo por
  Safe (MODE=safe) o con el owner que se elija.
- Al cambiar el integrador en staging hay que tocar **dos** sitios y rebuild:
  `apps/api/wrangler.staging.jsonc` (`P2P_INTEGRATOR_ADDRESS`) y el valor por
  defecto de `NEXT_PUBLIC_P2P_INTEGRATOR` en `scripts/deploy-staging.sh` (es
  build-time, `NEXT_PUBLIC_*`).

## 6. Mantener el integrador de Sepolia

No borrar ni desactivar el de Sepolia: staging lo sigue usando para KYC, límites,
disputas (cuando exista la escalera) y regresiones. Sus órdenes en vuelo pueden
disputarse hasta 7 días después, y la escalera puede alargarse días.
