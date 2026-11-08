# Especificación verificada — integrador blio/p2p

> **Fase 3 (decisión final):** se eliminó el contrato de tesorería intermedio y su capa de reparto. El diseño vigente es **`treasury` = Safe de blio (`0xFB25…`), inmutable del constructor, settlement directo y sin custodia**. Las referencias a v1/v2 de este documento son históricas.
>
> **Estado:** verificación de solo lectura sobre el código del repo. No se desplegó nada ni se tocó `blio/apps/api`.
>
> **Repo:** `p2pdotme/payment-integrators` · **Rama:** `feat/integrator-blio` · **HEAD de referencia:** `5dfd36a`
>
> **Fecha de verificación:** 2026-10-27 · **Red:** Base Sepolia (`chainId 84532`) · **RPC:** `https://sepolia.base.org`

## 0. Método y límite de la verificación

El código del Diamond real **no está vendorizado** en este repo. Lo que sí está:

- Las interfaces públicas (`contracts/interfaces/IB2BGateway.sol`, `IP2PIntegrator.sol`, `IOrderFlow.sol`).
- `contracts/test/MockDiamond.sol`, que declara explícitamente que replica el comportamiento del `B2BGatewayFacet` real (incluido el orden del struct de `getIntegratorConfig`).
- Documentación de conformidad (`docs/ARCHITECTURE.md`, `docs/WHITELISTING.md`, `docs/INTEGRATORS.md`).
- Lecturas y logs reales contra Base Sepolia.

Por tanto, la especificación combina **código del repo + comportamiento observado on-chain**. Donde la fuente real no está en el repo, se indica y se cita la evidencia on-chain.

## 1. Direcciones verificadas

