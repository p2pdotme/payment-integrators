"""Tests for faucet.py itself — the request path, which had none.

`_authorise`, the integrator allowlist, the 403/502 paths, the concurrency
guard and the reverted-send path were all unexercised. The module docstring
calls this service "the only thing standing between a funded hot wallet and
anyone who can call the API"; that deserves more than a policy unit test.

A fake Rpc stands in for the chain so every branch is reachable and nothing
here touches a network.
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

INTEG = "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032"
CHAIN = 84532
TARGET = 30_000_000_000_000
ATTESTOR = Account.from_key("0x" + "11" * 32)

os.environ["FAUCET_ALLOW_EPHEMERAL_DB"] = "1"
os.environ["FAUCET_PRIVATE_KEY"] = "0x" + "22" * 32
os.environ["FAUCET_INTEGRATORS"] = json.dumps(
    [{"chainId": CHAIN, "address": INTEG, "attestor": ATTESTOR.address, "label": "t"}]
)
os.environ["FAUCET_RPC_URLS"] = json.dumps({str(CHAIN): "http://127.0.0.1:1/unused"})
os.environ["FAUCET_DB_PATH"] = f"/tmp/faucet-app-{secrets.token_hex(4)}.db"

import faucet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class FakeRpc:
    """Chain state a test can steer."""

    def __init__(self):
        self.balances: dict[str, int] = {}
        self.verified: set[str] = set()
        self.blocked: set[str] = set()
        self.spent_nullifiers: set[str] = set()
        self.sent: list[tuple[str, int]] = []
        self.fail_reads = False
        self.receipt_status = "0x1"
        self.lock = threading.Lock()

    def balance(self, addr):
        if addr.lower() == faucet._ACCOUNT.address.lower():
            return 10**18
        return self.balances.get(addr.lower(), 0)

    def base_fee(self):
        return 5_000_000

    def read_bool(self, contract, selector, address_arg):
        if self.fail_reads:
            raise faucet.ChainError("rpc down")
        a = address_arg.lower()
        if selector == faucet.SEL_BLOCKED:
            return a in self.blocked
        return a in self.verified

    def read_bool32(self, contract, selector, word):
        if self.fail_reads:
            raise faucet.ChainError("rpc down")
        return word.lower() in self.spent_nullifiers

    def call(self, method, params):
        if method == "eth_getTransactionReceipt":
            return {"status": self.receipt_status}
        return "0x1"

    def send_value(self, *, account, to, amount_wei, chain_id, base_fee):
        with self.lock:
            self.balances[to.lower()] = self.balances.get(to.lower(), 0) + amount_wei
            self.sent.append((to.lower(), amount_wei))
        return "0x" + secrets.token_hex(32)


@pytest.fixture
def rpc(monkeypatch):
    r = FakeRpc()
    monkeypatch.setattr(faucet, "_rpc", lambda cid: r)
    return r


@pytest.fixture
def client():
    return TestClient(faucet.app)


def sign(wallet, *, nullifier=None, limit=100_000_000, expiry=None, signer=ATTESTOR,
         integrator=INTEG, chain_id=CHAIN):
    nullifier = nullifier or secrets.token_bytes(32)
    expiry = expiry or int(time.time()) + 3600
    signable = encode_typed_data(
        domain_data={"name": "KycVerifier", "version": "1", "chainId": chain_id,
                     "verifyingContract": integrator},
        message_types={"KycAttestation": [
            {"name": "wallet", "type": "address"},
            {"name": "nullifier", "type": "bytes32"},
            {"name": "limit", "type": "uint256"},
            {"name": "expiry", "type": "uint256"}]},
        message_data={"wallet": wallet, "nullifier": nullifier, "limit": limit,
                      "expiry": expiry},
    )
    return {"nullifier": "0x" + nullifier.hex(), "limit": limit, "expiry": expiry,
            "signature": "0x" + signer.sign_message(signable).signature.hex()}


def req(client, wallet, attestation=None):
    body = {"chainId": CHAIN, "integrator": INTEG, "wallet": wallet}
    if attestation:
        body["attestation"] = attestation
    return client.post("/v1/gas/request", json=body)


# ── who gets funded ─────────────────────────────────────────────────────────


class TestAuthorisation:
    def test_cold_start_with_a_valid_attestation(self, client, rpc):
        w = Account.create().address
        r = req(client, w, sign(w))
        assert r.status_code == 200 and r.json()["funded"] is True
        assert rpc.sent == [(w.lower(), TARGET)]

    def test_verified_wallet_needs_no_attestation(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        assert req(client, w).json()["funded"] is True

    def test_unverified_and_unattested_is_refused(self, client, rpc):
        assert req(client, Account.create().address).status_code == 403

    def test_a_signature_from_anyone_else_is_refused(self, client, rpc):
        w = Account.create().address
        impostor = Account.from_key("0x" + "33" * 32)
        assert req(client, w, sign(w, signer=impostor)).status_code == 403

    def test_an_attestation_for_another_integrator_is_refused(self, client, rpc):
        w = Account.create().address
        other = "0x9c64B3B4e0F0C4A0E8b0F1A2B3c4D5e6F7080910"
        assert req(client, w, sign(w, integrator=other)).status_code == 403

    def test_an_unknown_integrator_is_refused(self, client, rpc):
        r = client.post("/v1/gas/request", json={
            "chainId": CHAIN, "integrator": "0x000000000000000000000000000000000000dEaD",
            "wallet": Account.create().address})
        assert r.status_code == 403 and r.json()["detail"] == "integrator_not_allowed"

    def test_a_blocked_wallet_is_refused_even_with_a_good_attestation(self, client, rpc):
        w = Account.create().address
        rpc.blocked.add(w.lower())
        assert req(client, w, sign(w)).status_code == 403

    def test_an_rpc_fault_refuses_rather_than_funding(self, client, rpc):
        w = Account.create().address
        rpc.fail_reads = True
        assert req(client, w, sign(w)).status_code == 502
        assert rpc.sent == []


class TestSpentNullifier:
    """One passport verifies exactly one wallet, ever.

    Without this read the faucet funded the cold start for wallet after wallet
    on the same identity, each into a submit that reverts
    NullifierAlreadySpent — money out, user still stuck.
    """

    def test_refuses_an_attestation_already_used_on_chain(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        rpc.spent_nullifiers.add(att["nullifier"].lower())
        r = req(client, w, att)
        assert r.status_code == 403
        assert r.json()["detail"] == "nullifier_already_spent"
        assert rpc.sent == []

    def test_an_unspent_one_still_funds(self, client, rpc):
        w = Account.create().address
        assert req(client, w, sign(w)).json()["funded"] is True


class TestIdentityCapIsNotOptOut:
    """`attestation` is optional and the CALLER chooses whether to send it.

    Omitting it used to mean the drip was recorded with no nullifier, so it
    counted against no identity — a second, uncounted wallet allowance for
    anyone who simply left a field out.
    """

    def test_the_identity_is_recalled_from_the_ledger(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        req(client, w, att)  # cold start records the nullifier

        rpc.verified.add(w.lower())
        rpc.balances[w.lower()] = 0  # spent it
        req(client, w)  # no attestation this time

        rows = faucet.STORE._conn.execute(
            "SELECT nullifier FROM drips WHERE wallet = ?", (w.lower(),)
        ).fetchall()
        assert len(rows) == 2
        assert all(r[0] == att["nullifier"].lower() for r in rows), \
            "the second drip was booked against no identity"


# ── concurrency ─────────────────────────────────────────────────────────────


class TestConcurrency:
    def test_six_simultaneous_requests_fund_once(self, client, rpc):
        """The balance read must sit INSIDE the send lock.

        With it outside, six concurrent requests all saw zero, all funded, and
        the wallet took four times the target while `sufficient_balance` never
        fired — making policy.decide's shortfall arithmetic dead code and
        leaving max_drips_per_wallet as the only bound.
        """
        w = Account.create().address
        rpc.verified.add(w.lower())
        reasons: list[str] = []

        def fire():
            reasons.append(req(client, w).json().get("reason", "?"))

        threads = [threading.Thread(target=fire) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(rpc.sent) == 1, f"funded {len(rpc.sent)} times, expected 1"
        assert sum(a for _, a in rpc.sent) == TARGET
        assert reasons.count("sufficient_balance") == 5


# ── failure reporting ───────────────────────────────────────────────────────


class TestSendOutcome:
    def test_a_reverted_send_is_not_reported_as_funded(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        rpc.receipt_status = "0x0"
        body = req(client, w).json()
        assert body["funded"] is False
        assert body["reason"] == "send_reverted"


class TestMalformedInput:
    """Attacker-controlled input must not produce 5xx on a key-holding service."""

    def test_a_bad_wallet_on_the_post_path_is_a_400(self, client, rpc):
        r = client.post("/v1/gas/request", json={
            "chainId": CHAIN, "integrator": INTEG, "wallet": "not-an-address"})
        assert r.status_code == 400

    def test_a_bad_wallet_on_the_status_path_is_a_400(self, client, rpc):
        r = client.get("/v1/gas/status",
                       params={"chainId": CHAIN, "integrator": INTEG, "wallet": "nope"})
        assert r.status_code == 400

    @pytest.mark.parametrize("bad", ["0xzz", "0x" + "ab" * 31, "", "0x"])
    def test_a_malformed_nullifier_is_a_403_not_a_500(self, client, rpc, bad):
        w = Account.create().address
        att = sign(w)
        att["nullifier"] = bad
        assert req(client, w, att).status_code == 403


# ── what the endpoints expose ───────────────────────────────────────────────


class TestEndpointExposure:
    def test_healthz_publishes_no_balance_or_funder(self, client):
        body = client.get("/healthz").json()
        assert set(body) == {"status"}

    def test_ops_health_is_absent_without_a_token(self, client):
        assert client.get("/v1/ops/health").status_code == 404

    def test_swagger_is_off(self, client):
        for path in ("/docs", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == 404, path


class TestStatusEndpoint:
    def test_would_fund_respects_the_caps(self, client, rpc):
        """It used to be `balance < floor`, ignoring every cap — so it said
        true for a wallet the caps would refuse, and the runbook tells
        operators to trust it during an incident."""
        w = Account.create().address
        rpc.verified.add(w.lower())
        for _ in range(faucet.LIMITS.max_drips_per_wallet):
            req(client, w)
            rpc.balances[w.lower()] = 0  # spend it again

        body = client.get("/v1/gas/status",
                          params={"chainId": CHAIN, "integrator": INTEG, "wallet": w}).json()
        assert body["wouldFund"] is False
        assert body["reason"] == "wallet_daily_count_reached"


# ── the signal itself ───────────────────────────────────────────────────────


class TestLogging:
    """There was no logging at all, and two documented failures are the kind
    you cannot tell apart without it.

    `Integrator.attestor` warns that a wrong value "silently rejects every
    cold-start request, which looks identical to the faucet being down" — and
    it has bitten two prior integrations. These assert the line that
    distinguishes them exists, and that nothing secret rides along with it.
    """

    def test_a_wrong_attestor_says_so(self, client, rpc, caplog):
        w = Account.create().address
        impostor = Account.from_key("0x" + "44" * 32)
        with caplog.at_level("INFO", logger="faucet"):
            req(client, w, sign(w, signer=impostor))
        text = caplog.text
        assert "reason=invalid_attestation" in text
        assert "attestor" in text, "the reason must name what actually failed"

    def test_every_refusal_names_its_reason(self, client, rpc, caplog):
        with caplog.at_level("INFO", logger="faucet"):
            req(client, Account.create().address)  # not verified
        assert "reason=not_verified" in caplog.text

    def test_a_funded_drip_is_recorded(self, client, rpc, caplog):
        w = Account.create().address
        rpc.verified.add(w.lower())
        with caplog.at_level("INFO", logger="faucet"):
            req(client, w)
        assert "event=funding" in caplog.text
        assert "event=funded" in caplog.text

    def test_a_decline_is_recorded_with_its_reason(self, client, rpc, caplog):
        w = Account.create().address
        rpc.verified.add(w.lower())
        rpc.balances[w.lower()] = 10**18  # plenty
        with caplog.at_level("INFO", logger="faucet"):
            req(client, w)
        assert "event=declined" in caplog.text
        assert "reason=sufficient_balance" in caplog.text

    def test_no_signature_or_key_is_ever_logged(self, client, rpc, caplog):
        w = Account.create().address
        att = sign(w)
        with caplog.at_level("DEBUG", logger="faucet"):
            req(client, w, att)
        text = caplog.text
        assert att["signature"] not in text, "a signature reached the logs"
        assert os.environ["FAUCET_PRIVATE_KEY"] not in text
        # The nullifier is a per-human pseudonym: truncated, so it can
        # correlate an incident without being a usable bearer token if leaked.
        assert att["nullifier"] not in text
