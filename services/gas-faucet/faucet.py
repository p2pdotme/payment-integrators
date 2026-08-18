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

  * `verified(wallet)` true on the integrator — the only drip gate. Since the
    sponsored-submit contract change, verification itself is landed by THIS
    service (POST /v1/attestation): the contract accepts a submission from
    anyone because the service-signed message binds the wallet, so this
    process simulates the exact call, pays to send it, and lets the CHAIN be
    the only verifier. No off-chain EIP-712 re-implementation, no attestor
    config to disagree with the deployment.

On top of that, ceilings per UTC day: per wallet and one global circuit
breaker. The contract enforces one-wallet-per-human (the nullifier is globally
single-use), so the per-wallet cap IS the per-identity cap; the separate
per-nullifier knob survives as defence in depth on submit rows but no longer
carries the argument. Worst case for a determined, genuinely-KYC'd attacker is
their own per-wallet cap — cents.

── Not in the funds path ────────────────────────────────────────────────────

The faucet sends native gas to the user's own address and nothing else. It
holds no USDC, has no relationship to settlement, and cannot influence where
an order pays out. If it is down, verification and purchase still work for
anyone holding gas already — so callers must treat a failure here as a
degraded convenience, never as a blocked ramp.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass

from eth_utils import to_checksum_address
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from chain import (
    SEL_BLOCKED,
    SEL_PAUSED,
    SEL_SUBMIT_ATTESTATION,
    SEL_VERIFIED,
    ChainError,
    Rpc,
    account_from_key,
    fee_ceiling_wei,
)
from policy import Decision, Limits, decide, drip_target_wei, floor_wei
from store import Store

GWEI = 10**9