| Elemento | v1 | v2 |
| --- | --- | --- |
| Integrador | `0x63460ae9566e9274d0034636B85243c216F2FD73` | `0x239dd5df6f460c7df65072b0483e0fbf009f04a3` |
| Runtime | 7.400 bytes | 7.400 bytes |
| Bloque de deploy | 47.866.045 | 48.188.524 |
| `getIntegratorConfig` | `[true, false, false, 8, proxyImpl]` | `[true, false, false, 4, proxyImpl]` |
| `usdcThroughIntegrator` | `false` | `false` |
| `cancelCallbackEnabled` | `false` | `false` |
| `baseTxLimit` | `100000000` (100 USDC, 6 dec) | `100000000` (100 USDC, 6 dec) |
| `dailyTxCountLimit` | `10` | `100` |
| `proxyImpl` | `0x71146B465CE3eEE05108D5f69d82BE92F85F8F64` | `0xC219b46bE7D8395Edbef12Fd78C20385da8a0783` |
| `treasury()` | `0xb975Bc0b57B7E4adBE81E2412446390e66A66D33` | `0xd3704B0f3B869c238b2622C015Ec2f5Bb103e89A` |
| Tipo de `treasury` | **EOA** (`eth_getCode = 0x`, 0 bytes) | Contrato de tesorería (histórico v2; **eliminado en Fase 3**) |
| `owner()` | `0xb975Bc0b57B7E4adBE81E2412446390e66A66D33` (misma EOA) | `0xFB25b3BFc8eCEA01eC70763f92fBc8B3079bdf47` (**Safe v1.5.0, 2-de-3**) |
| `paused()` | `false` | `false` |
| USDC | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` (`GG`, 6 dec) | mismo |

**Diseño vigente (v3, esta rama):** `treasury` = Safe de blio (`0xFB25…`),
settlement directo y sin custodia. Límites por transacción **20 USDC** (INR/liveness),
**100 USDC** (INR/passport), **50 USDC** (otras/liveness) y **200 USDC**
(otras/passport); `dailyTxCountLimit = 5` **colocaciones** por usuario y día UTC.
La compra exige además una **attestation** EIP-712 de liveness o passport (tier
con TTL de 180 días) y una moneda incluida en la allowlist.

**Corrección importante:** la dirección v1 del encargo, `0x63460ae9552e0b7c3c1b4f4dcd2c4f7f0b1a6e5b`, **no tiene código** (0 bytes). La dirección real y verificada es `0x63460ae9566e9274d0034636B85243c216F2FD73`.

Diamond Base Sepolia: `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`.
Diamond Base mainnet (documentado): `0x4cad6eC90e65baBec9335cAd728DDC610c316368`.

El token de pruebas de Base Sepolia tiene símbolo `GG` y 6 decimales; no es el USDC canónico de mainnet.

## 2. Diamond — `getIntegratorConfig`

**Selector:** `0x17353447` = `getIntegratorConfig(address)`.

El integrador de blio lee el flag de routing crudo por selector y offset:

- `contracts/integrators/blio/BlioCheckoutIntegrator.sol:495-512`

### 2.1 Layout post-#362 (5 palabras, el actual)

| Índice | Tipo | Campo | Significado |
| --- | --- | --- | --- |
| 0 | `bool` | `isActive` | Integrador registrado/activo. Si es `false`, los nuevos `placeB2BOrder` deben fallar. |
| 1 | `bool` | `usdcThroughIntegrator` | `true`: el Diamond envía el USDC al integrador al completar. `false`: lo envía directo a `order.recipientAddr`. |
| 2 | `bool` | `cancelCallbackEnabled` | `true`: el Diamond llama `onOrderCancel` al cancelar un BUY. **Por defecto `false`**. |
| 3 | `uint256` | `activeOrderCount` | Número de órdenes activas del integrador (contador del gateway, no un límite). |
| 4 | `address` | `proxyImpl` | Implementación canónica de `UserProxy` fijada en el registro; se usa para derivar CREATE2. |

Fuentes: `scripts/lib/diamond.ts:27-42`, `contracts/test/MockDiamond.sol:143-159`, decode por forma en `scripts/lib/diamond.ts:49-88`.

### 2.2 Layout pre-#362 (4 palabras)

| Índice | Tipo | Campo |
| --- | --- | --- |
| 0 | `bool` | `isActive` |
| 1 | `bool` | `usdcThroughIntegrator` |
| 2 | `uint256` | `activeOrderCount` |
| 3 | `address` | `proxyImpl` |

**No se debe decodificar con un ABI tipado fijo.** Un ABI de 4 campos contra un Diamond de 5 campos no revierte: lee `proxyImpl` del slot de `activeOrderCount` y devuelve `address(0)` o una dirección fabricada. Por eso `scripts/lib/diamond.ts` decodifica por número de palabras (`5` o `4`). Si el struct vuelve a crecer, hay que añadir el layout, no adivinar.

El flag de routing (`usdcThroughIntegrator`) está en el **word 1** en ambos layouts, que es exactamente lo que lee `BlioCheckoutIntegrator._routesThroughIntegrator()`.

## 3. Diamond — `placeB2BOrder`

Firma en `contracts/interfaces/IB2BGateway.sol:9-18`:

```solidity
function placeB2BOrder(
    address user,
    uint256 amount,
    bytes32 currency,
    address recipientAddr,
    string calldata pubKey,
    uint256 circleId,
    uint256 preferredPaymentChannelConfigId,
    uint256 fiatAmountLimit
) external returns (uint256 orderId);
```

| Parámetro | Semántica verificada |
| --- | --- |
| `user` | Dirección del comprador; queda como `order.user` y es la única autorizada para `paidBuyOrder` / `cancelOrder` (ver `contracts/interfaces/IOrderFlow.sol:36-57`). En blio se pasa `msg.sender` del `userPlaceOrder`. |
| `amount` | Importe en USDC, 6 decimales. |
| `currency` | `bytes32` de la moneda fiat (p. ej. `INR`, `BRL`). |
| `recipientAddr` | Destino del USDC cuando `usdcThroughIntegrator = false`. **Es una dirección arbitraria: no se exige que tenga código ni hay whitelist.** |
| `pubKey` | Cadena opaca de la pubkey P2P del usuario para la comunicación con el merchant. El integrador la reenvía sin validarla. |
| `circleId` | Círculo P2P. El Diamond real rechaza `circleId = 0` (el mock lo replica para SELL en `MockDiamond.sol:247-249`). |
| `preferredPaymentChannelConfigId` | Configuración de canal preferida; se reenvía tal cual. |
| `fiatAmountLimit` | Límite del tramo fiat; se reenvía tal cual. |

Blio coloca la orden así:

```solidity
// BlioCheckoutIntegrator.sol:340-364
address proxy = _ensureProxy(msg.sender);
bytes memory data = abi.encodeCall(
    IB2BGateway.placeB2BOrder,
    (msg.sender, total, currency, treasury, pubKey, circleId,
     preferredPaymentChannelConfigId, fiatAmountLimit)
);
bytes memory result = UserProxy(proxy).execute(diamond, data, address(usdc), 0);
return abi.decode(result, (uint256));
```

### 3.1 Quién puede llamar

No llama el integrador directamente: llama **el `UserProxy` del usuario**, que es `msg.sender` para el Diamond.

El gateway autoriza al proxy mediante CREATE2:

- `MockDiamond.sol:271-304` replica `_resolveIntegrator`:
  - `msg.sender` debe tener código.
  - `msg.sender.integrator()` debe ser un integrador activo.
  - `msg.sender.owner()` debe ser distinto de cero.
  - La dirección se re-deriva con `Clones.predictDeterministicAddressWithImmutableArgs(proxyImpl, abi.encodePacked(owner, integrator), bytes32(uint256(uint160(owner))), integrator)` y debe coincidir exactamente con `msg.sender`.
- `docs/ARCHITECTURE.md:25-27` describe el mismo flujo.
- `docs/WHITELISTING.md:58` aclara que el `proxyImpl` no se re-verifica en registro; el gate real es la revisión off-chain del bytecode.

### 3.2 Creación del `UserProxy`

Blio:

- `proxyImpl = address(new UserProxy())` en el constructor: `BlioCheckoutIntegrator.sol:202-208`.
- Salt: `bytes32(uint256(uint160(user)))`: `:514-516`.
- Immutable args: `abi.encodePacked(user, address(this))`: `:518-520`.
- Predicción: `Clones.predictDeterministicAddressWithImmutableArgs(proxyImpl, args, salt, address(this))`: `:482-491`.
- Deploy si no existe: `Clones.cloneDeterministicWithImmutableArgs(...)`: `:522-533`.

`UserProxy` lee sus args del runtime:

- Layout `[owner(20)][integrator(20)]`: `contracts/base/UserProxy.sol:37-44`, `:84-99`.
- `execute` solo puede llamarlo el integrador y prohíbe `target == proxy` o `target == integrator`: `UserProxy.sol:114-144`.

## 4. Diamond — `validateOrder`

Firma en `contracts/interfaces/IP2PIntegrator.sol:10-14`:

```solidity
function validateOrder(address user, uint256 amount, bytes32 currency)
    external returns (bool allowed);
