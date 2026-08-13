"""Verifying a passport attestation the same way the integrator does.

The faucet funds a wallet BEFORE that wallet has submitted its attestation on
chain — that is the whole point, since submitting costs gas it doesn't have
yet. So the proof of personhood has to be checked here, off-chain, against the
identical EIP-712 message the contract will later check.

"Identical" is doing real work in that sentence. If this is laxer than
`OwnCheckoutIntegrator.submitPassportAttestation`, the faucet funds wallets
whose attestation the contract then rejects — money out, user still stuck. So
the domain, the typehash and the signature-shape rules below are deliberately
copied from the contract rather than approximated, including the low-`s`
rejection that most verifiers skip.
"""

from __future__ import annotations

from dataclasses import dataclass

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address

#: secp256k1n/2. The contract rejects the high half (EIP-2), so a signature it
#: would refuse must not be good enough for a drip either.
_SECP256K1N_HALF = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0

#: Matches OwnCheckoutIntegrator's `_KYC_DOMAIN_NAME` / `_DOMAIN_VERSION`.
#: This is the passport+liveness service, NOT the liveness-only one — they are
#: separate deployments signing different domains, and confusing them is how
#: two previous integrations shipped a silently dead tier.
DOMAIN_NAME = "KycVerifier"
DOMAIN_VERSION = "1"

_TYPES = {
    "KycAttestation": [
        {"name": "wallet", "type": "address"},
        {"name": "nullifier", "type": "bytes32"},
        {"name": "limit", "type": "uint256"},
        {"name": "expiry", "type": "uint256"},
    ]
}


class InvalidAttestation(Exception):
    """The attestation is malformed, expired, or not signed by the attestor."""


@dataclass(frozen=True)
class Attestation:
    wallet: str
    nullifier: str
    limit: int
    expiry: int
    signature: str


def _signature_bytes(signature: str) -> bytes:
    raw = bytes.fromhex(signature[2:] if signature.startswith("0x") else signature)
    if len(raw) != 65:
        raise InvalidAttestation("signature must be 65 bytes")

    s = int.from_bytes(raw[32:64], "big")
    if s > _SECP256K1N_HALF:
        # Every signature has a malleated twin recovering the same signer; the
        # contract refuses that twin, so funding on it would fund a wallet
        # that cannot then submit.
        raise InvalidAttestation("signature has a high s value")

    v = raw[64]
    if v not in (27, 28):
        raise InvalidAttestation("signature v must be 27 or 28")

    return raw


def recover_attestor(
    attestation: Attestation, *, chain_id: int, integrator: str
) -> str:
    """The address that signed this attestation, as the contract would derive it.

    `verifyingContract = integrator` is the binding that stops an attestation
    minted for one integrator being replayed against another — and, here, stops
    an attestation for some other P2P integrator draining this faucet's budget.
    """
    raw = _signature_bytes(attestation.signature)

    nullifier = attestation.nullifier
    nullifier_bytes = bytes.fromhex(
        nullifier[2:] if nullifier.startswith("0x") else nullifier
    )
    if len(nullifier_bytes) != 32:
        raise InvalidAttestation("nullifier must be 32 bytes")

    signable = encode_typed_data(
        domain_data={
            "name": DOMAIN_NAME,
            "version": DOMAIN_VERSION,
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(integrator),
        },
        message_types=_TYPES,
        message_data={
            "wallet": to_checksum_address(attestation.wallet),
            "nullifier": nullifier_bytes,
            "limit": attestation.limit,
            "expiry": attestation.expiry,
        },
    )

    try:
        return to_checksum_address(Account.recover_message(signable, signature=raw))
    except Exception as exc:  # malformed r/s that ecrecover can't resolve
        raise InvalidAttestation(f"unrecoverable signature: {exc}") from exc


def check_attestation(
    attestation: Attestation,
    *,
    chain_id: int,
    integrator: str,
    attestor: str,
    now: int,
) -> None:
    """Raise unless this attestation would also satisfy the contract.

    Expiry is checked with the contract's own comparison (`now >= expiry` is
    expired), so the faucet never funds a wallet inside a window the contract
    has already closed.
    """
    if now >= attestation.expiry:
        raise InvalidAttestation("attestation expired")

    signer = recover_attestor(attestation, chain_id=chain_id, integrator=integrator)
    if signer.lower() != attestor.lower():
        raise InvalidAttestation("not signed by this integrator's attestor")