logging.basicConfig(
    level=os.environ.get("FAUCET_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("faucet")


def _event(event: str, **fields: object) -> str:
    """One key=value line per decision, greppable and cheap to read.

    There was no logging at all, and the failures here are specifically the
    kind you cannot tell apart without it: the client fails open by contract,
    so a refused sponsor, a dead RPC and an empty float all look, from the
    outside, like nothing happening. Every decision logs one line naming its
    reason.

    NEVER log a signature, a private key, or a full attestation. The nullifier
    is a per-(tenant, human) pseudonym and is logged truncated: enough to
    correlate one person's requests during an incident, not enough to be a
    bearer token if the logs leak.
    """
    parts = [f"event={event}"]
    for k, v in fields.items():
        if v is None:
            continue
        parts.append(f"{k}={v}")
    return " ".join(parts)


def _short(value: str | None, keep: int = 10) -> str | None:
    """Truncate an address or nullifier for logging."""
    if not value:
        return None
    return value if len(value) <= keep else value[:keep] + "…"


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class Integrator:
    """One fundable deployment.

    No attestor field any more, and that is the point of the sponsored-submit
    contract change: this service used to re-implement the contract's EIP-712
    check and therefore had to know (and keep reconciled) the signer — a
    misconfiguration that rejected every cold start while looking like an
    outage, twice. Now the CHAIN verifies every attestation, via simulation
    before paying and revert after, and there is no signer config to get
    wrong.
    """

    chain_id: int
    address: str
    label: str


def _load_integrators() -> dict[tuple[int, str], Integrator]:
    """FAUCET_INTEGRATORS, a JSON array of {chainId, address, label}."""
    raw = os.environ.get("FAUCET_INTEGRATORS", "[]")
    out: dict[tuple[int, str], Integrator] = {}
    for entry in json.loads(raw):
        integrator = Integrator(
            chain_id=int(entry["chainId"]),
            address=to_checksum_address(entry["address"]),
            # An `attestor` key in old configs is deliberately ignored.
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
    # Two journeys, not four. The first drip must cover the whole first journey
    # plus retry headroom — but the client re-asks the faucet before EVERY
    # order, so a smaller drip just means more automatic top-ups, invisible to
    # the user. Four journeys' worth was provisioning for orders that refill
    # themselves anyway, at double the price on every cap and half the float's
    # lifetime. (Review finding: the size was asserted, never argued.)
    safety_factor=_int_env("FAUCET_SAFETY_FACTOR", 2),
    # Floors and ceilings in wei. At Base's usual 0.005 gwei the target lands
    # near 1.5e13 (~$0.03, ~2 journeys); the floor is the fee-spike safety net
    # and the ceiling stops a spike scaling the drip freely.
    min_target=_int_env("FAUCET_MIN_TARGET_WEI", 10_000_000_000_000),
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

# ── on-chain reconciliation ──────────────────────────────────────────────────
_PAUSED_TTL_S = 60
_PAUSED_CACHE: dict[tuple[int, str], tuple[bool, float]] = {}


def _integrator_paused(integrator: Integrator, rpc: Rpc) -> bool:
    """Is the integrator refusing new placements right now?

    Funding a wallet during a pause spends a drip on a purchase that cannot
    currently happen. Unreadable is treated as NOT paused: the checks that
    guard money (blocked, verified, the caps) already fail closed, and pausing
    the faucet on a flaky read would add an availability failure to an
    economy check.
    """
    key = (integrator.chain_id, integrator.address.lower())
    hit = _PAUSED_CACHE.get(key)
    now = time.time()
    if hit and now - hit[1] < _PAUSED_TTL_S:
        return hit[0]
    try:
        paused = rpc.read_flag(integrator.address, SEL_PAUSED)
    except ChainError:
        # Unreadable is treated as not-paused (the money checks already fail
        # closed) — but CACHE that verdict. A contract without paused() raises
        # a permanent "empty result", so without caching every drip would pay
        # for one dead eth_call inside the send lock, forever, and the check
        # would never once answer.
        _PAUSED_CACHE[key] = (False, now)
        return False
    _PAUSED_CACHE[key] = (paused, now)
    return paused


# ── rate limiting ────────────────────────────────────────────────────────────
# In-process sliding windows. This is honest throttling, not security — an
# attacker with many IPs walks around it, and real edge limiting belongs in
# front of the service. What it stops is the cheap version: one caller turning
# a public endpoint into an RPC-cost amplifier, and a buggy client hammering
# the chain reads. Generous enough that no legitimate client ever sees it.
RATE_IP_PER_MIN = _int_env("FAUCET_RATE_IP_PER_MIN", 60)
RATE_WALLET_PER_MIN = _int_env("FAUCET_RATE_WALLET_PER_MIN", 12)
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, deque] = {}


#: Hard cap on distinct rate buckets. A flood of fresh keys (the X-Forwarded-
#: -For header rotates freely — this is throttling, not a security control)
#: cannot grow the map without bound, and cannot make eviction an O(n) scan
#: run inside the lock on every request: the old "evict only 60s-idle buckets"
#: selected nothing during exactly such a flood while the scan ran anyway.
_RATE_MAX_BUCKETS = int(os.environ.get("FAUCET_RATE_MAX_BUCKETS", 20_000))


def _over_limit(key: str, limit: int) -> bool:
    now = time.time()
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS.setdefault(key, deque())
        while bucket and bucket[0] <= now - 60:
            bucket.popleft()
        if len(bucket) >= limit:
            return True
        bucket.append(now)
        # O(1) amortised: when full, drop THIS key's own now-stale neighbours
        # is not enough under a fresh-key flood, so evict in insertion order
        # (dicts preserve it) until back under the cap. Bounded work per call.
        while len(_RATE_BUCKETS) > _RATE_MAX_BUCKETS:
            oldest_key = next(iter(_RATE_BUCKETS))
            if oldest_key == key:  # never evict the bucket we just touched
                break
            del _RATE_BUCKETS[oldest_key]
    return False


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── float alerting ───────────────────────────────────────────────────────────
#: Warn when the funder holds fewer than this many targets. The empty state
#: used to be a 200 the client swallows — heal-able (send ETH) but detected by
#: nobody. `event=low_balance` is the line to alert on.
LOW_BALANCE_DRIPS = _int_env("FAUCET_LOW_BALANCE_DRIPS", 100)
_LOW_BALANCE_LOG_INTERVAL_S = 3600
_last_low_balance_log = 0.0
_RPCS: dict[int, Rpc] = {}


def _rpc(chain_id: int) -> Rpc:
    if chain_id not in _RPCS:
        url = RPC_URLS.get(chain_id)
        if not url:
            raise HTTPException(400, f"no RPC configured for chain {chain_id}")
        _RPCS[chain_id] = Rpc(url)
    return _RPCS[chain_id]


def _announce() -> None:
    """What this process actually resolved its config to.

    Most failures here are wiring, not logic — a DB path that is not
    persistent, a missing key, a wrong integrator address — and none of them
    is visible from a request. Printing the resolved config once turns a
    confusing "every request is a 403" into an obvious one, and gives an
    incident a fixed point to compare against.

    Addresses only. No key, no token.
    """
    log.info(
        _event(
            "startup",
            funder=_ACCOUNT.address if _ACCOUNT else "NONE",
            integrators=len(INTEGRATORS),
            chains=",".join(str(c) for c in sorted(RPC_URLS)) or "none",
            db=_DB_PATH,
            docs="on" if _DOCS else "off",
            ops_endpoint="on" if os.environ.get("FAUCET_OPS_TOKEN") else "off",
        )
    )
    for i in INTEGRATORS.values():
        log.info(
            _event("integrator", label=i.label, chain=i.chain_id, address=i.address)
        )
    if not _ACCOUNT:
        log.error(_event("misconfigured", detail="FAUCET_PRIVATE_KEY unset; every request 503s"))


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _announce()
    yield


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
    lifespan=_lifespan,
)
if ALLOWED_ORIGINS or ALLOWED_ORIGIN_REGEX:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=ALLOWED_ORIGIN_REGEX or None,
        allow_methods=["POST", "GET", "OPTIONS"],
        allow_headers=["*"],
    )


