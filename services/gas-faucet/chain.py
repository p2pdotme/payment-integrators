"""Just enough JSON-RPC for what the faucet does on chain.

Deliberately not web3.py — a thin client keeps the dependency surface of a
key-holding service small. It reads balances and the base fee, reads the
integrator's boolean getters (verified, blocked, paused), simulates a submit
via eth_call, sends a plain ETH transfer (the drip), and signs one contract
call (the sponsored submit).
"""

from __future__ import annotations

import os

import httpx
from eth_account import Account
from eth_utils import keccak, to_checksum_address

#: `verified(address)` / `blocked(address)` on the integrator.
SEL_VERIFIED = "0x" + keccak(text="verified(address)")[:4].hex()
SEL_BLOCKED = "0x" + keccak(text="blocked(address)")[:4].hex()
#: `submitPassportAttestation(address,bytes32,uint256,uint256,bytes)` — the
#: ONE state-changing contract call this service's key is allowed to sign.
SEL_SUBMIT_ATTESTATION = "0x" + keccak(
    text="submitPassportAttestation(address,bytes32,uint256,uint256,bytes)"
)[:4].hex()
#: `paused()` — funding a wallet while the integrator is paused spends a drip
#: on a purchase that cannot currently happen.
SEL_PAUSED = "0x" + keccak(text="paused()")[:4].hex()

#: Ceilings on what one drip's TRANSACTION may cost, as opposed to what it
#: sends. Every cap in policy.py meters `amount_wei` only, so without these the
#: fee is an unmetered spend chosen partly by the recipient's own code.
#: 250k covers a smart-account receive path with room; 5 gwei is a thousand
#: times Base's usual base fee.
MAX_TRANSFER_GAS = int(os.environ.get("FAUCET_MAX_TRANSFER_GAS", 250_000))
#: The submit call is not a transfer — it verifies a signature and writes
#: storage — so it gets its OWN bounds, not the transfer knob (whose old
#: min() clamp could ship a submit under estimate if an operator tuned it down
#: for drips). Both a floor and a ceiling: the floor covers a bogus-low
#: estimate that would out-of-gas a real submit, and the ceiling stops a
#: hostile or broken RPC sizing the transaction unbounded — the submit path
#: has no funder-balance check, so an inflated estimate would fail the send on
#: gas funds rather than refuse cleanly. A real submit costs ~100k, so the
#: window comfortably contains it, and `submit_fee_ceiling_wei` provisions the
#: top of that window against the funder before a submit is signed.
SUBMIT_GAS_FLOOR = int(os.environ.get("FAUCET_SUBMIT_GAS_FLOOR", 120_000))
SUBMIT_GAS_CEILING = int(os.environ.get("FAUCET_SUBMIT_GAS_CEILING", 400_000))
MAX_FEE_PER_GAS_WEI = int(os.environ.get("FAUCET_MAX_FEE_PER_GAS_WEI", 5_000_000_000))

#: Tip fallback when eth_maxPriorityFeePerGas is unavailable. Named so the fee
#: ceiling below and send_value cannot drift apart.
DEFAULT_TIP_WEI = 1_000_000  # 0.001 gwei — plenty on an L2


def fee_ceiling_wei(base_fee: int) -> int:
    """The most one drip's TRANSACTION can cost, given the current base fee.

    Used by the funder-balance check: the caps meter what a drip SENDS, so the
    fee has to be provisioned here or the funder can be drained below what the
    ledger says it should hold.
    """
    return MAX_TRANSFER_GAS * min(base_fee * 2 + DEFAULT_TIP_WEI, MAX_FEE_PER_GAS_WEI)


def max_transfer_fee_wei() -> int:
    """The most a drip's transaction can EVER cost, independent of base fee.

    `gas * maxFeePerGas` of the signed transaction is bounded by the two
    clamps above, so a receipt reporting more than this did not describe a
    transaction this service signed. The ledger books fees from the receipt;
    without this bound a hostile or broken RPC could book one absurd fee and
    trip the global breaker (or overflow SQLite's 64-bit sum) — a denial of
    service on the faucet from the read side.
    """
    return MAX_TRANSFER_GAS * MAX_FEE_PER_GAS_WEI