```

Semántica:

- El Diamond la llama **sincrónicamente dentro de `placeB2BOrder`**.
- Si devuelve `false`, el gateway deshace la colocación; si revierte, también la bloquea.
- Referencias: `docs/ARCHITECTURE.md:52`, `MockDiamond.sol:207-217`.

Implementación de blio (`BlioCheckoutIntegrator.sol:370-396`):

1. Solo el Diamond (`onlyDiamond`).
2. Rechaza si `paused`, si no hay `_pendingPlacement`, si ya fue validada, o si `(user, amount, currency)` no coincide exactamente con la colocación en curso.
3. Rechaza `amount == 0`.
4. Rechaza si supera `userTxLimitFor(user, currency)`.
5. Rechaza si el contador diario UTC del usuario ya alcanzó `dailyTxCountLimit`.
6. Marca `pending.validated = true` y **consume** un cupo diario por **colocación**
   (no por liquidación; cancelar o reintentar no lo devuelve).

El campo `validated` es el latch que garantiza:

- Solo una validación exitosa por colocación.
- Que `userPlaceOrder` pueda comprobar que el Diamond **realmente** llamó a `validateOrder`; si no, revierte con `OrderValidationMissing` (`BlioCheckoutIntegrator.sol:320-323`).
- Que una segunda llamada del mismo tuple devuelva `false` en vez de consumir dos cupos.

### 4.1 Gate de attestation (KYC)

`userPlaceOrder` exige `tierOf[msg.sender] != Tier.None`; un comprador sin
attestation revierte con `NotAttested` (falla cerrado y su límite es cero).

- **Tiers:** `1 = Liveness`, `2 = Passport`. Solo suben; intentar bajar revierte
  con `TierDowngrade`.
- **Dos attestors:** `livenessAttestor` y `kycAttestor`, inmutables, no nulos y
  distintos entre sí (el constructor revierte `InvalidAddress`). Son las únicas
  llaves que autorizan un tier; rotarlas exige redeploy.
- **Dos dominios EIP-712** (separadores calculados en el constructor e
  inmutables; `verifyingContract = address(this)`, `version = "1"`,
  `chainId = block.chainid`):
  - Liveness: nombre `LivenessVerifier`, tipo
    `LivenessAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)`.
  - Passport: nombre `KycVerifier`, tipo
    `KycAttestation(address wallet,bytes32 nullifier,uint256 limit,uint256 expiry)`.
  Se exponen con `livenessDomainSeparator()` y `kycDomainSeparator()`.
- **Envío:** `submitLivenessAttestation(nullifier, limit, expiry, signature)`
  (firma sobre `msg.sender`) y
  `submitKycAttestation(wallet, nullifier, limit, expiry, signature)` (firma
  sobre `wallet`, así que un relayer puede pagar el gas sin alterar el grant).
  Autoriza la firma, no `msg.sender`.
- **`limit`:** tope por transacción firmado por el servicio (6 decimales). El
  efectivo es el firmado **solo si es menor** que la política de esa
  moneda/tier; `0` o un valor **mayor** caen a la política. Nunca amplía el
  techo: passport sigue en **100** (INR) / **200** (resto).
- **`expiry`:** deadline de claim del servicio, de vida corta. p2p emite
  claims con `expiry = issuedAt + 1 hora`; el contrato los acepta si están en
  el futuro y como máximo a `MAX_ATTESTATION_DEADLINE` (**2 horas**); si no,
  revierte `DeadlineTooFar`. El TTL del tier es **independiente del claim**:
  dura `ATTESTATION_TTL` (**180 días**) desde la aceptación. Al vencer,
  `_tierOf` devuelve `None` (límite cero y `NotAttested` al colocar) y el
  comprador debe re-attestarse.
- **`nullifier`:** estable por persona y contrato, y **ligado al wallet**
  (`nullifierWallet`), no de un solo uso. El mismo wallet puede re-attestarse
  tras el TTL o subir liveness → passport con el mismo nullifier; usarlo desde
  **otro wallet** revierte `NullifierUsed`.

### 4.2 Allowlist de monedas

`allowedCurrency` solo admite etiquetas exactas aprobadas por el owner
(`setCurrencyAllowed(bytes32,bool)`, evento `CurrencyAllowlistUpdated`). El
constructor habilita `bytes32("INR")` y el comodín `bytes32(0)` (OTHER); cualquier
otra moneda (BRL/PIX/…) debe habilitarse explícitamente. Una etiqueta no
permitida revierte `CurrencyNotAllowed` en `userPlaceOrder` y en
`validateOrder`, lo que bloquea alias como `keccak("INR")`, `"inr"` o `"INR "`
que antes caían en el bucket OTHER.

## 5. Callbacks

### 5.1 `onOrderComplete`

Firma en `contracts/interfaces/IP2PIntegrator.sol:16-21`:

```solidity
function onOrderComplete(
    uint256 orderId,
    address user,
    uint256 amount,
    address recipientAddr
) external;
```

- Se invoca cuando la pata fiat se liquida / la orden se completa.
- El Diamond lo envuelve en `try/catch`: **revertir no revierte la liquidación del protocolo**. El estado on-chain ya quedó finalizado.
- Evidencia: `MockDiamond.sol:306-351` (comentario y `try/catch`), `docs/ARCHITECTURE.md:29`, `docs/INTEGRATORS.md`.
- `recipientAddr` se pasa **igual en las dos ramas de routing**; no sirve para detectar si el USDC fue al integrador o al recipient: `MockDiamond.sol:327-343`.

Blio (`BlioCheckoutIntegrator.sol:406-434`):

- Solo el Diamond.
- Ignora si no hay sesión, si ya está fulfilled o cancelled.
- Lee `getIntegratorConfig` y usa el **word 1**; si no puede leer el config, cae a `usdc.balanceOf(address(this)) >= amount`.
- Si `user`, `amount` o `recipientAddr` no coinciden, o si detecta que el USDC se routed al integrador, emite `SettlementRoutingAnomaly` y **no** marca la sesión como fulfilled.
- Si todo coincide, marca `fulfilled = true` y emite `BlioOrderCompleted`.
- **Nunca revierte** por diseño (comentario `:398-405`).

### 5.2 `onOrderCancel`

Firma en `contracts/interfaces/IP2PIntegrator.sol:32`:

```solidity
function onOrderCancel(uint256 orderId) external;
```

- Se invoca al cancelar un BUY (manual, expiración, disputa o fallo de PAY).
- El gateway lo envuelve en `try/catch`: **revertir es seguro para el protocolo**, pero se pierde la marca `cancelled` y el evento; el cupo no se libera (por diseño).
- Evidencia: `MockDiamond.sol:424-441`, `IP2PIntegrator.sol:23-31`.
- **No se invoca por defecto.** El callback es opt-in y por integrador:
  - `MockDiamond.sol:769-782` lo dice explícitamente: el comportamiento real por defecto es cancelar sin llamar al integrador; `setIntegratorCancelCallback` es opt-in y arranca en `false`.
  - `docs/WHITELIST-REQUEST-baseSepolia.md:24-39` muestra el flujo real: `setIntegratorCancelCallback(integrator, true)` lo ejecuta el super-admin.
  - Selector: `0x42de055b` = `setIntegratorCancelCallback(address,bool)`.

Blio (`BlioCheckoutIntegrator.sol:436-452`):

- Solo el Diamond.
- Ignora sesiones inexistentes, fulfilled o ya cancelled.
- Marca `cancelled = true` y emite `BlioOrderCancelled`.
- **No libera el cupo diario.** El contador mide colocaciones, no liquidaciones:
  cancelar o reintentar consume el cupo del día. Es coherente con
  `cancelCallbackEnabled = false`, que puede no invocar el hook.

### 5.3 ¿Revertir rompe algo?

| Callback | ¿Revertir rompe el protocolo? | ¿Qué se pierde? |
| --- | --- | --- |
| `onOrderComplete` | **No.** El Diamond lo captura con `try/catch`; la liquidación y el estado de la orden ya finalizaron. | El evento `BlioOrderCompleted` y el `fulfilled = true`. blio no concede Premium y la sesión queda abierta. |
| `onOrderCancel` | **No.** También va en `try/catch`. | La marca `cancelled` y `BlioOrderCancelled`; el cupo diario no se libera (se consume al colocar). |

Por eso blio implementa ambos sin revertir y con guards de idempotencia. Aun así, un fallo del callback no se reintenta: el integrador debe ser lo más simple posible y el backend debe alertar por anomalías.

## 6. `recipientAddr`: ¿Safe o EOA?

### Veredicto

**Sí, puede ser una Safe o una EOA.** No hay ninguna comprobación de código, tipo o whitelist sobre `recipientAddr`.

- La firma lo declara como `address` arbitraria: `contracts/interfaces/IB2BGateway.sol:9-18`.
- Blio solo rechaza `address(0)` en el constructor; no exige código: `BlioCheckoutIntegrator.sol:192-197`.
- Blio lo fija a `treasury` al colocar: `BlioCheckoutIntegrator.sol:355`.
- El Diamond, con `usdcThroughIntegrator = false`, hace `usdc.safeTransfer(order.recipientAddr, order.amount)`: `MockDiamond.sol:327-331`; `docs/WHITELISTING.md:44`.
- USDC es un ERC-20 normal: una transferencia a una EOA o a un contrato funciona igual; no hay hook de recepción tipo ERC-721/1155.
- El callback recibe `recipientAddr` en ambas ramas, así que el argumento no demuestra el routing: `MockDiamond.sol:333-343`.

### Prueba on-chain

- **v1 (EOA):** `treasury = 0xb975Bc0b57B7E4adBE81E2412446390e66A66D33`, `eth_getCode` = `0x` (0 bytes). Hay órdenes completadas y transferencias directas del Diamond a esa EOA. Ejemplos:
  - `BlioOrderCompleted` + `Transfer` del Diamond → `0xb975…` en `0x590fb6076593ef09d67b15187ba619114305456f1f53ec6a591c841a5a1c0343`.
  - `getOrdersById(803)`: `user = 0xb975…`, `recipientAddr = 0xb975…`, `status = 3` (COMPLETED).
- **v2 (histórico):** `treasury = 0xd3704B0f3B869c238b2622C015Ec2f5Bb103e89A`, un contrato de tesorería intermedio (eliminado en Fase 3). Hay transferencias directas del Diamond a ese contrato en v2. Ejemplo:
  - `BlioOrderCompleted` + `Transfer` del Diamond → `0xd370…` en `0x1fac1b097bfd1b6432b505710b6d8e3051ecc890cd5592b74f0733b56916ee13`.
  - `getOrdersById(915)`: `recipientAddr = 0xd370…`, `status = 3` (COMPLETED).

### Implicaciones

- **Safe directa:** el USDC llega a la Safe; no hace falta que implemente `receive()` para ERC-20. Para moverlo hay que proponer/ejecutar una transacción Safe.
- **Diseño vigente (Fase 3):** el USDC llega **directo a la Safe de blio** (`0xFB25…`, v1.5.0 2-de-3), que es el `treasury` inmutable del integrador. No hay contrato intermedio ni reparto; el integrador nunca custodia fondos.
- **Riesgo si se registra `usdcThroughIntegrator = true`:** el USDC iría al integrador, no al `recipientAddr`. Blio lo detectaría con `SettlementRoutingAnomaly`, pero el dinero quedaría atrapado hasta que el owner recupere los tokens extraviados. El registro correcto es **`false`**, y así están v1 y v2.

## 7. Eventos necesarios para conceder Premium

### 7.1 `BlioOrderCompleted` — **el evento de concesión**

```solidity
event BlioOrderCompleted(
    uint256 indexed orderId,
    address indexed user,
    uint256 productId,
    uint256 quantity,
    uint256 usdcAmount
);
```

- Fuente: `contracts/integrators/blio/BlioCheckoutIntegrator.sol:80-87`.
- Emisión: `:432-433`.
- Topic0: `0x84f8b1eb8963da43bf311aada56d7da7ee6ae9c4cba47ee09e6b3cef7ac55b53`.
- Topics: `orderId`, `user`. Data: `productId`, `quantity`, `usdcAmount` (todos `uint256`).
- **Es la señal que debe consumir el backend de blio para conceder Premium.** Debe ser idempotente por `orderId` (y idealmente por `txHash + logIndex`).
- No se emite si hay `SettlementRoutingAnomaly` ni si el callback revierte.

### 7.2 `BlioOrderCreated` — intención / auditoría

```solidity
event BlioOrderCreated(
    uint256 indexed orderId,
    address indexed user,
    uint256 productId,
    uint256 quantity,
    uint256 usdcAmount
);
```

- Fuente: `:70-78`; emisión `:337`.
- Topic0: `0xfcddda00840a4d79eb5443493831cf41186b28fd59f5ea5a0a1d0a9216dd2497`.
- Útil para conciliación y para el widget (leer `productId`/`quantity` de un solo recibo), **no** para conceder Premium.

### 7.3 `BlioOrderCancelled` — marca de cancelación (no libera cupo)

```solidity
event BlioOrderCancelled(uint256 indexed orderId, address indexed user);
```

- Fuente: `:89`; emisión `:451`.
- Topic0: `0x3bcf9740e40f2801ad9f92db36504cacd6508097a685cde5c92d4e93e136f934`.
- Solo se emite si el Diamond invoca `onOrderCancel`, lo que hoy **no ocurre** porque `cancelCallbackEnabled = false`. Aun si llegara, solo marca la sesión: no devuelve el cupo diario.

### 7.4 `SettlementRoutingAnomaly` — alerta, no concesión

```solidity
event SettlementRoutingAnomaly(
    uint256 indexed orderId,
    address expectedUser,
    address callbackUser,
    uint256 callbackAmount,
    address callbackRecipient
);
```

- Fuente: `:91-100`; emisión `:428`.
- Topic0: `0x3efd4238a234314699fca0cb8e34665c9210fcaed89674248f96fd35a988e6ce`.
- Solo `orderId` es indexed. Data: `expectedUser`, `callbackUser`, `callbackAmount`, `callbackRecipient`.
- Debe disparar una alerta operativa. La sesión **no** se marca fulfilled; no hay reintento automático.

### 7.5 Eventos del Diamond / proxy (opcionales)

- `B2BOrderPlaced(uint256 indexed orderId, address indexed integrator, address indexed user, uint256 amount)`:
  - Topic0: `0xc5799d7388fadae738b4512b3d224bd808e5ba046f11b2b55cef5ad7b01c5a1d`.
  - Fuente: `docs/INTEGRATORS.md:37-46`.
  - Fallback para obtener el `orderId` si no se decodifica `BlioOrderCreated`.
- `UserProxyDeployed(address indexed user, address proxy)`:
  - Topic0: `0x0903bebe86eeecf23ff310ad0c3c7cca11bb1ced8c13c1b8c905c84b6b231f30`.
  - Fuente: `BlioCheckoutIntegrator.sol:67`; emisión `:531`.
  - Útil para indexar la relación usuario → proxy.

## 8. Inventario del PR / rama

| Archivo | Propósito |
| --- | --- |
| `contracts/integrators/blio/BlioCheckoutIntegrator.sol` | Integrador de checkout: productos, límites por moneda/tier, attestation, `UserProxy`, cupo diario, callbacks y eventos. |
| `docs/integrators/blio.md` | Documentación operativa del integrador (Sepolia, mainnet y Safe). |
| `scripts/deploy-blio.ts` | Deploy + presets 8453/84532 + registro con ABI por red + verificación de config. |
| `scripts/set-blio-products.ts` | Configuración idempotente de productos 1..4: directo (Sepolia EOA) o batch Safe. |
| `test/blio-integrator.test.ts` | Suite del integrador contra `MockDiamond` (attestation, límites, cupo, Safe, reentrancy). |
| `test/blio-integrator-poc.test.ts` | PoC del revisor sobre el gate de attestation. |

La tesorería intermedia no forma parte de esta rama: fue eliminada en la Fase 3.
Esta revisión se apoya en `5dfd36a` (allowlist de monedas y TTL/deadline de
attestation) y en la Fase 6.6: dos attestors y dos dominios EIP-712 separados
(`LivenessVerifier` / `KycVerifier`), con `limit` acotado por política.

## 9. Baseline de pruebas

El baseline de **19 tests** de la Fase 0 quedó obsoleto. La rama añadió
attestation (dos firmas EIP-712 con dominios y claves separadas, firma cruzada,
`limit` acotado por política, nullifier ligado al wallet (re-verificación),
`expiry` y `DeadlineTooFar`, downgrade, relayer KYC, comprador sin attestation), límites
por moneda y nivel, cupo diario, Safe/contrato como treasury, reentrancy,
idempotencia y footprint. La suite declara **72 casos** en
`test/blio-integrator.test.ts` y **3** en `test/blio-integrator-poc.test.ts`
(**75 passing**); el número se obtiene
ejecutando:

```bash
cd /home/xolvora/p2p/payment-integrators
node ./node_modules/hardhat/internal/cli/cli.js test \
  test/blio-integrator.test.ts test/blio-integrator-poc.test.ts