class SubmitRequest(BaseModel):
    """POST /v1/attestation — sponsor a verification on-chain.

    The service pays the gas to land `submitPassportAttestation(wallet, …)`.
    It does NOT verify the signature: the contract does, first in simulation
    (free, before any gas is spent) and then for real. There is nothing here
    an attacker can abuse that the chain would accept — a bad signature, a
    spent nullifier, an expired attestation all die in simulation for the
    price of a rate-limit slot.
    """

    chainId: int
    integrator: str
    wallet: str
    nullifier: str
    limit: int
    expiry: int
    signature: str


class SubmitResponse(BaseModel):
    submitted: bool
    reason: str
    txHash: str | None = None
    pending: bool = False


class GasRequest(BaseModel):
    chainId: int
    integrator: str
    wallet: str


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
    # Compare bytes, not str: secrets.compare_digest raises TypeError on a
    # non-ASCII str, and that 500 (vs the 404 a wrong ASCII token gets)
    # confirms FAUCET_OPS_TOKEN is set — an oracle defeating the endpoint's
    # "unavailable rather than public" intent.
    if not expected or not secrets.compare_digest(
        token.encode("utf-8", "ignore"), expected.encode("utf-8", "ignore")
    ):
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


def _authorise(integrator: Integrator, rpc: Rpc, wallet: str) -> None:
    """Establish that `wallet` may be funded. Raises 403/502 otherwise.

    One gate: `verified(wallet)` on the integrator. The contract enforces
    one-wallet-per-human via the globally single-use nullifier, so a verified
    wallet IS an identity, and the off-chain re-verification this function
    used to do — EIP-712 checks, attestor reconciliation, spent-nullifier
    reads — is gone with the cold-start path that needed it. A wallet that is
    not yet verified gets verified through POST /v1/attestation, where the
    CHAIN does all of the checking.
    """
    # Denylisted wallets get nothing. This is the operator's only revocation
    # lever, so it fails CLOSED: any RPC fault refuses rather than funds.
    try:
        is_blocked = rpc.read_bool(integrator.address, SEL_BLOCKED, wallet)
    except ChainError as exc:
        log.error(_event("chain_unreachable", detail=str(exc)))
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc
    if is_blocked:
        log.warning(
            _event("refused", reason="wallet_blocked", wallet=_short(wallet),
                   integrator=integrator.label)
        )
        raise HTTPException(403, "wallet_blocked")

    try:
        if rpc.read_bool(integrator.address, SEL_VERIFIED, wallet):
            return
    except ChainError as exc:
        log.error(_event("chain_unreachable", detail=str(exc)))
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc

    log.info(
        _event("refused", reason="not_verified", wallet=_short(wallet),
               integrator=integrator.label)
    )
    raise HTTPException(403, "not_verified")


