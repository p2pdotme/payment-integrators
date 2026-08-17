"""Just enough JSON-RPC to read a balance and send a plain ETH transfer.

Deliberately not web3.py. The faucet does four things on chain — read a
balance, read a base fee, call one boolean getter, send value — and a thin
client keeps the dependency surface of a key-holding service small.
"""

from __future__ import annotations

import httpx
from eth_account import Account
from eth_utils import keccak, to_checksum_address

#: `verified(address)` / `blocked(address)` on the integrator.
SEL_VERIFIED = "0x" + keccak(text="verified(address)")[:4].hex()
SEL_BLOCKED = "0x" + keccak(text="blocked(address)")[:4].hex()


class ChainError(Exception):
    pass


class Rpc:
    def __init__(self, url: str, *, timeout: float = 15.0) -> None:
        self.url = url
        self._client = httpx.Client(timeout=timeout)

    def call(self, method: str, params: list) -> object:
        try:
            res = self._client.post(
                self.url,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            )
            res.raise_for_status()
            body = res.json()
        except httpx.HTTPError as exc:
            raise ChainError(f"rpc unreachable: {exc}") from exc

        if "error" in body:
            raise ChainError(f"{method}: {body['error'].get('message', body['error'])}")
        return body.get("result")

    # ── reads ────────────────────────────────────────────────────────────

    def balance(self, address: str) -> int:
        return int(str(self.call("eth_getBalance", [address, "latest"])), 16)

    def base_fee(self) -> int:
        """Latest block's base fee, or the legacy gas price if there is none."""
        block = self.call("eth_getBlockByNumber", ["latest", False])
        if isinstance(block, dict) and block.get("baseFeePerGas"):
            return int(str(block["baseFeePerGas"]), 16)
        return int(str(self.call("eth_gasPrice", [])), 16)

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
            # No code at the address, or a getter that isn't there. Treated as
            # "not verified" by callers, never as "verified".
            raise ChainError("empty eth_call result")
        return int(raw, 16) != 0

    # ── writes ───────────────────────────────────────────────────────────

    def send_value(
        self, *, account, to: str, amount_wei: int, chain_id: int, base_fee: int
    ) -> str:
        """Sign and broadcast a bare ETH transfer from the faucet key.

        Nonce is read as `pending` so back-to-back drips queue rather than
        replacing each other; callers serialise anyway, but a pending read
        makes a lost lock a delay instead of a dropped transaction.
        """
        nonce = int(
            str(self.call("eth_getTransactionCount", [account.address, "pending"])), 16
        )
        try:
            tip = int(str(self.call("eth_maxPriorityFeePerGas", [])), 16)
        except ChainError:
            tip = 1_000_000  # 0.001 gwei — plenty on an L2

        # 21,000 is the exact intrinsic cost of a transfer to an EOA and leaves
        # nothing for a recipient that runs code — a deployed smart account, or
        # an EIP-7702-delegated EOA, would run out of gas and the transfer
        # would revert. Those are exactly the wallets an on-ramp meets, so pay
        # for a real estimate when the recipient has code.
        gas = 21_000
        try:
            if self.call("eth_getCode", [to_checksum_address(to), "latest"]) not in ("0x", "", None):
                estimate = self.call(
                    "eth_estimateGas",
                    [{"from": account.address, "to": to_checksum_address(to), "value": hex(amount_wei)}],
                )
                gas = max(gas, int(int(str(estimate), 16) * 1.5))
        except ChainError:
            # Estimation is best-effort; 21,000 still covers the common case.
            pass

        tx = {
            "type": 2,
            "chainId": chain_id,
            "nonce": nonce,
            "to": to_checksum_address(to),
            "value": amount_wei,
            "gas": gas,
            # Room for the base fee to double while the transfer is in flight;
            # unused headroom is refunded, an underpriced drip just sits there.
            "maxFeePerGas": base_fee * 2 + tip,
            "maxPriorityFeePerGas": tip,
        }
        signed = account.sign_transaction(tx)
        return str(self.call("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()]))


def account_from_key(private_key: str):
    return Account.from_key(private_key)