```

Suite completa (referencia; el conteo cambia con el repo):

```bash
node ./node_modules/hardhat/internal/cli/cli.js test
```

Equivalentes habituales si `npm`/`npx` funcionan:

```bash
npm test
# o
npx hardhat test test/blio-integrator.test.ts test/blio-integrator-poc.test.ts
```

### Cobertura actual

- **Attestation:** cada attestor válido en su flujo, firma cruzada
  (clave/tipo/dominio) → `InvalidSignature`, `limit` por encima y por debajo de
  la política, `nullifier` ligado al wallet (re-verificación y upgrade
  permitidos, otro wallet → `NullifierUsed`), `expiry` de claim vencido sin
  cortar el tier, `DeadlineTooFar` a más de 2 h, `NotAttested` tras el TTL,
  downgrade, relayer KYC y comprador sin attestation.
- **Cancelación:** con `cancelCallbackEnabled = false`, una orden cancelada sin
  callback puede completarse y emitir Premium; el cupo no se libera.
- **Treasury:** EOA y contrato tipo Safe.
- **Límites y monedas:** 20/50/100/200 por moneda y tier, allowlist de etiquetas
  exactas y el sexto intento del día.
- **Reentrancy**, idempotencia de `onOrderComplete` y footprint EIP-170.

## 10. Restricciones técnicas

| Restricción | Valor / estado |
| --- | --- |
| Límite de runtime (EIP-170) | **24.576 bytes** |
| Runtime de `BlioCheckoutIntegrator` | **10.523 bytes** (mucho margen) |
| Runtime del contrato de tesorería intermedio | **eliminado en Fase 3** |
| Initcode de `BlioCheckoutIntegrator` | **15.315 bytes** (límite EIP-3860: 49.152) |
| Solidity | Compilador **0.8.28**; pragma del contrato `^0.8.20` |
| Settings | `evmVersion: "cancun"`, `viaIR: true`, optimizer `enabled`, `runs: 200` |
| OpenZeppelin | **5.6.1** instalado (`package.json`: `^5.0.1`) |
| `SafeERC20` | Disponible e importado (`BlioCheckoutIntegrator.sol:8`) |
| `Ownable2Step` | Disponible e importado (`:11`); el contrato hereda de él (`:39`) |
| `ReentrancyGuard` | Disponible e importado (`:12`) |
| `Clones` | Disponible e importado (`:9`) |
| `UserProxy` | Usa `transient` (EIP-1153); requiere Cancun, que Base soporta (`UserProxy.sol:64-74`) |
| Upgradeability | No hay. `diamond`, `usdc`, `proxyImpl` y `treasury` son `immutable`; `proxyImpl` es set-once en el Diamond |
| Límites duros del integrador | `MAX_TX_LIMIT_INR_LIVENESS = 20e6`, `MAX_TX_LIMIT_INR_PASSPORT = 100e6`, `MAX_TX_LIMIT_OTHER_LIVENESS = 50e6`, `MAX_TX_LIMIT_OTHER_PASSPORT = 200e6`; `MAX_DAILY_TX_COUNT_LIMIT = 5` |
| Registro | Base Sepolia: `registerIntegrator(integrator, usdcThroughIntegrator, proxyImpl)` (3 args); Base mainnet: 4.º `cancelCallbackEnabled`. `proxyImpl` set-once (`docs/WHITELISTING.md:58-62`) |
| Allowlist de monedas | `allowedCurrency`; constructor habilita INR y OTHER; `setCurrencyAllowed` `onlyOwner` |

El límite de 24.576 bytes es el que ya obliga a `MerchantTerminalIntegrator` a usar `runs: 50` (`hardhat.config.ts:80-100`). Blio está muy por debajo, así que el rediseño puede añadir lógica sin acercarse al límite, salvo que se incorporen librerías grandes.

## 11. Sorpresas y riesgos que cambian el plan

1. **La dirección v1 del encargo es incorrecta.** `0x63460ae9552e0b7c3c1b4f4dcd2c4f7f0b1a6e5b` no tiene código. La real es `0x63460ae9566e9274d0034636B85243c216F2FD73`. Cualquier script o verificación que use la primera fallará o leerá vacío.

2. **v1 usa una EOA como tesorería y como owner.** `0xb975…` tiene 0 bytes de código y es a la vez `treasury` y `owner`. La documentación operativa dice que ambos “deberían ser el multisig de blio”; el despliegue v1 no lo cumple. v2 usó un contrato intermedio + Safe v1.5.0 2-de-3; la v3 apunta directo a la Safe, sin contrato intermedio.

3. **`cancelCallbackEnabled = false` es intencional.** En producción el Diamond
   puede no llamar `onOrderCancel` al cancelar un BUY. El cupo diario se consume
   al **colocar** (`validateOrder`), no al liquidar, así que cancelar o
   reintentar no lo devuelve. No hace falta `setIntegratorCancelCallback`; si el
   backend necesita bookkeeping, reconcilia por `getOrdersById`/expiración.

4. **`SettlementRoutingAnomaly` no reintenta ni resuelve.** Deja la sesión sin `fulfilled` y sin `BlioOrderCompleted`. El backend debe alertar y resolver manualmente (o con un job de reconciliación). No se debe conceder Premium por `BlioOrderCreated`.

5. **Un callback que revierte no rompe el protocolo, pero pierde el evento.** El `try/catch` del Diamond es la red de seguridad; no hay reintento. Por eso el contrato no debe revertir en `onOrderComplete`/`onOrderCancel` y el indexer debe ser tolerante a logs faltantes.

6. **Si el rediseño usa una Safe/smart account como `user` comprador**, el Diamond autoriza `paidBuyOrder` y `cancelOrder` contra `order.user`, no contra el que colocó ni contra `recipientAddr` (`IOrderFlow.sol:36-57`). Un relayer no podrá marcar pagado/cancelar en nombre de una Safe sin que la Safe ejecute la llamada. Para blio, el comprador debe seguir siendo la EOA/proxy que controla el flujo, o adaptar la UX.

7. **El struct de `getIntegratorConfig` puede volver a crecer.** El contrato de blio lee el word 1 crudo y sobrevive a inserciones en medio; cualquier script que use un ABI tipado fijo se romperá silenciosamente. Mantener el decode por forma de `scripts/lib/diamond.ts`.

8. **`usdcThroughIntegrator` puede re-afirmarse con `registerIntegrator`** (mismo `proxyImpl`). Un registro erróneo a `true` enviaría el USDC al integrador, no al treasury. Blio lo detecta, pero no lo recupera automáticamente. Hay que verificar el flag después de cada registro (el deploy script lo hace con `registerIntegrator` + `getIntegratorConfig`).

9. **El token de pruebas no es el USDC de mainnet.** En Base Sepolia el token usado es `GG` (6 dec). No copiar direcciones de token entre redes.

10. **El código del Diamond no está en este repo.** La verificación es contra interfaces, mock de conformidad y cadena real. Si el protocolo cambia el facet, hay que repetir las lecturas on-chain antes de la fase de implementación.

## 12. Comandos de reproducción (sin `cast`)

No hay `cast`/`forge` instalados en el servidor. Estos comandos usan `ethers` del propio repo y el RPC público:

```bash
cd /home/xolvora/p2p/payment-integrators
node -e '
const {ethers}=require("ethers");
(async()=>{
  const p=new ethers.JsonRpcProvider("https://sepolia.base.org");
  const diamond="0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9";
  const igs={
    v1:"0x63460ae9566e9274d0034636B85243c216F2FD73",
    v2:"0x239dd5df6f460c7df65072b0483e0fbf009f04a3"
  };
  for(const [k,ig] of Object.entries(igs)){
    const raw=await p.call({to:diamond,data:"0x17353447"+ethers.zeroPadValue(ig,32).slice(2)});
    const words=(raw.length-2)/64;
    const types=words===5?["bool","bool","bool","uint256","address"]:["bool","bool","uint256","address"];
    const v=ethers.AbiCoder.defaultAbiCoder().decode(["tuple("+types.join(",")+")"],raw)[0].toArray();
    const c=new ethers.Contract(ig,[
      "function treasury() view returns (address)",
      "function baseTxLimit() view returns (uint256)",
      "function dailyTxCountLimit() view returns (uint256)",
      "function proxyImpl() view returns (address)"
    ],p);
    console.log(k, ig, words, v.map(x=>x.toString()));
    console.log("  treasury", await c.treasury());
    console.log("  baseTxLimit", (await c.baseTxLimit()).toString());
    console.log("  dailyTxCountLimit", (await c.dailyTxCountLimit()).toString());
    console.log("  proxyImpl", await c.proxyImpl());
  }
})();
'
```

Equivalentes con `cast` (si se instala Foundry):

```bash
cast call 0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9 \
  "getIntegratorConfig(address)(bool,bool,bool,uint256,address)" \
  0x239dd5df6f460c7df65072b0483e0fbf009f04a3 \
  --rpc-url https://sepolia.base.org

