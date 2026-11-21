# OrwizIntegrator

Integrador inmutable en Base para cobrar suscripciones SaaS de **Orwiz** (p. ej. Plan Plus `$20 USDC`, futuro Plan Max `$45 USDC`) pagadas en moneda local (VES / Pago Móvil, etc.) a través del protocolo P2P Diamond y liquidadas en USDC directamente hacia la wallet fría de Tesorería (`treasury`).

## Arquitectura y Flujo de Fondos

1. **Inmutabilidad sin proxy:** `OrwizIntegrator` no utiliza ningún patrón upgradeable. El parámetro `treasury` puede rotarse mediante `setTreasury(address)` (`onlyOwner`, `Ownable2Step`) sin redesplegar el contrato.
2. **Trazabilidad (`intentHash`):**
   - El backend Laravel genera un `bytes32 intentHash` único por intento de pago.
   - `createSubscriptionOrder(...)` valida que el `intentHash` no sea `bytes32(0)`, no esté activo ni ya liquidado, despliega/reutiliza el `UserProxy` canónico del usuario y enruta `IB2BGateway.placeB2BOrder(...)` con `recipientAddr = address(this)`.
3. **Liquidación (`onOrderComplete`):**
   - El Diamond transfiere los USDC al integrador (`usdcThroughIntegrator = true`) e invoca `onOrderComplete`.
   - `OrwizIntegrator` transfiere el 100 % de los USDC recibidos a `treasury` usando `SafeERC20`, marca `settledIntents[intentHash] = true` y emite:
     ```solidity
     event SubscriptionSettled(
         bytes32 indexed intentHash,
         uint256 indexed orderId,
         address indexed payer,
         uint256 usdcAmount,
         address treasury
     );
     ```
4. **Cancelación (`onOrderCancel`):**
   - Libera el cupo diario del usuario (`userDailyCount[payer][placementDay]`), limpia `intentToOrder[intentHash]` para permitir reintentos y emite `SubscriptionOrderCancelled(intentHash, orderId)`.
   - Es idempotente ante llamadas repetidas o `orderId` desconocidos.

## Parámetros exactos para `B2BGatewayFacet.registerIntegrator(...)`

Una vez desplegado y verificado el contrato, el SuperAdmin del Diamond debe ejecutar **ambas** llamadas administrativas:

```solidity
// 1. Registrar integrador (usdcThroughIntegrator MUST BE true)
B2BGatewayFacet.registerIntegrator(
    address integrator,            // Dirección desplegada de OrwizIntegrator
    bool usdcThroughIntegrator,    // MUST BE: true
    address proxyImpl              // Valor exacto de OrwizIntegrator.proxyImpl()
)

// 2. Habilitar el callback de cancelación (apagado por defecto en el Diamond)
B2BGatewayFacet.setIntegratorCancelCallback(
    address integrator,            // Dirección desplegada de OrwizIntegrator
    bool enabled                   // MUST BE: true
)
```

- `usdcThroughIntegrator`: **`true`** (obligatorio para que el Diamond envíe los USDC al contrato integrador antes de ejecutar `onOrderComplete`, donde se reenvían a `treasury`).
- `proxyImpl`: dirección retornada por `cast call <ORWIZ_INTEGRATOR> "proxyImpl()(address)"` (clon canónico de `contracts/base/UserProxy.sol`).
- `setIntegratorCancelCallback(..., true)`: obligatorio porque en el Diamond real viene desactivado por defecto; sin él, las órdenes canceladas/expiradas no invocan `onOrderCancel` y dejan bloqueados `intentToOrder[intentHash]` y `userDailyCount`.

## Despliegue

Configura en `.env` las variables `BASE_SEPOLIA_RPC_URL` (o `BASE_RPC_URL` en mainnet), `DEPLOYER_PRIVATE_KEY` y `BASESCAN_API_KEY`.

### Base Sepolia
El script aplica por defecto las direcciones oficiales de Base Sepolia del protocolo P2P:
- `diamond`: `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`
- `usdc`: `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` (**Importante:** el Diamond de Base Sepolia liquida en el mock token `GG` de 6 decimales, **no** en Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`)

```bash
TREASURY_ADDRESS=0x... \
  npx hardhat run scripts/deploy-orwiz.ts --network baseSepolia
```

### Base Mainnet
```bash
TREASURY_ADDRESS=0x... \
  npx hardhat run scripts/deploy-orwiz.ts --network base
```

Variables opcionales:
- `MAX_TX_LIMIT`: límite máximo por transacción en USDC con 6 decimales (por defecto `50000000` = `50 USDC`, techo inmutable `MAX_TX_LIMIT = 500e6`).
- `DAILY_TX_COUNT_LIMIT`: órdenes máximas por usuario al día (por defecto `5`, techo inmutable `MAX_DAILY_TX_COUNT_LIMIT = 20`).

