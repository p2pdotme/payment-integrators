#!/usr/bin/env bash
# Deploy de BlioCheckoutIntegrator en Base mainnet.
# No ejecutar sin haber leído docs/blio-mainnet-runbook.md y sin el whitelist
# confirmado por p2p. Es irreversible y cuesta gas.
set -euo pipefail

: "${BASE_RPC_URL:?falta BASE_RPC_URL}"
: "${PRIVATE_KEY:?falta PRIVATE_KEY}"
: "${DIAMOND:?falta DIAMOND}"
: "${USDC:?falta USDC}"
: "${TREASURY:?falta TREASURY}"
: "${OWNER:?falta OWNER}"
: "${LIVENESS_ATTESTOR:?falta LIVENESS_ATTESTOR}"
: "${KYC_ATTESTOR:?falta KYC_ATTESTOR}"
DAILY_TX_COUNT="${DAILY_TX_COUNT:-5}"

if [ "$LIVENESS_ATTESTOR" = "$KYC_ATTESTOR" ]; then
  echo "ERROR: liveness y kyc attestor no pueden ser iguales" >&2
  exit 1
fi

echo "== Red:"
cast chain-id --rpc-url "$BASE_RPC_URL"

echo "== Constructor:"
cat <<EOF
 diamond  = $DIAMOND
 usdc     = $USDC
 treasury = $TREASURY
 owner    = $OWNER
 dailyTx  = $DAILY_TX_COUNT
 liveness = $LIVENESS_ATTESTOR
 kyc      = $KYC_ATTESTOR
EOF

read -r -p "¿Desplegar en MAINNET con estos valores? (escribe SI): " ok
[ "$ok" = "SI" ] || { echo "cancelado"; exit 1; }

forge create contracts/integrators/blio/BlioCheckoutIntegrator.sol:BlioCheckoutIntegrator \
  --rpc-url "$BASE_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --constructor-args \
    "$DIAMOND" "$USDC" "$TREASURY" "$OWNER" "$DAILY_TX_COUNT" \
    "$LIVENESS_ATTESTOR" "$KYC_ATTESTOR"

echo
echo "Siguiente: verificar en Blockscout y pedir el whitelist a p2p."
echo "Luego: P2P_CHAIN_ID=8453, P2P_INTEGRATOR_ADDRESS=<nueva>, P2P_DIAMOND_ADDRESS=$DIAMOND"