# Custom-error selectors from OwnCheckoutIntegrator, so a simulation revert
# maps to a reason a client can show. keccak(text=...)[:4].
from eth_utils import keccak as _keccak  # noqa: E402  (grouped with its use)

_SUBMIT_ERRORS = {
    "0x" + _keccak(text=err + "()")[:4].hex(): name
    for err, name in [
        ("NullifierAlreadySpent", "nullifier_already_spent"),
        ("AttestationExpired", "attestation_expired"),
        ("InvalidSignature", "invalid_signature"),
        ("AttestorNotSet", "attestor_not_set"),
        ("InvalidAddress", "invalid_wallet"),
        ("ContractPaused", "contract_paused"),
    ]
}


def _submit_reason(detail: str) -> str:
    """Map a revert's error selector, if present in the RPC message, to a name."""
    lowered = detail.lower()
    for selector, name in _SUBMIT_ERRORS.items():
        if selector[2:] in lowered:
            return name
    return "simulation_reverted"


def _encode_submit(wallet: str, nullifier: str, limit: int, expiry: int, signature: str) -> str:
    """ABI-encode submitPassportAttestation(address,bytes32,uint256,uint256,bytes).

    Hand-rolled like every other encoding here — one dynamic argument, a
    fixed layout, and no ABI machinery inside a key-holding service. Layout:
    4 words of static args, a word pointing at the bytes tail (0xa0), then
    the tail: length word + the 65 signature bytes padded to 96.
    """
    wal = to_checksum_address(wallet)[2:].lower().rjust(64, "0")
    nul = (nullifier[2:] if nullifier.lower().startswith("0x") else nullifier).lower()
    if len(nul) != 64:
        raise HTTPException(400, "bad_nullifier: must be 32 bytes")
    try:
        bytes.fromhex(nul)
    except ValueError as exc:
        raise HTTPException(400, f"bad_nullifier: {exc}") from exc
    if not (0 <= limit < 2**256) or not (0 <= expiry < 2**256):
        # format(x, "064x") pads but does NOT truncate: a value >= 2^256
        # yields >64 hex chars and nibble-shifts every field after it.
        raise HTTPException(400, "bad_attestation: field out of uint256 range")
    sig = (signature[2:] if signature.lower().startswith("0x") else signature).lower()
    try:
        sig_bytes = bytes.fromhex(sig)
    except ValueError as exc:
        raise HTTPException(400, f"bad_signature: {exc}") from exc
    if len(sig_bytes) != 65:
        raise HTTPException(400, "bad_signature: must be 65 bytes")

    head = (
        wal
        + nul
        + format(limit, "064x")
        + format(expiry, "064x")
        + format(0xA0, "064x")
    )
    tail = format(len(sig_bytes), "064x") + sig_bytes.hex().ljust(96 * 2, "0")
    return SEL_SUBMIT_ATTESTATION + head + tail