cast call 0x239dd5df6f460c7df65072b0483e0fbf009f04a3 "treasury()(address)" --rpc-url https://sepolia.base.org
cast call 0x239dd5df6f460c7df65072b0483e0fbf009f04a3 "baseTxLimit()(uint256)" --rpc-url https://sepolia.base.org
cast call 0x239dd5df6f460c7df65072b0483e0fbf009f04a3 "dailyTxCountLimit()(uint256)" --rpc-url https://sepolia.base.org
```

## 13. Decisiones que debe cerrar la Fase 1

1. **Destino de tesorería (cerrado):** **Safe de blio directa** (`0xFB25…`), inmutable del constructor. Sin contrato intermedio ni reparto; mover fondos exige una transacción Safe.
2. **Cancel callback (cerrado):** se mantiene `false`; el cupo es por colocación y no se libera. El backend reconcilia cancelaciones/expirables por `getOrdersById` si lo necesita.
3. **Contrato nuevo vs reutilizar v2:** se despliega un integrador nuevo. El v2 usaba un contrato intermedio; en v3 `treasury` es inmutable y apunta a la Safe, mientras que `owner` es transferible (`Ownable2Step`). Cambiar de tesorería exige otro despliegue.
4. **Indexación:** consumir `BlioOrderCompleted` con idempotencia por `orderId` y alerta por `SettlementRoutingAnomaly`; no conceder Premium por `BlioOrderCreated`.
5. **Comprador:** mantener EOA/proxy como `user` para que `paidBuyOrder`/`cancelOrder` sigan siendo ejecutables; si se usa Safe/smart account, diseñar ese flujo explícitamente.