def max_submit_fee_wei() -> int:
    """The most a sponsored submit can EVER cost. See `max_transfer_fee_wei`."""
    return SUBMIT_GAS_CEILING * MAX_FEE_PER_GAS_WEI


def submit_fee_ceiling_wei(base_fee: int) -> int:
    """The most one sponsored SUBMIT can cost, given the current base fee.

    A submit spends the float exactly as a drip does, only entirely on gas, so
    it owes the same provisioning: check the funder can cover the worst case
    before signing, rather than discovering it when the send fails for want of
    gas funds. Uses the submit's own ceiling, so tuning the transfer knob for
    drips cannot silently change what a submit reserves.
    """
    return SUBMIT_GAS_CEILING * min(base_fee * 2 + DEFAULT_TIP_WEI, MAX_FEE_PER_GAS_WEI)


class ChainError(Exception):
    """A chain interaction failed.

    `transport=True` distinguishes "could not reach/parse the node" (an
    availability fault → 502) from "the node executed and reverted" (which may
    carry a decodable reason → 400). Without the flag the sponsor path fed a
    total RPC outage into revert-reason decoding, found no selector, and
    reported it as `simulation_reverted` — a user error — which is the exact
    "attestor mismatch looks like an outage" failure this redesign set out to
    remove, wearing the opposite mask.
    """

    def __init__(self, message: str, *, transport: bool = False) -> None:
        super().__init__(message)
        self.transport = transport