@app.post("/v1/attestation", response_model=SubmitResponse)
def submit_attestation(req: SubmitRequest, request: Request) -> SubmitResponse:
    """Land a verification on-chain, with the service paying the gas.

    This endpoint is why the cold-start drip no longer exists: the contract
    accepts a submission from anyone, so the one transaction a gasless wallet
    could never afford is simply sent for them. The chain is the only
    verifier — the exact call is simulated first, so nothing invalid ever
    costs this service more than the eth_call, and the same rate limits that
    guard the drip guard this.
    """
    if _ACCOUNT is None:
        raise HTTPException(503, "faucet_not_configured")

    ip = _client_ip(request)
    if _over_limit(f"ip:{ip}", RATE_IP_PER_MIN):
        log.info(_event("rate_limited", scope="ip", ip=ip))
        raise HTTPException(429, "rate_limited")

    try:
        wallet = to_checksum_address(req.wallet)
        integrator_addr = to_checksum_address(req.integrator)
    except Exception as exc:
        raise HTTPException(400, f"bad_address: {exc}") from exc

    if _over_limit(f"wallet:{wallet.lower()}", RATE_WALLET_PER_MIN):
        log.info(_event("rate_limited", scope="wallet", wallet=_short(wallet)))
        raise HTTPException(429, "rate_limited")

    integrator = INTEGRATORS.get((req.chainId, integrator_addr.lower()))
    if integrator is None:
        log.warning(
            _event("refused", reason="integrator_not_allowed",
                   integrator=_short(integrator_addr), chain=req.chainId)
        )
        raise HTTPException(403, "integrator_not_allowed")

    rpc = _rpc(integrator.chain_id)

    # Same economy check the drip applies: sponsoring an enrolment while the
    # operator has said "stop" spends gas against their decision. The contract
    # now enforces this too (submit is pause-gated), so this is belt over a
    # real brace rather than over nothing.
    if _integrator_paused(integrator, rpc):
        log.info(
            _event("refused", reason="integrator_paused", wallet=_short(wallet),
                   integrator=integrator.label)
        )
        raise HTTPException(409, "integrator_paused")

    data = _encode_submit(wallet, req.nullifier, req.limit, req.expiry, req.signature)

    # The chain's answer, for free, before any gas is spent. Everything the
    # old off-chain verifier checked — signature, signer, expiry, nullifier
    # reuse, the wallet binding — reverts here if wrong.
    try:
        rpc.simulate(sender=_ACCOUNT.address, to=integrator.address, data=data)
    except ChainError as exc:
        # An RPC that could not be reached is an OUTAGE (502), not a rejected
        # attestation (400). Feeding a transport failure into revert decoding
        # made a total outage read as `simulation_reverted` — a user error —
        # indistinguishable from every bad signature.
        if getattr(exc, "transport", False):
            log.error(_event("chain_unreachable", detail=str(exc)))
            raise HTTPException(502, f"chain_unreachable: {exc}") from exc
        reason = _submit_reason(str(exc))
        log.info(
            _event("refused", reason=reason, wallet=_short(wallet),
                   nullifier=_short(req.nullifier), integrator=integrator.label,
                   detail=str(exc)[:200])
        )
        raise HTTPException(400, reason) from exc

    with _SEND_LOCK:
        try:
            base_fee = rpc.base_fee()
        except ChainError as exc:
            log.error(_event("chain_unreachable", detail=str(exc)))
            raise HTTPException(502, f"chain_unreachable: {exc}") from exc

        # Reserve first here too: the sponsored row's FEE feeds the same
        # global breaker, so a write failure must refuse before spending gas,
        # not book blind afterward. amount 0 — nothing is transferred; the fee
        # lands after the receipt. The nullifier makes this the enrolment row
        # the drip path recalls the identity from.
        try:
            drip_id = STORE.reserve(
                chain_id=integrator.chain_id,
                wallet=wallet,
                nullifier=req.nullifier.lower(),
                amount_wei=0,
            )
        except Exception as exc:
            log.error(_event("ledger_unavailable", wallet=_short(wallet), detail=str(exc)))
            raise HTTPException(503, "ledger_unavailable") from exc

        log.info(
            _event("sponsoring", wallet=_short(wallet), drip_id=drip_id,
                   nullifier=_short(req.nullifier), integrator=integrator.label)
        )
        try:
            tx_hash = rpc.send_call(
                account=_ACCOUNT,
                to=integrator.address,
                data=data,
                chain_id=integrator.chain_id,
                base_fee=base_fee,
            )
        except ChainError as exc:
            try:
                STORE.release(drip_id)
            except Exception:
                pass
            log.error(
                _event("sponsor_send_failed", wallet=_short(wallet),
                       integrator=integrator.label, detail=str(exc))
            )
            raise HTTPException(502, f"send_failed: {exc}") from exc

        try:
            STORE.attach_tx(drip_id, tx_hash)
        except Exception as exc:
            log.error(
                _event("ledger_tx_link_failed", drip_id=drip_id,
                       tx=_short(tx_hash, 12), detail=str(exc))
            )

    outcome, fee_wei = _await_receipt(rpc, tx_hash)
    if fee_wei:
        try:
            STORE.record_fee(drip_id, fee_wei)
        except Exception as exc:
            log.error(
                _event("ledger_fee_failed", drip_id=drip_id,
                       fee_wei=fee_wei, tx=_short(tx_hash, 12), detail=str(exc))
            )
    log.info(
        _event("sponsored" if outcome != "failed" else "sponsor_reverted",
               wallet=_short(wallet), integrator=integrator.label,
               fee_wei=fee_wei, tx=_short(tx_hash, 12), outcome=outcome)
    )
    return SubmitResponse(
        submitted=outcome != "failed",
        reason="sponsored" if outcome != "failed" else "send_reverted",
        txHash=tx_hash,
        pending=outcome == "pending",
    )


