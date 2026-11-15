# Runbook: deploy de `BlioCheckoutIntegrator` en Base mainnet

> **Estado: NO ejecutado.** Este documento y el script dejan todo preparado para
> desplegar en cuanto p2p confirme el whitelist y las divisas. El deploy es
> **irreversible** (el contrato no es proxy) y cuesta gas: leer entero antes.

## 1. Valores que hay que fijar antes de desplegar

| Parámetro | Producción (a confirmar) | Notas |
|---|---|---|
| `DIAMOND` | `0x4cad6eC90e65baBec9335cAd728DDC610c316368` | Base mainnet (verificado 13-nov-2026) |
| `USDC` | **pendiente** | USDC nativo de Base; confirmar dirección con p2p |
| `TREASURY` | Safe de blio | Debe ser una Safe (no EOA) |
| `OWNER` | Safe de blio (o multisig operativa) | El owner puede cambiar límites y pausar |
| `DAILY_TX_COUNT` | 5 | Tope diario por usuario |
| `LIVENESS_ATTESTOR` | `0x6cC780E44f9Ac850e6D6B8f52A5663286F1A2978` | El de Sepolia; **pedir confirmación del de mainnet** |
| `KYC_ATTESTOR` | `0xA0bE015133e4dc63c96EBFB6729D34050Ef33Eda` | Idem |

## 2. Checklist previo

- [ ] p2p confirma **divisas** permitidas y que el integrador se whitelistea en mainnet.
- [ ] p2p confirma los **attestors de mainnet** (liveness y KYC) y los **tenants** de producción.
- [ ] Safe de tesorería y owner creadas y con firmantes suficientes.
- [ ] `P2P_TREASURY_ADDRESS` de producción **coincide** con la Safe (el código la pinea contra `P2P_SAFE_TREASURY`).
- [ ] Fondos de gas en la cuenta de despliegue (solo creación; los userOps van por Pimlico).
- [ ] **Política nueva de Pimlico** creada con presupuesto (la anterior está inservible).
- [ ] Redirect de liveness/KYC permitido para `https://blio.me/checkout?kyc=1`.

## 3. Deploy

```bash
cd /home/xolvora/p2p/payment-integrators
export BASE_RPC_URL="https://mainnet.base.org"       # o RPC propio
export PRIVATE_KEY="0x..."                            # cuenta de deploy (no la Safe)
export DIAMOND=0x4cad6eC90e65baBec9335cAd728DDC610c316368
export USDC=0x...           # CONFIRMAR
export TREASURY=0x...       # Safe
export OWNER=0x...          # Safe / multisig
export LIVENESS_ATTESTOR=0x...
export KYC_ATTESTOR=0x...
./scripts/deploy-mainnet-blio.sh
```

El script imprime: dirección del integrador, tx hash y los comandos de
verificación en Blockscout y de comprobación de tamaño (límite 24.576 B).

## 4. Después del deploy

- [ ] Verificar el contrato en Blockscout (Base).
- [ ] Comprobar `runtime size <= 24576` y que el creation code coincide con el auditado.
- [ ] Pedir a p2p el **whitelist en mainnet** con `usdcThroughIntegrator` y
      `cancelCallback` **iguales** a los de Sepolia (salvo cambio de flujo).
- [ ] Configurar el Worker de producción:
      `P2P_CHAIN_ID=8453`, `P2P_INTEGRATOR_ADDRESS`, `P2P_DIAMOND_ADDRESS`,
      `P2P_TREASURY_ADDRESS`, `P2P_RPC_URL`, `P2P_LIVENESS_*`, `P2P_KYC_*`.
- [ ] Validar auth de disputas con `eth_call` (`NotAuthorized` / `NotDisputeUser`).
- [ ] Compra real pequeña (mensual, 9,99) → verificar orden, activación y suscripción.
- [ ] Solo entonces, abrir el checkout al público.

## 5. Mantener el integrador de Sepolia

No borrar ni desactivar el de Sepolia: staging lo sigue usando para KYC, límites,
disputas (cuando exista la escalera) y regresiones. Sus órdenes en vuelo pueden
disputarse hasta 7 días después, y la escalera puede alargarse días.