class Rpc:
    def __init__(self, url: str, *, timeout: float = 15.0) -> None:
        self.url = url
        self._client = httpx.Client(timeout=timeout)
        #: Highest nonce this process has broadcast, plus one, per sender.
        #: See `_nonce`.
        self._next_nonce: dict[str, int] = {}

    def _scrub(self, text: object) -> str:
        """Remove the RPC URL from an error message.

        The URL is a credential: a keyed provider endpoint carries its API key
        in the path, and httpx quotes the full URL in most of its errors
        ("... for url 'https://.../v2/<key>'"). Every ChainError is built
        here, so this is the one place that keeps the key out of the 502
        bodies and the logs downstream.
        """
        out = str(text)
        if self.url:
            out = out.replace(self.url, "<rpc>")
        return out

    @staticmethod
    def _hex_int(value: object, what: str) -> int:
        """Parse a JSON-RPC quantity, or fail as an availability fault.

        A node that answers with `null` or a non-hex string for a balance or
        a nonce used to raise ValueError past every `except ChainError`,
        which surfaced as a 500 from a key-holding service. It is the node
        misbehaving, so it is a transport fault: 502, refuse, retry later.
        """
        try:
            return int(str(value), 16)
        except (TypeError, ValueError) as exc:
            raise ChainError(f"rpc returned a non-hex {what}", transport=True) from exc

    def call(self, method: str, params: list) -> object:
        try:
            res = self._client.post(
                self.url,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            )
            res.raise_for_status()
            body = res.json()
        except httpx.HTTPError as exc:
            raise ChainError(f"rpc unreachable: {self._scrub(exc)}", transport=True) from exc
        except ValueError as exc:
            # A 200 carrying a non-JSON body: an HTML error page from a proxy,
            # a truncated response. The node did not execute anything, so this
            # is an outage, never a revert to decode.
            raise ChainError("rpc returned a non-JSON body", transport=True) from exc
        if not isinstance(body, dict):
            raise ChainError("rpc returned a non-object body", transport=True)

        if "error" in body:
            # Carry the error's DATA, not just its message. Base's canonical
            # nodes (op-geth lineage) report a custom-error revert as
            # message="execution reverted" with the 4-byte selector ONLY in
            # the data field — so a ChainError built from the message alone
            # made every revert reason undecodable downstream: the sponsor
            # endpoint's friendly reasons (nullifier_already_spent,
            # invalid_signature, …) could never fire, and an attestor
            # mismatch was indistinguishable from any user error. The alarm
            # that cannot fire, once more.
            err = body["error"]
            detail = str(err.get("message", err)) if isinstance(err, dict) else str(err)
            data = err.get("data") if isinstance(err, dict) else None
            if data:
                detail = f"{detail} data={data}"
            raise ChainError(f"{method}: {self._scrub(detail)}")
        return body.get("result")

    # ── reads ────────────────────────────────────────────────────────────

    def balance(self, address: str) -> int:
        return self._hex_int(self.call("eth_getBalance", [address, "latest"]), "balance")

    def base_fee(self) -> int:
        """Latest block's base fee, or the legacy gas price if there is none."""
        block = self.call("eth_getBlockByNumber", ["latest", False])
        if isinstance(block, dict) and block.get("baseFeePerGas"):
            return self._hex_int(block["baseFeePerGas"], "base fee")
        return self._hex_int(self.call("eth_gasPrice", []), "gas price")

    def read_bool(self, contract: str, selector: str, address_arg: str) -> bool:
        """`eth_call` a `f(address) -> bool` getter.

        Hand-encoded rather than pulled through an ABI: one argument, one word,
        and it keeps the whole ABI machinery out of a service that holds a key.
        """
        arg = to_checksum_address(address_arg)[2:].lower().rjust(64, "0")
        result = self.call(
            "eth_call", [{"to": contract, "data": selector + arg}, "latest"]
        )
        raw = str(result or "0x")
        if raw in ("0x", ""):
            # No code at the address, or a getter that isn't there. Raised
            # rather than defaulted: callers turn this into a 502 and refuse
            # service, never guess in either direction. (An earlier comment
            # here claimed callers treated it as "not verified" — stale since
            # the denylist was made fail-closed.)
            raise ChainError("empty eth_call result")
        return self._hex_int(raw, "eth_call result") != 0

    def read_flag(self, contract: str, selector: str) -> bool:
        """`eth_call` a no-argument `f() -> bool` getter."""
        result = self.call("eth_call", [{"to": contract, "data": selector}, "latest"])
        raw = str(result or "0x")
        if raw in ("0x", ""):
            raise ChainError("empty eth_call result")
        return self._hex_int(raw, "eth_call result") != 0

    def simulate(self, *, sender: str, to: str, data: str) -> None:
        """eth_call the exact transaction before paying to send it.

        The chain is the verifier now — this service no longer re-implements
        the contract's EIP-712 check. A submission that would revert is
        refused here for the price of a read, so spam costs the caller a rate
        slot and costs this service no gas.
        """
        self.call("eth_call", [{"from": sender, "to": to, "data": data}, "latest"])

    # ── writes ───────────────────────────────────────────────────────────

    def _nonce(self, address: str) -> int:
        """The next nonce for `address`: the node's pending count, or one past
        the last transaction THIS process broadcast, whichever is higher.

        The pending read alone is not enough. Both spend paths release the
        send lock before waiting for the receipt, so a second send can follow
        the first within a second — and a load-balanced or lagging RPC may
        not yet show the first in its pending count. The second then reuses
        the nonce, and the first drip is replaced or the send is refused as
        underpriced: money booked, nothing delivered. Remembering what was
        broadcast closes that gap; still reading the node means a restart, or
        an operator sending from the key by hand, re-syncs on the next send
        rather than stranding it.
        """
        pending = self._hex_int(
            self.call("eth_getTransactionCount", [address, "pending"]), "nonce"
        )
        return max(pending, self._next_nonce.get(address.lower(), 0))

    def _broadcast(self, account, tx: dict) -> str:
        signed = account.sign_transaction(tx)
        try:
            tx_hash = str(
                self.call("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
            )
        except ChainError as exc:
            # A nonce-shaped refusal means the local view is wrong (a dropped
            # transaction, a reorg, an out-of-band send). Forget it so the next
            # send trusts the node again instead of walking further ahead.
            if any(w in str(exc).lower() for w in ("nonce", "underpriced", "already known")):
                self._next_nonce.pop(account.address.lower(), None)
            raise
        self._next_nonce[account.address.lower()] = int(tx["nonce"]) + 1
        return tx_hash

    def send_call(
        self, *, account, to: str, data: str, chain_id: int, base_fee: int
    ) -> str:
        """Sign and broadcast ONE kind of contract call from the faucet key.

        This widens the key's power — it used to sign only bare transfers, and
        "the key cannot sign a contract call" was a verified property. The
        widening is bounded at this choke point instead: callers may only
        reach allowlisted integrators, and this function refuses any calldata
        that is not a submitPassportAttestation, carries no value, and clamps
        gas like every other send. Worst case for a compromised key is
        unchanged: the float, plus submitting valid attestations that the
        contract would accept from anyone anyway.
        """
        if not data.lower().startswith(SEL_SUBMIT_ATTESTATION):
            raise ChainError("send_call only signs submitPassportAttestation")
        nonce = self._nonce(account.address)
        try:
            tip = self._hex_int(self.call("eth_maxPriorityFeePerGas", []), "tip")
        except ChainError:
            tip = DEFAULT_TIP_WEI
        try:
            estimate = self.call(
                "eth_estimateGas",
                [{"from": account.address, "to": to_checksum_address(to), "data": data}],
            )
            # Padded estimate, clamped into [floor, ceiling]: never under a
            # real submit's cost, never sized unbounded by a bad estimate.
            padded = int(self._hex_int(estimate, "gas estimate") * 1.5)
            gas = min(max(padded, SUBMIT_GAS_FLOOR), SUBMIT_GAS_CEILING)
        except ChainError as exc:
            raise ChainError(f"could not size gas for submit: {exc}") from exc
        tx = {
            "type": 2,
            "chainId": chain_id,
            "nonce": nonce,
            "to": to_checksum_address(to),
            "value": 0,
            "data": data,
            "gas": gas,
            "maxFeePerGas": min(base_fee * 2 + tip, MAX_FEE_PER_GAS_WEI),
            "maxPriorityFeePerGas": tip,
        }
        return self._broadcast(account, tx)

    def send_value(
        self, *, account, to: str, amount_wei: int, chain_id: int, base_fee: int
    ) -> str:
        """Sign and broadcast a bare ETH transfer from the faucet key.

        Nonce comes from `_nonce`: the node's pending count or the last one
        this process broadcast, whichever is higher, so back-to-back drips
        queue rather than replacing each other even when the node's pending
        view lags the previous send.
        """
        nonce = self._nonce(account.address)
        try:
            tip = self._hex_int(self.call("eth_maxPriorityFeePerGas", []), "tip")
        except ChainError:
            tip = DEFAULT_TIP_WEI

        # 21,000 is the exact intrinsic cost of a transfer to an EOA and leaves
        # nothing for a recipient that runs code — a deployed smart account, or
        # an EIP-7702-delegated EOA, would run out of gas and the transfer
        # would revert. Those are exactly the wallets an on-ramp meets, so pay
        # for a real estimate when the recipient has code.
        gas = 21_000
        try:
            has_code = self.call("eth_getCode", [to_checksum_address(to), "latest"]) not in (
                "0x",
                "",
                None,
            )
            if has_code:
                estimate = self.call(
                    "eth_estimateGas",
                    [
                        {
                            "from": account.address,
                            "to": to_checksum_address(to),
                            "value": hex(amount_wei),
                        }
                    ],
                )
                # Ceiling, because the recipient chooses this. `receive()` is
                # code the recipient controls, the fee comes out of the funder,
                # and no cap in policy.py counts fees at all — so an unbounded
                # estimate is a spend nobody is metering.
                gas = min(max(gas, int(self._hex_int(estimate, "gas estimate") * 1.5)), MAX_TRANSFER_GAS)
        except ChainError as exc:
            # Refuse rather than send a transfer that is known to revert.
            #
            # This used to swallow the error and fall back to 21,000 — the
            # exact intrinsic cost of a transfer to an EOA, with nothing left
            # for a contract wallet's receive path. The send then reverted, the
            # fee was spent, the drip was booked anyway, and four retries locked
            # the user out until midnight UTC holding a zero balance.
            raise ChainError(f"could not size gas for {to}: {exc}") from exc

        tx = {
            "type": 2,
            "chainId": chain_id,
            "nonce": nonce,
            "to": to_checksum_address(to),
            "value": amount_wei,
            "gas": gas,
            # Room for the base fee to double while the transfer is in flight;
            # unused headroom is refunded, an underpriced drip just sits there.
            # Clamped for the same reason as `gas`: the product of an
            # unbounded fee and an unbounded limit is the real spend, and the
            # caps only ever count `amount_wei`.
            "maxFeePerGas": min(base_fee * 2 + tip, MAX_FEE_PER_GAS_WEI),
            "maxPriorityFeePerGas": tip,
        }
        return self._broadcast(account, tx)


def account_from_key(private_key: str):
    return Account.from_key(private_key)