@app.post("/v1/gas/request", response_model=GasResponse)
def request_gas(req: GasRequest, request: Request) -> GasResponse:
    if _ACCOUNT is None:
        raise HTTPException(503, "faucet_not_configured")

    ip = _client_ip(request)
    if _over_limit(f"ip:{ip}", RATE_IP_PER_MIN):
        log.info(_event("rate_limited", scope="ip", ip=ip))
        raise HTTPException(429, "rate_limited")

    try:
        wallet = to_checksum_address(req.wallet)
        integrator_addr = to_checksum_address(req.integrator)
    except Exception as exc:
        raise HTTPException(400, f"bad_address: {exc}") from exc

    if _over_limit(f"wallet:{wallet.lower()}", RATE_WALLET_PER_MIN):
        log.info(_event("rate_limited", scope="wallet", wallet=_short(wallet)))
        raise HTTPException(429, "rate_limited")

    integrator = INTEGRATORS.get((req.chainId, integrator_addr.lower()))
    if integrator is None:
        # An allowlist, not a filter: an unknown integrator could point the
        # attestation check at an attestor of the caller's choosing.
        log.warning(
            _event("refused", reason="integrator_not_allowed",
                   integrator=_short(integrator_addr), chain=req.chainId)
        )
        raise HTTPException(403, "integrator_not_allowed")

    rpc = _rpc(integrator.chain_id)
    _authorise(integrator, rpc, wallet)

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
            log.error(_event("chain_unreachable", detail=str(exc)))
            raise HTTPException(502, f"chain_unreachable: {exc}") from exc

        target = drip_target_wei(base_fee, LIMITS)

        # An integrator that is paused cannot take the purchase this gas is
        # for. The drip would not be lost — gas keeps — but spending budget on
        # it now is spending during exactly the window an operator has said
        # "stop". Declined, not refused: this is an economy decision, not an
        # authorisation failure.
        if _integrator_paused(integrator, rpc):
            log.info(
                _event("declined", reason="integrator_paused", wallet=_short(wallet),
                       integrator=integrator.label)
            )
            return GasResponse(
                funded=False,
                reason="integrator_paused",
                balanceWei=str(balance),
                targetWei=str(target),
            )

        # The float alarm. The empty state is a 200 the client swallows by
        # contract, so this log line is the only thing that turns "quietly
        # refusing everyone" into a page before the wallet actually runs dry.
        global _last_low_balance_log
        if (
            funder_balance < LOW_BALANCE_DRIPS * target
            and time.time() - _last_low_balance_log > _LOW_BALANCE_LOG_INTERVAL_S
        ):
            _last_low_balance_log = time.time()
            log.warning(
                _event("low_balance", funder_balance_wei=funder_balance,
                       target_wei=target, drips_left=funder_balance // max(target, 1))
            )

        # Recalled from the sponsor row, so the per-identity budget actually
        # binds — with nullifier=None it was dead code and its env knob inert.
        nullifier = STORE.nullifier_for(wallet)
        usage = STORE.usage(wallet=wallet, nullifier=nullifier, chain_id=integrator.chain_id)
        decision: Decision = decide(
            balance=balance,
            target=target,
            wallet_drips_today=usage.wallet_drips,
            wallet_wei_today=usage.wallet_wei,
            nullifier_wei_today=usage.nullifier_wei,
            global_wei_today=usage.global_wei,
            # The caps meter what a drip SENDS; the transaction fee is real
            # spend too, so the funder check provisions the worst-case fee for
            # this drip before deciding the float can afford it.
            funder_balance=max(0, funder_balance - fee_ceiling_wei(base_fee)),
            limits=LIMITS,
        )

        if not decision.fund:
            # Not an error. `sufficient_balance` is the common case and the
            # caps are working as designed — but an operator asking "why did
            # this user get nothing" needs the reason, and the client swallows
            # the body by contract.
            log.info(
                _event("declined", reason=decision.reason, wallet=_short(wallet),
                       integrator=integrator.label,
                       balance_wei=balance, target_wei=target)
            )
            return GasResponse(
                funded=False,
                reason=decision.reason,
                balanceWei=str(balance),
                targetWei=str(target),
            )

        # Claim the cap slot BEFORE the money moves. A failure here means the
        # ledger is unavailable and NOTHING has been spent, so the request
        # refuses rather than funding blind — an uncapped faucet is worse than
        # an unavailable one. (This replaced a post-send record whose failure
        # silently disabled every cap while the wallet kept paying out.)
        try:
            drip_id = STORE.reserve(
                chain_id=integrator.chain_id,
                wallet=wallet,
                nullifier=nullifier,
                amount_wei=decision.amount,
            )
        except Exception as exc:
            log.error(_event("ledger_unavailable", wallet=_short(wallet), detail=str(exc)))
            raise HTTPException(503, "ledger_unavailable") from exc

        log.info(
            _event("funding", wallet=_short(wallet), drip_id=drip_id,
                   integrator=integrator.label, amount_wei=decision.amount,
                   balance_wei=balance, target_wei=target)
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
            # No ETH moved. Free the slot so a failed send does not spend one.
            try:
                STORE.release(drip_id)
            except Exception:
                pass  # a lingering row over-counts by one — stingy, safe
            log.error(
                _event("send_failed", wallet=_short(wallet),
                       integrator=integrator.label, amount_wei=decision.amount,
                       detail=str(exc))
            )
            raise HTTPException(502, f"send_failed: {exc}") from exc

        # Money moved and the slot is already claimed. Linking the tx is
        # best-effort: a failure costs only the hash and this row's later fee.
        try:
            STORE.attach_tx(drip_id, tx_hash)
        except Exception as exc:
            log.error(
                _event("ledger_tx_link_failed", drip_id=drip_id,
                       tx=_short(tx_hash, 12), detail=str(exc))
            )

    # Broadcast is booked; confirmation is a courtesy so the caller can send
    # its own transaction immediately instead of polling the balance.
    #
    # A reverted transfer is reported as NOT funded. The drip stays on the
    # ledger deliberately — the gas was spent and the cap should feel it — but
    # telling the caller `funded: true` when nothing moved is worse than
    # useless: it is the one signal they have, and it would be a lie.
    outcome, fee_wei = _await_receipt(rpc, tx_hash)
    if fee_wei:
        try:
            STORE.record_fee(drip_id, fee_wei)
        except Exception as exc:
            log.error(
                _event("ledger_fee_failed", drip_id=drip_id,
                       fee_wei=fee_wei, tx=_short(tx_hash, 12), detail=str(exc))
            )
    log.info(
        _event("funded" if outcome != "failed" else "send_reverted",
               wallet=_short(wallet), integrator=integrator.label,
               amount_wei=decision.amount, fee_wei=fee_wei,
               tx=_short(tx_hash, 12), outcome=outcome)
    )

    return GasResponse(
        funded=outcome != "failed",
        reason=decision.reason if outcome != "failed" else "send_reverted",
        balanceWei=str(balance),
        targetWei=str(target),
        amountWei=str(decision.amount) if outcome != "failed" else "0",
        txHash=tx_hash,
        pending=outcome == "pending",
    )


def _await_receipt(
    rpc: Rpc, tx_hash: str, *, attempts: int = 12, delay: float = 1.0
) -> tuple[str, int]:
    """Wait briefly for the drip to land.

    Returns ("success" | "failed" | "pending", actual_fee_wei).

    A receipt existing is not the same as the transfer having worked — a
    reverted or out-of-gas transaction has one too, with `status: 0x0`. This
    used to return True on any non-null receipt, so the caller reported
    `funded: true` for a transfer that moved nothing.

    The fee (gasUsed x effectiveGasPrice) is what the transaction genuinely
    cost the funder and is booked to the ledger by the caller, so the caps
    meter real spend rather than only the value sent. "pending" carries fee 0:
    a bounded, one-in-flight-wide under-count, and the clamps in chain.py
    bound how far it can be wrong.
    """
    for _ in range(attempts):
        try:
            receipt = rpc.call("eth_getTransactionReceipt", [tx_hash])
            if isinstance(receipt, dict):
                status = receipt.get("status")
                fee = 0
                try:
                    fee = int(str(receipt.get("gasUsed", "0x0")), 16) * int(
                        str(receipt.get("effectiveGasPrice", "0x0")), 16
                    )
                except (TypeError, ValueError):
                    pass  # a node that omits either field books no fee
                failed = status is not None and int(str(status), 16) == 0
                return ("failed" if failed else "success", fee)
            if receipt is not None:
                return ("success", 0)
        except ChainError:
            pass
        time.sleep(delay)
    return ("pending", 0)


@app.get("/v1/gas/status")
def status(chainId: int, integrator: str, wallet: str, request: Request) -> dict:
    """What the faucet would do for this wallet, without doing it.

    `wouldFund` runs the SAME `decide()` the funding path runs. It used to be
    `balance < floor_wei(target)`, which ignored every cap — so it answered
    true for a wallet the caps would refuse, and the incident runbook tells
    operators to trust that field.
    """
    ip = _client_ip(request)
    if _over_limit(f"ip:{ip}", RATE_IP_PER_MIN):
        raise HTTPException(429, "rate_limited")

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
        log.error(_event("chain_unreachable", detail=str(exc)))
        raise HTTPException(502, f"chain_unreachable: {exc}") from exc

    usage = STORE.usage(wallet=wallet, nullifier=STORE.nullifier_for(wallet), chain_id=chainId)
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
