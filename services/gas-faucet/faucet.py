"""P2P gas faucet — the cold start for fiat on-ramp users.

Every P2P checkout integrator has the same hole in it. A user arrives to buy
their first stablecoin with fiat, which means they hold no native ETH, which
means they cannot send the three transactions the purchase needs:

    submitPassportAttestation   ~100k gas   once per wallet
    buyUsdc                    ~1.11M gas   (first call also deploys the proxy)
    paidBuyOrder                ~150k gas   per order

At Base's prevailing fee that is about **1.5 cents for the whole journey** —
this was never a cost problem, only a chicken-and-egg one. The onramp is the
thing that would have given them the gas.

`paidBuyOrder` is why the fix has to be a drip rather than a relayer.
OrderFlowHelper accepts it only from `_order.user` or a protocol admin, and
that call is the buyer's own attestation that they moved fiat — sending it on
their behalf would fabricate a payment claim. It has to come from their
wallet, so their wallet has to have gas.

── What stops this being a free ETH tap ─────────────────────────────────────

A wallet is funded only if a real human is behind it, established one of two
ways:

  * A passport attestation signed by the integrator's attestor, verified here
    against the identical EIP-712 message the contract checks. This is the
    cold-start path — the wallet has no gas, so it cannot have submitted yet.
  * `verified(wallet)` already true on the integrator. Every drip after the
    first takes this path.

On top of that, three ceilings, all per UTC day: per wallet, per **nullifier**
(the per-(tenant, human) id, so one person spreading over many wallets shares
one budget), and one global circuit breaker. Worst case for a determined,
genuinely-KYC'd attacker is their own per-identity cap — cents.

── Not in the funds path ────────────────────────────────────────────────────

The faucet sends native gas to the user's own address and nothing else. It
holds no USDC, has no relationship to settlement, and cannot influence where
an order pays out. If it is down, verification and purchase still work for
anyone holding gas already — so callers must treat a failure here as a
degraded convenience, never as a blocked ramp.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from dataclasses import dataclass

from eth_utils import to_checksum_address
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from attestation import (
    Attestation,
    InvalidAttestation,
    canonical_nullifier,
    check_attestation,
)
from chain import (
    SEL_BLOCKED,
    SEL_NULLIFIER_SPENT,
    SEL_VERIFIED,
    ChainError,
    Rpc,
    account_from_key,
)
from policy import Decision, Limits, decide, drip_target_wei, floor_wei
from store import Store

GWEI = 10**9


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class Integrator:
    """One fundable deployment."""

    chain_id: int
    address: str
    #: Signer of that integrator's attestations. MUST come from the service's
    #: own /v1/attestor — a wrong value here silently rejects every cold-start
    #: request, which looks identical to the faucet being down.
    attestor: str
    label: str


def _load_integrators() -> dict[tuple[int, str], Integrator]:
    """FAUCET_INTEGRATORS, a JSON array of {chainId, address, attestor, label}."""
    raw = os.environ.get("FAUCET_INTEGRATORS", "[]")
    out: dict[tuple[int, str], Integrator] = {}
    for entry in json.loads(raw):
        integrator = Integrator(
            chain_id=int(entry["chainId"]),
            address=to_checksum_address(entry["address"]),
            attestor=to_checksum_address(entry["attestor"]),
            label=entry.get("label", entry["address"][:10]),
        )
        out[(integrator.chain_id, integrator.address.lower())] = integrator
    return out


def _load_rpcs() -> dict[int, str]:
    """FAUCET_RPC_URLS, a JSON object of {"8453": "https://..."}."""
    raw = os.environ.get("FAUCET_RPC_URLS", "{}")
    return {int(k): v for k, v in json.loads(raw).items()}


INTEGRATORS = _load_integrators()
RPC_URLS = _load_rpcs()
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()
]
#: Preview deployments get a fresh hostname per build, so an exact-match list
#: cannot cover them — a regex can. Keep it anchored and specific to the
#: project; a loose pattern here is what turns "who may call us" into "anyone".
ALLOWED_ORIGIN_REGEX = os.environ.get("ALLOWED_ORIGIN_REGEX", "").strip()

LIMITS = Limits(
    # A full first journey is ~1.36M gas measured; round up for the proxy
    # deploy and any facet growth.
    gas_units=_int_env("FAUCET_GAS_UNITS", 1_500_000),
    safety_factor=_int_env("FAUCET_SAFETY_FACTOR", 4),
    # Floors and ceilings in wei. The ceiling is the real protection: at Base's
    # usual 0.005 gwei a target lands near 3e13 wei (~$0.06), and this caps a
    # fee spike at roughly ten times that rather than letting it scale freely.
    min_target=_int_env("FAUCET_MIN_TARGET_WEI", 20_000_000_000_000),
    max_target=_int_env("FAUCET_MAX_TARGET_WEI", 400_000_000_000_000),
    max_drips_per_wallet=_int_env("FAUCET_MAX_DRIPS_PER_WALLET", 4),
    max_wei_per_wallet=_int_env("FAUCET_MAX_WEI_PER_WALLET", 800_000_000_000_000),
    max_wei_per_nullifier=_int_env("FAUCET_MAX_WEI_PER_NULLIFIER", 1_600_000_000_000_000),
    max_wei_global=_int_env("FAUCET_MAX_WEI_GLOBAL", 200_000_000_000_000_000),
)

_DB_PATH = os.environ.get("FAUCET_DB_PATH", "faucet.db")
if os.environ.get("FAUCET_ALLOW_EPHEMERAL_DB") != "1" and not os.path.isabs(_DB_PATH):
    # Every daily cap is a SUM over this file. On a container a relative path
    # is ephemeral, so the caps silently reset on each deploy — the failure is
    # invisible until someone reconciles spend against the ledger. The correct
    # setting used to live only in a runbook; now the service refuses to start
    # without it. Set FAUCET_ALLOW_EPHEMERAL_DB=1 for local runs and tests.
    raise RuntimeError(
        f"FAUCET_DB_PATH must be an absolute path on a persistent volume, got {_DB_PATH!r}. "
        "Every daily cap is computed from this file; on ephemeral disk they reset on deploy. "
        "Set FAUCET_ALLOW_EPHEMERAL_DB=1 to override for local use."
    )
STORE = Store(_DB_PATH)
_ACCOUNT = (
    account_from_key(os.environ["FAUCET_PRIVATE_KEY"])
    if os.environ.get("FAUCET_PRIVATE_KEY")
    else None
)
#: One key, one nonce sequence. Every send is serialised behind this.
_SEND_LOCK = threading.Lock()
_RPCS: dict[int, Rpc] = {}


def _rpc(chain_id: int) -> Rpc:
    if chain_id not in _RPCS:
        url = RPC_URLS.get(chain_id)
        if not url:
            raise HTTPException(400, f"no RPC configured for chain {chain_id}")
        _RPCS[chain_id] = Rpc(url)
    return _RPCS[chain_id]


# No Swagger, no ReDoc, no schema. This process holds a key and is exposed
# publicly; a self-documenting console over it is a convenience for exactly one
# kind of visitor. Set FAUCET_ENABLE_DOCS=1 in a private environment.
_DOCS = os.environ.get("FAUCET_ENABLE_DOCS") == "1"
app = FastAPI(
    title="P2P Gas Faucet",
    version="1.0",
    docs_url="/docs" if _DOCS else None,
    redoc_url="/redoc" if _DOCS else None,
    openapi_url="/openapi.json" if _DOCS else None,
)
if ALLOWED_ORIGINS or ALLOWED_ORIGIN_REGEX:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=ALLOWED_ORIGIN_REGEX or None,
        allow_methods=["POST", "GET", "OPTIONS"],
        allow_headers=["*"],
    )


class AttestationIn(BaseModel):
    nullifier: str
    limit: int
    expiry: int
    signature: str


class GasRequest(BaseModel):
    chainId: int
    integrator: str
    wallet: str
    #: Present on the very first request, before the wallet can afford to
    #: submit it on chain. Omitted afterwards, when `verified()` answers.
    attestation: AttestationIn | None = None


class GasResponse(BaseModel):
    funded: bool
    reason: str
    balanceWei: str
    targetWei: str
    amountWei: str = "0"
    txHash: str | None = None
    #: Set when the transaction was broadcast but the receipt didn't arrive in
    #: time. The drip is booked either way; the caller should just wait.
    pending: bool = False


@app.get("/healthz")
def healthz() -> dict:
    """Liveness only.

    This used to publish the funder address, its balance on every chain, spend
    so far and the global cap — a live budget gauge on an unauthenticated
    endpoint, which tells a visitor exactly how much is left and when the caps
    reset. Operators get the same numbers from /v1/ops/health with a token.
    """
    return {"status": "ok" if _ACCOUNT else "no_key"}


@app.get("/v1/ops/health")
def ops_health(token: str = "") -> dict:
    """The operational numbers, behind a shared secret.

    Unavailable rather than public when FAUCET_OPS_TOKEN is unset, because a
    default-open operational endpoint is how the previous version leaked.
    """
    expected = os.environ.get("FAUCET_OPS_TOKEN", "")
    if not expected or not secrets.compare_digest(token, expected):
        raise HTTPException(404, "not_found")

    out: dict = {
        "status": "ok" if _ACCOUNT else "no_key",
        "integrators": [
            {"chainId": i.chain_id, "address": i.address, "label": i.label}
            for i in INTEGRATORS.values()
        ],
    }
    if _ACCOUNT:
        out["funder"] = _ACCOUNT.address
        balances = {}
        for chain_id in RPC_URLS:
            try:
                balances[str(chain_id)] = str(_rpc(chain_id).balance(_ACCOUNT.address))
            except (ChainError, HTTPException) as exc:
                balances[str(chain_id)] = f"error: {exc}"
        out["funderBalanceWei"] = balances
        usage = STORE.usage(wallet="0x", nullifier=None)
        out["spentTodayWei"] = str(usage.global_wei)
        out["globalCapWei"] = str(LIMITS.max_wei_global)
    return out


def _recall_nullifier(wallet: str) -> str | None:
    """The identity a verified wallet was funded under, from the ledger.

    See `Store.nullifier_for`. Returns None for a wallet the faucet has never
    funded — which is a genuine unknown, not a licence: that wallet has its own
    per-wallet caps, and the first drip it ever takes goes through the
    attestation path and records the identity for every drip after.
    """
    return STORE.nullifier_for(wallet)


def _authorise(req: GasRequest, integrator: Integrator, rpc: Rpc, wallet: str) -> str | None:
    """Establish a human is behind `wallet`. Returns their nullifier, if known.

    Raises 403 when it cannot be established — never funds on the benefit of
    the doubt, because the doubt is exactly what an attacker supplies.

    Ordered cheapest-first on purpose. Signature verification is free and
    local; every chain read costs an RPC call this service pays for. Doing the
    `blocked` read before looking at the attestation meant an unauthenticated
    caller could bill us an `eth_call` per request with a junk body, which is
    the opposite of what `policy.decide` documents as the intended order.
    """
    nullifier: str | None = None

    if req.attestation is not None:
        # Free and local. Anything malformed or unsigned dies here, before a
        # single RPC call is spent on it.
        try:
            check_attestation(
                Attestation(
                    wallet=wallet,
                    nullifier=req.attestation.nullifier,
                    limit=req.attestation.limit,
                    expiry=req.attestation.expiry,
                    signature=req.attestation.signature,
                ),
                chain_id=integrator.chain_id,
                integrator=integrator.address,
                attestor=integrator.attestor,
                now=int(time.time()),
            )
            # Canonical form only — the raw request string is attacker-chosen
            # and has many spellings that decode identically.
            nullifier = canonical_nullifier(req.attestation.nullifier)
        except InvalidAttestation as exc:
            raise HTTPException(403, f"invalid_attestation: {exc}") from exc

    # Denylisted wallets get nothing, on either path — this is the operator's
    # only revocation lever, so it fails CLOSED.
    #
    # It used to swallow ChainError and continue, on the theory that an
    # integrator might not expose the getter. That theory was empty: `blocked`
    # and `verified` are declared together on every integrator using this
    # faucet, so anything missing one is missing both and would 502 below
    # anyway. What the except actually caught was RPC faults — a timeout, a
    # 429, an empty result — each of which turned a denylisted wallet into a
    # funded one, silently.
    try:
        is_blocked = rpc.read_bool(integrator.address, SEL_BLOCKED, wallet)
    except ChainError as exc:
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc
    if is_blocked:
        raise HTTPException(403, "wallet_blocked")

    if nullifier is not None:
        # Has this passport already verified a wallet?
        #
        # The nullifier is GLOBALLY single-use in the contract
        # (`nullifierSpent`), so one passport verifies exactly one wallet ever.
        # Without this read the faucet happily funded the cold start for wallet
        # after wallet on the same identity, each into a
        # `submitPassportAttestation` that reverts `NullifierAlreadySpent` —
        # money out, user still stuck, which is the exact outcome this module
        # exists to prevent.
        try:
            if rpc.read_bool32(integrator.address, SEL_NULLIFIER_SPENT, nullifier):
                raise HTTPException(403, "nullifier_already_spent")
        except ChainError as exc:
            raise HTTPException(502, f"chain_unreachable: {exc}") from exc
        return nullifier

    try:
        if rpc.read_bool(integrator.address, SEL_VERIFIED, wallet):
            # No nullifier on this path — the wallet is verified on chain and
            # the caller sent no attestation. `_recall_nullifier` recovers it
            # from the ledger so the per-identity cap still applies; see there
            # for why omitting the field must not be a way to opt out of it.
            return _recall_nullifier(wallet)
    except ChainError as exc:
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc

    raise HTTPException(403, "not_verified")


@app.post("/v1/gas/request", response_model=GasResponse)
def request_gas(req: GasRequest) -> GasResponse:
    if _ACCOUNT is None:
        raise HTTPException(503, "faucet_not_configured")

    try:
        wallet = to_checksum_address(req.wallet)
        integrator_addr = to_checksum_address(req.integrator)
    except Exception as exc:
        raise HTTPException(400, f"bad_address: {exc}") from exc

    integrator = INTEGRATORS.get((req.chainId, integrator_addr.lower()))
    if integrator is None:
        # An allowlist, not a filter: an unknown integrator could point the
        # attestation check at an attestor of the caller's choosing.
        raise HTTPException(403, "integrator_not_allowed")

    rpc = _rpc(integrator.chain_id)
    nullifier = _authorise(req, integrator, rpc, wallet)

    # Serialise the WHOLE decision — the chain reads included, not just the
    # ledger read.
    #
    # The balance used to be read out here, before the lock. Six concurrent
    # requests for one empty wallet then all saw a balance of zero, all decided
    # to fund, and the wallet received four times the target: `funded` four
    # times and `wallet_daily_count_reached` twice, with `sufficient_balance`
    # never firing at all. That made `policy.decide`'s top-up-only-the-shortfall
    # arithmetic dead code and left `max_drips_per_wallet` as the only surviving
    # bound.
    #
    # The money was small. The user-facing damage was not: a client that
    # retries on a slow response burns the wallet's entire daily allowance in
    # one burst, and the buyer is then refused until midnight UTC while holding
    # four times the gas they needed. `policy.decide` checks
    # `sufficient_balance` before the caps precisely so that asking repeatedly
    # cannot exhaust someone's day, and that guarantee was void.
    #
    # This holds the lock across three RPC round trips, which serialises
    # concurrent drips. That is the intent: one key, one nonce sequence, and
    # sends were already serialised here anyway.
    with _SEND_LOCK:
        try:
            balance = rpc.balance(wallet)
            base_fee = rpc.base_fee()
            funder_balance = rpc.balance(_ACCOUNT.address)
        except ChainError as exc:
            raise HTTPException(502, f"chain_unreachable: {exc}") from exc

        target = drip_target_wei(base_fee, LIMITS)
        usage = STORE.usage(wallet=wallet, nullifier=nullifier)
        decision: Decision = decide(
            balance=balance,
            target=target,
            wallet_drips_today=usage.wallet_drips,
            wallet_wei_today=usage.wallet_wei,
            nullifier_wei_today=usage.nullifier_wei,
            global_wei_today=usage.global_wei,
            funder_balance=funder_balance,
            limits=LIMITS,
        )

        if not decision.fund:
            return GasResponse(
                funded=False,
                reason=decision.reason,
                balanceWei=str(balance),
                targetWei=str(target),
            )

        try:
            tx_hash = rpc.send_value(
                account=_ACCOUNT,
                to=wallet,
                amount_wei=decision.amount,
                chain_id=integrator.chain_id,
                base_fee=base_fee,
            )
        except ChainError as exc:
            raise HTTPException(502, f"send_failed: {exc}") from exc

        STORE.record(
            chain_id=integrator.chain_id,
            wallet=wallet,
            nullifier=nullifier,
            amount_wei=decision.amount,
            tx_hash=tx_hash,
        )

    # Broadcast is booked; confirmation is a courtesy so the caller can send
    # its own transaction immediately instead of polling the balance.
    #
    # A reverted transfer is reported as NOT funded. The drip stays on the
    # ledger deliberately — the gas was spent and the cap should feel it — but
    # telling the caller `funded: true` when nothing moved is worse than
    # useless: it is the one signal they have, and it would be a lie.
    outcome = _await_receipt(rpc, tx_hash)

    return GasResponse(
        funded=outcome != "failed",
        reason=decision.reason if outcome != "failed" else "send_reverted",
        balanceWei=str(balance),
        targetWei=str(target),
        amountWei=str(decision.amount) if outcome != "failed" else "0",
        txHash=tx_hash,
        pending=outcome == "pending",
    )


def _await_receipt(rpc: Rpc, tx_hash: str, *, attempts: int = 12, delay: float = 1.0) -> str:
    """Wait briefly for the drip to land: "success" | "failed" | "pending".

    A receipt existing is not the same as the transfer having worked — a
    reverted or out-of-gas transaction has one too, with `status: 0x0`. This
    used to return True on any non-null receipt, so the caller reported
    `funded: true` for a transfer that moved nothing, and the client had no way
    to tell the difference except by reading the balance itself.
    """
    for _ in range(attempts):
        try:
            receipt = rpc.call("eth_getTransactionReceipt", [tx_hash])
            if receipt is not None:
                status = receipt.get("status") if isinstance(receipt, dict) else None
                # Pre-Byzantium receipts have no status field; treat absence as
                # success rather than inventing a failure.
                return "failed" if status is not None and int(str(status), 16) == 0 else "success"
        except ChainError:
            pass
        time.sleep(delay)
    return "pending"


@app.get("/v1/gas/status")
def status(chainId: int, integrator: str, wallet: str) -> dict:
    """What the faucet would do for this wallet, without doing it.

    `wouldFund` runs the SAME `decide()` the funding path runs. It used to be
    `balance < floor_wei(target)`, which ignored every cap — so it answered
    true for a wallet the caps would refuse, and the incident runbook tells
    operators to trust that field.
    """
    try:
        integrator_key = (chainId, to_checksum_address(integrator).lower())
        wallet = to_checksum_address(wallet)
    except Exception as exc:
        # Outside a try this raised ValueError and surfaced as a 500 — an
        # attacker-controlled 5xx on a key-holding service, indistinguishable
        # from the faucet being broken.
        raise HTTPException(400, f"bad_address: {exc}") from exc

    if integrator_key not in INTEGRATORS:
        raise HTTPException(403, "integrator_not_allowed")

    rpc = _rpc(chainId)
    try:
        balance = rpc.balance(wallet)
        target = drip_target_wei(rpc.base_fee(), LIMITS)
        funder_balance = rpc.balance(_ACCOUNT.address) if _ACCOUNT else 0
    except ChainError as exc:
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc

    nullifier = STORE.nullifier_for(wallet)
    usage = STORE.usage(wallet=wallet, nullifier=nullifier)
    decision = decide(
        balance=balance,
        target=target,
        wallet_drips_today=usage.wallet_drips,
        wallet_wei_today=usage.wallet_wei,
        nullifier_wei_today=usage.nullifier_wei,
        global_wei_today=usage.global_wei,
        funder_balance=funder_balance,
        limits=LIMITS,
    )
    return {
        "balanceWei": str(balance),
        "targetWei": str(target),
        "floorWei": str(floor_wei(target)),
        "wouldFund": decision.fund,
        "reason": decision.reason,
        "dripsToday": usage.wallet_drips,
        "weiToday": str(usage.wallet_wei),
    }
