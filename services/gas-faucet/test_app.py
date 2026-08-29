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
import sqlite3
import secrets
import threading
import time

import pytest
from fastapi import HTTPException
from eth_account import Account
from eth_account.messages import encode_typed_data

INTEG = "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032"
CHAIN = 84532
_SIGNER = Account.from_key("0x" + "11" * 32)  # produces well-formed sigs; the fake does not verify
TARGET = 15_000_000_000_000

os.environ["FAUCET_ALLOW_EPHEMERAL_DB"] = "1"
os.environ["FAUCET_PRIVATE_KEY"] = "0x" + "22" * 32
os.environ["FAUCET_INTEGRATORS"] = json.dumps(
    [{"chainId": CHAIN, "address": INTEG, "label": "t"}]
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
        self.paused = False
        self.receipt_gas_used = "0x5208"          # 21_000
        self.receipt_gas_price = "0x2d4b370"      # ~0.047 gwei
        #: Steerable so a test can put the float on the floor. Both spend paths
        #: provision their worst-case fee against this before signing.
        self.funder_wei = 10**18
        self.lock = threading.Lock()

    def read_flag(self, contract, selector):
        if self.fail_reads:
            raise faucet.ChainError("rpc down")
        return self.paused

    def balance(self, addr):
        if addr.lower() == faucet._ACCOUNT.address.lower():
            return self.funder_wei
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

    def call(self, method, params):
        if method == "eth_getTransactionReceipt":
            return {
                "status": self.receipt_status,
                "gasUsed": self.receipt_gas_used,
                "effectiveGasPrice": self.receipt_gas_price,
            }
        return "0x1"

    def send_value(self, *, account, to, amount_wei, chain_id, base_fee):
        with self.lock:
            self.balances[to.lower()] = self.balances.get(to.lower(), 0) + amount_wei
            self.sent.append((to.lower(), amount_wei))
        return "0x" + secrets.token_hex(32)

    # ── the chain as verifier, in miniature ──────────────────────────────
    # simulate() enforces the same rules the contract would; a test steers
    # the outcome by populating spent_nullifiers or setting simulate_error.

    simulate_error: str | None = None

    simulate_transport = False

    def simulate(self, *, sender, to, data):
        if self.simulate_error:
            raise faucet.ChainError(self.simulate_error, transport=self.simulate_transport)
        # the nullifier is the second static word after the selector
        nul = "0x" + data[10 + 64 : 10 + 128]
        if nul.lower() in self.spent_nullifiers:
            raise faucet.ChainError(
                "execution reverted: " + list(faucet._SUBMIT_ERRORS)[0][2:]
            )

    def send_call(self, *, account, to, data, chain_id, base_fee):
        assert data.lower().startswith(faucet.SEL_SUBMIT_ATTESTATION)
        nul = "0x" + data[10 + 64 : 10 + 128]
        wal = "0x" + data[10 + 24 : 10 + 64]
        with self.lock:
            self.spent_nullifiers.add(nul.lower())
            self.verified.add(wal.lower())
            self.sent_calls = getattr(self, "sent_calls", [])
            self.sent_calls.append((to.lower(), data))
        return "0x" + secrets.token_hex(32)


@pytest.fixture(autouse=True)
def _fresh_state():
    """Rate buckets and reconciliation caches are process-global; a test that
    inherited another's would assert against the wrong world."""
    faucet._RATE_BUCKETS.clear()
    faucet._PAUSED_CACHE.clear()
    faucet._SUBMITS_IN_FLIGHT.clear()
    yield


@pytest.fixture
def rpc(monkeypatch):
    r = FakeRpc()
    monkeypatch.setattr(faucet, "_rpc", lambda cid: r)
    return r


@pytest.fixture
def store_direct(tmp_path):
    from store import Store
    return Store(str(tmp_path / "direct.db"))


@pytest.fixture
def client():
    return TestClient(faucet.app)


def sign(wallet, *, nullifier=None, limit=100_000_000, expiry=None, signer=_SIGNER,
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


def req(client, wallet):
    return client.post(
        "/v1/gas/request",
        json={"chainId": CHAIN, "integrator": INTEG, "wallet": wallet},
    )


def submit(client, wallet, att):
    return client.post(
        "/v1/attestation",
        json={"chainId": CHAIN, "integrator": INTEG, "wallet": wallet, **att},
    )


# ── who gets funded ─────────────────────────────────────────────────────────


class TestAuthorisation:
    """Who gets a drip. One gate: verified(wallet), plus the denylist.

    Everything the old cold-start path checked off-chain now lives behind
    POST /v1/attestation, where the chain does the checking — see
    TestSubmitEndpoint.
    """

    def test_a_verified_wallet_is_funded(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        r = req(client, w)
        assert r.status_code == 200 and r.json()["funded"] is True
        assert rpc.sent == [(w.lower(), TARGET)]

    def test_an_unverified_wallet_is_refused(self, client, rpc):
        r = req(client, Account.create().address)
        assert r.status_code == 403
        assert r.json()["detail"] == "not_verified"

    def test_an_unknown_integrator_is_refused(self, client, rpc):
        r = client.post("/v1/gas/request", json={
            "chainId": CHAIN, "integrator": "0x000000000000000000000000000000000000dEaD",
            "wallet": Account.create().address})
        assert r.status_code == 403 and r.json()["detail"] == "integrator_not_allowed"

    def test_a_blocked_wallet_is_refused_even_when_verified(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        rpc.blocked.add(w.lower())
        assert req(client, w).status_code == 403

    def test_an_rpc_fault_refuses_rather_than_funding(self, client, rpc):
        w = Account.create().address
        rpc.fail_reads = True
        assert req(client, w).status_code == 502
        assert rpc.sent == []


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
    def test_a_malformed_nullifier_is_a_400_not_a_500(self, client, rpc, bad):
        w = Account.create().address
        att = sign(w)
        att["nullifier"] = bad
        assert submit(client, w, att).status_code == 400


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

    The client fails open by contract, so a refused sponsor, a dead RPC and an
    empty float all look like nothing happening from outside. These assert the
    line that tells them apart exists, and that nothing secret rides along
    with it.
    """

    def test_a_refused_submission_names_the_chain_reason(self, client, rpc, caplog):
        # A wrong signer, an expired attestation, a spent nullifier — all are
        # the CHAIN's verdicts now. What the log must carry is the decoded
        # reason, or every failure looks like the service being down.
        w = Account.create().address
        rpc.simulate_error = (
            "execution reverted: " + list(faucet._SUBMIT_ERRORS)[2][2:]
        )
        with caplog.at_level("INFO", logger="faucet"):
            submit(client, w, sign(w))
        assert "reason=invalid_signature" in caplog.text

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
            submit(client, w, att)
            rpc.verified.add(w.lower())
            req(client, w)
        text = caplog.text
        assert att["signature"] not in text, "a signature reached the logs"
        assert os.environ["FAUCET_PRIVATE_KEY"] not in text
        # The nullifier is a per-human pseudonym: truncated, so it can
        # correlate an incident without being a usable bearer token if leaked.
        assert att["nullifier"] not in text


# ── the chain is the attestor authority ─────────────────────────────────────


class TestPausedIntegrator:
    def test_a_paused_integrator_declines_rather_than_funds(self, client, rpc, caplog):
        # Gas keeps, but spending budget during the exact window an operator
        # said "stop" is spending against their decision. A decline, not a
        # 4xx — the caller did nothing wrong.
        w = Account.create().address
        rpc.verified.add(w.lower())
        rpc.paused = True
        with caplog.at_level("INFO", logger="faucet"):
            body = req(client, w).json()
        assert body["funded"] is False
        assert body["reason"] == "integrator_paused"
        assert rpc.sent == []
        assert "reason=integrator_paused" in caplog.text

    def test_an_unreadable_paused_flag_does_not_block_funding(self, client, rpc, monkeypatch):
        # paused is an economy check; the money checks (blocked, verified,
        # caps) already fail closed. An availability failure here would add a
        # second way for an RPC flake to stop everyone.
        w = Account.create().address
        rpc.verified.add(w.lower())
        real_read_flag = rpc.read_flag
        def flaky(contract, selector):
            raise faucet.ChainError("rpc down")
        monkeypatch.setattr(rpc, "read_flag", flaky)
        assert req(client, w).json()["funded"] is True


class TestRateLimit:
    def test_a_wallet_hammering_the_faucet_gets_429(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_WALLET_PER_MIN", 3)
        w = Account.create().address
        rpc.verified.add(w.lower())
        codes = [req(client, w).status_code for _ in range(5)]
        assert codes[:3] == [200, 200, 200]
        assert codes[3:] == [429, 429]

    def test_an_ip_hammering_status_gets_429(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_IP_PER_MIN", 2)
        p = {"chainId": CHAIN, "integrator": INTEG, "wallet": Account.create().address}
        codes = [client.get("/v1/gas/status", params=p).status_code for _ in range(4)]
        assert codes[2:] == [429, 429]


class TestFeeAccounting:
    def test_the_actual_fee_lands_in_the_ledger(self, client, rpc):
        # gasUsed 21000 x 0.047054 gwei — the fee a real Base receipt showed.
        w = Account.create().address
        rpc.verified.add(w.lower())
        req(client, w)
        row = faucet.STORE._conn.execute(
            "SELECT fee_wei FROM drips WHERE wallet = ?", (w.lower(),)
        ).fetchone()
        assert row[0] == str(21_000 * 0x2D4B370)

    def test_the_fee_counts_toward_the_wallet_cap(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        req(client, w)
        usage = faucet.STORE.usage(wallet=w, nullifier=None, chain_id=CHAIN)
        assert usage.wallet_wei == TARGET + 21_000 * 0x2D4B370


# ── sponsoring a verification ───────────────────────────────────────────────


class TestSubmitEndpoint:
    """POST /v1/attestation — the service lands the verification, the chain
    verifies it. This suite replaces the deleted off-chain verifier tests:
    what used to be Python re-implementing EIP-712 is now a simulation the
    fake chain refuses the same way the real one would."""

    def test_sponsors_a_cold_wallet_end_to_end(self, client, rpc):
        # The whole point of the redesign, in one test: the wallet sends
        # nothing and pays nothing; after the sponsor call it is verified on
        # chain and the ordinary drip path accepts it.
        w = Account.create().address
        r = submit(client, w, sign(w))
        body = r.json()
        assert r.status_code == 200 and body["submitted"] is True
        assert body["txHash"] is not None
        assert w.lower() in rpc.verified

        drip = req(client, w).json()
        assert drip["funded"] is True

    def test_the_ledger_books_the_submission_and_its_fee(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        submit(client, w, att)
        row = faucet.STORE._conn.execute(
            "SELECT amount_wei, fee_wei, nullifier FROM drips WHERE wallet = ?",
            (w.lower(),),
        ).fetchone()
        assert row[0] == "0", "a submission transfers nothing"
        assert row[1] == str(21_000 * 0x2D4B370), "the gas it burned is booked"
        assert row[2] == att["nullifier"].lower()

    def test_a_simulation_revert_costs_nothing_and_names_the_reason(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        rpc.spent_nullifiers.add(att["nullifier"].lower())
        r = submit(client, w, att)
        assert r.status_code == 400
        assert r.json()["detail"] == "nullifier_already_spent"
        assert getattr(rpc, "sent_calls", []) == [], "nothing was broadcast"

    def test_a_double_submit_refuses_the_second(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        assert submit(client, w, att).status_code == 200
        # The fake spends the nullifier on send, exactly as the chain does.
        assert submit(client, w, att).status_code == 400

    def test_an_unknown_integrator_is_refused(self, client, rpc):
        w = Account.create().address
        r = client.post("/v1/attestation", json={
            "chainId": CHAIN, "integrator": "0x000000000000000000000000000000000000dEaD",
            "wallet": w, **sign(w)})
        assert r.status_code == 403

    def test_a_garbage_signature_is_a_400_not_a_broadcast(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        att["signature"] = "0xdead"
        assert submit(client, w, att).status_code == 400
        assert getattr(rpc, "sent_calls", []) == []

    def test_it_is_rate_limited_like_the_drip(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_WALLET_PER_MIN", 2)
        w = Account.create().address
        codes = [submit(client, w, sign(w)).status_code for _ in range(4)]
        # first submit succeeds, second 400s on the spent nullifier (still a
        # rate slot), the rest die at the limiter
        assert codes[2:] == [429, 429]

    def test_a_reverted_send_reports_not_submitted(self, client, rpc):
        w = Account.create().address
        rpc.receipt_status = "0x0"
        body = submit(client, w, sign(w)).json()
        assert body["submitted"] is False
        assert body["reason"] == "send_reverted"


class TestKeyBlastRadius:
    """The key used to be provably unable to sign a contract call. The sponsor
    role widens that, so the widening gets its own tests at the choke point."""

    def test_send_call_refuses_any_other_calldata(self):
        import chain as chain_mod

        rpc = chain_mod.Rpc("http://127.0.0.1:1/unused")
        with pytest.raises(chain_mod.ChainError, match="only signs"):
            rpc.send_call(
                account=faucet._ACCOUNT,
                to=INTEG,
                data="0xa9059cbb" + "00" * 64,  # transfer(address,uint256)
                chain_id=CHAIN,
                base_fee=5_000_000,
            )

    def test_the_encoder_produces_the_submit_selector(self):
        att = sign(Account.create().address)
        data = faucet._encode_submit(
            Account.create().address, att["nullifier"], att["limit"],
            att["expiry"], att["signature"],
        )
        assert data.startswith(faucet.SEL_SUBMIT_ATTESTATION)
        # 4-byte selector + 5 head words + length word + 96-byte padded sig
        assert len(data) == 10 + 64 * 5 + 64 + 96 * 2


# ── review-round fixes, each pinned ─────────────────────────────────────────


class TestRevertDataDecoding:
    """Base's canonical nodes put a custom-error selector in error.DATA with
    message="execution reverted". The old ChainError carried only the message,
    so every friendly reason was undecodable — the client's
    nullifier_already_spent recovery could never fire."""

    def test_a_real_node_shaped_revert_decodes_to_its_reason(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        # Exactly what op-geth returns: selector nowhere but in data.
        selector = list(faucet._SUBMIT_ERRORS)[0]  # NullifierAlreadySpent
        rpc.simulate_error = f"eth_call: execution reverted data={selector}"
        r = submit(client, w, att)
        assert r.status_code == 400
        assert r.json()["detail"] == "nullifier_already_spent"

    def test_chain_error_carries_the_data_field(self):
        import chain as chain_mod
        import httpx

        class FakeResp:
            def raise_for_status(self): pass
            def json(self):
                return {"jsonrpc": "2.0", "id": 1,
                        "error": {"code": 3, "message": "execution reverted",
                                  "data": "0xdeadbeef"}}

        rpc = chain_mod.Rpc("http://x")
        rpc._client = type("C", (), {"post": lambda self, url, json: FakeResp()})()
        with pytest.raises(chain_mod.ChainError, match="data=0xdeadbeef"):
            rpc.call("eth_call", [])


class TestSponsorRespectsPause:
    def test_a_paused_integrator_refuses_sponsorship(self, client, rpc):
        rpc.paused = True
        w = Account.create().address
        r = submit(client, w, sign(w))
        assert r.status_code == 409
        assert r.json()["detail"] == "integrator_paused"
        assert getattr(rpc, "sent_calls", []) == []


class TestSubmitBounds:
    @pytest.mark.parametrize("field,value", [("limit", 2**256), ("expiry", 2**256)])
    def test_word_overflow_is_a_400_not_shifted_calldata(self, client, rpc, field, value):
        # format(x, "064x") pads but does not truncate — an overlong field
        # nibble-shifts everything after it in the calldata.
        w = Account.create().address
        att = sign(w)
        att[field] = value
        assert submit(client, w, att).status_code == 400


class TestSponsoredRowsAndDripSlots:
    def test_a_sponsored_submit_does_not_consume_a_drip_slot(self, client, rpc):
        # The amount-0 sponsor row counted in wallet_drips, so every sponsored
        # user started the day one slot down.
        w = Account.create().address
        submit(client, w, sign(w))
        usage = faucet.STORE.usage(wallet=w, nullifier=None, chain_id=CHAIN)
        assert usage.wallet_drips == 0, "the sponsor row must not count as a drip"
        req(client, w)
        usage = faucet.STORE.usage(wallet=w, nullifier=None, chain_id=CHAIN)
        assert usage.wallet_drips == 1


class TestIdentityBudgetIsAliveAgain:
    def test_drips_are_booked_against_the_enrolling_identity(self, client, rpc):
        # Regression guard: after the cold-start deletion every usage() call
        # passed nullifier=None, so identity_daily_budget_reached was dead code
        # and its env knob silently inert. The sponsor row holds the mapping;
        # the drip path must recall it.
        w = Account.create().address
        att = sign(w)
        submit(client, w, att)
        req(client, w)
        row = faucet.STORE._conn.execute(
            "SELECT nullifier FROM drips WHERE wallet = ? AND CAST(amount_wei AS INTEGER) > 0",
            (w.lower(),),
        ).fetchone()
        assert row[0] == att["nullifier"].lower(), "the drip must carry the identity"

    def test_the_identity_cap_can_actually_fire(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "LIMITS", faucet.LIMITS.__class__(
            **{**faucet.LIMITS.__dict__, "max_wei_per_nullifier": 1}))
        w = Account.create().address
        att = sign(w)
        submit(client, w, att)     # fee books against the nullifier
        r = req(client, w)
        assert r.json()["reason"] == "identity_daily_budget_reached"


# ── review round 3: the fix that was worse than the bug, and its siblings ───


class TestLedgerFailsClosed:
    """The headline finding. A post-send ledger write that swallowed its own
    failure meant every cap (a SUM/COUNT over that table) silently stopped
    working while the wallet kept paying out — an uncapped hot wallet, which
    is worse than an unavailable one. Book-before-send makes a write failure
    refuse BEFORE the money moves."""

    def test_a_dead_ledger_refuses_rather_than_funding_uncapped(self, client, rpc, monkeypatch):
        w = Account.create().address
        rpc.verified.add(w.lower())

        # The exact production trigger: a read-only volume. reserve() raises;
        # reads still work, so the OLD code saw zeros and kept funding.
        def dead_reserve(**k):
            raise sqlite3.OperationalError("attempt to write a readonly database")

        monkeypatch.setattr(faucet.STORE, "reserve", dead_reserve)
        r = req(client, w)
        assert r.status_code == 503
        assert r.json()["detail"] == "ledger_unavailable"
        assert rpc.sent == [], "no ETH may move when the cap slot cannot be claimed"

    def test_the_cap_actually_binds_across_many_requests(self, client, rpc):
        # The counterpart: with a healthy ledger the count cap still bites.
        w = Account.create().address
        rpc.verified.add(w.lower())
        reasons = []
        for _ in range(faucet.LIMITS.max_drips_per_wallet + 3):
            reasons.append(req(client, w).json().get("reason"))
            rpc.balances[w.lower()] = 0  # spend it so balance never short-circuits
        assert reasons.count("funded") == faucet.LIMITS.max_drips_per_wallet
        assert "wallet_daily_count_reached" in reasons

    def test_a_failed_send_frees_the_reserved_slot(self, client, rpc, monkeypatch):
        w = Account.create().address
        rpc.verified.add(w.lower())

        def failing_send(**k):
            raise faucet.ChainError("rpc unreachable: boom", transport=True)

        monkeypatch.setattr(rpc, "send_value", failing_send)
        assert req(client, w).status_code == 502
        # The reservation must be released, not left spending a slot.
        usage = faucet.STORE.usage(wallet=w, nullifier=None, chain_id=CHAIN)
        assert usage.wallet_drips == 0


class TestSubmitOutageIsA502:
    def test_an_rpc_outage_on_submit_is_502_not_a_user_error(self, client, rpc):
        w = Account.create().address
        rpc.simulate_error = "rpc unreachable: connection refused"
        rpc.simulate_transport = True
        r = submit(client, w, sign(w))
        assert r.status_code == 502, "a total outage must not read as a bad attestation"
        assert "chain_unreachable" in r.json()["detail"]


class TestOpsTokenNoOracle:
    def test_a_non_ascii_token_404s_like_any_other_wrong_token(self, client, monkeypatch):
        monkeypatch.setenv("FAUCET_OPS_TOKEN", "secret-value")
        # A non-ASCII guess used to raise TypeError -> 500, confirming the
        # token is configured. It must 404 exactly like a wrong ASCII guess.
        # (bytes: httpx refuses to encode a non-ASCII str header; on the wire
        # Starlette decodes it latin-1, which is the case under test.)
        assert client.get("/v1/ops/health", headers={"X-Ops-Token": "wrong"}).status_code == 404
        assert client.get("/v1/ops/health",
                          headers={b"X-Ops-Token": "wröng".encode("latin-1")}).status_code == 404


class TestRecordFeeByRow:
    def test_two_rows_sharing_a_hash_do_not_both_take_the_fee(self, store_direct):
        # record_fee is keyed by id now, not tx_hash — a hash-keyed UPDATE
        # credited every row sharing a hash.
        a = store_direct.reserve(chain_id=CHAIN, wallet="0xA", nullifier=None, amount_wei=10)
        b = store_direct.reserve(chain_id=CHAIN, wallet="0xB", nullifier=None, amount_wei=10)
        store_direct.attach_tx(a, "0xSAME")
        store_direct.attach_tx(b, "0xSAME")
        store_direct.record_fee(a, 5)
        rows = store_direct._conn.execute("SELECT id, fee_wei FROM drips ORDER BY id").fetchall()
        fees = {r[0]: r[1] for r in rows}
        assert fees[a] == "5"
        assert fees[b] is None, "the other row must not inherit the fee"


# ── review round 4 ──────────────────────────────────────────────────────────


class TestSubmitGasBounds:
    def test_gas_is_clamped_to_the_submit_ceiling(self):
        import chain as chain_mod

        # A hostile/broken node returning a huge estimate must not size the tx.
        rpc = chain_mod.Rpc("http://x")
        rpc.call = lambda m, p: (
            "0x1" if m == "eth_getTransactionCount"
            else hex(50_000_000) if m == "eth_estimateGas"
            else "0x1"
        )
        sent = {}
        def cap(raw): sent["raw"] = raw; return "0x" + "ab" * 32
        rpc.call = lambda m, p: (
            "0x5" if m == "eth_getTransactionCount"
            else hex(50_000_000) if m == "eth_estimateGas"
            else cap(p[0]) if m == "eth_sendRawTransaction"
            else "0x0"
        )
        data = faucet.SEL_SUBMIT_ATTESTATION + "00" * 100
        rpc.send_call(account=faucet._ACCOUNT, to=INTEG, data=data, chain_id=CHAIN, base_fee=5_000_000)
        from eth_account._utils.legacy_transactions import Transaction  # noqa
        # decode the signed tx's gas limit
        import rlp
        raw = bytes.fromhex(sent["raw"][2:])
        # type-2 tx: 0x02 || rlp([...]); gas is field index 4
        decoded = rlp.decode(raw[1:])
        gas_limit = int.from_bytes(decoded[4], "big")
        assert gas_limit == chain_mod.SUBMIT_GAS_CEILING, f"got {gas_limit}"

    def test_gas_is_raised_to_the_floor_for_a_bogus_low_estimate(self):
        import chain as chain_mod, rlp
        rpc = chain_mod.Rpc("http://x")
        sent = {}
        rpc.call = lambda m, p: (
            "0x5" if m == "eth_getTransactionCount"
            else hex(21_000) if m == "eth_estimateGas"
            else (sent.__setitem__("raw", p[0]) or "0x" + "ab" * 32) if m == "eth_sendRawTransaction"
            else "0x0"
        )
        data = faucet.SEL_SUBMIT_ATTESTATION + "00" * 100
        rpc.send_call(account=faucet._ACCOUNT, to=INTEG, data=data, chain_id=CHAIN, base_fee=5_000_000)
        decoded = rlp.decode(bytes.fromhex(sent["raw"][2:])[1:])
        assert int.from_bytes(decoded[4], "big") == chain_mod.SUBMIT_GAS_FLOOR


class TestSponsorHonoursTheFloatGuards:
    def test_a_blocked_wallet_is_not_sponsored(self, client, rpc):
        w = Account.create().address
        rpc.blocked.add(w.lower())
        r = submit(client, w, sign(w))
        assert r.status_code == 403
        assert getattr(rpc, "sent_calls", []) == [], "no gas spent for a blocked wallet"

    def test_the_global_breaker_stops_sponsorship(self, client, rpc, monkeypatch):
        # Trip the breaker, then a sponsor must refuse rather than spend float.
        monkeypatch.setattr(faucet, "LIMITS", faucet.LIMITS.__class__(
            **{**faucet.LIMITS.__dict__, "max_wei_global": 0}))
        r = submit(client, Account.create().address, sign(Account.create().address))
        assert r.status_code == 429
        assert r.json()["detail"] == "global_daily_budget_reached"


class TestSubmitInFlightDedup:
    def test_a_second_concurrent_submit_of_one_attestation_is_refused(self, client, rpc, monkeypatch):
        import threading
        w = Account.create().address
        att = sign(w)
        # hold the first submit inside the lock long enough for the second to race
        gate = threading.Event()
        orig = rpc.send_call
        def slow_send(**k):
            gate.set()
            time.sleep(0.3)
            return orig(**k)
        monkeypatch.setattr(rpc, "send_call", slow_send)

        results = []
        def fire(): results.append(submit(client, w, att).status_code)
        t1 = threading.Thread(target=fire); t1.start()
        gate.wait(1)
        # second request while the first is mid-send
        fire()
        t1.join()
        assert sorted(results) == [200, 409], f"{results}"


class TestCanonicalNullifierInLedger:
    @pytest.mark.parametrize("spelling", ["ab" * 32, "0x" + ("ab" * 32).upper()])
    def test_a_submit_stores_the_canonical_nullifier_whatever_the_spelling(self, client, rpc, spelling):
        # One nullifier is single-use on chain, so two spellings never both
        # succeed. What matters is that the ONE row a submit writes holds the
        # canonical key — an incident review and the per-identity cap both
        # correlate on it.
        w = Account.create().address
        r = submit(client, w, {**sign(w), "nullifier": spelling})
        assert r.status_code == 200
        stored = faucet.STORE._conn.execute(
            "SELECT nullifier FROM drips WHERE wallet = ?", (w.lower(),)
        ).fetchone()[0]
        assert stored == "0x" + "ab" * 32, f"stored {stored}"


class TestLimitZeroRejected:
    """#80 regressed when attestation.py was deleted — the limit<=0 check lived
    there. A limit-0 attestation verifies a wallet that can never buy, so
    sponsoring it spends gas to reach a useless state."""

    def test_a_limit_zero_submission_is_refused_before_any_gas(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        att["limit"] = 0
        r = submit(client, w, att)
        assert r.status_code == 400
        assert r.json()["detail"] == "attested_limit_zero"
        assert getattr(rpc, "sent_calls", []) == [], "no gas may be spent on a limit-0 submit"

    def test_a_positive_limit_still_sponsors(self, client, rpc):
        w = Account.create().address
        assert submit(client, w, sign(w)).json()["submitted"] is True


class TestInFlightMarkerIsReleased:
    """A submit that never broadcast must not hold its nullifier forever.

    `_SUBMITS_IN_FLIGHT` stops two concurrent requests broadcasting one
    attestation. It is added to before the ledger reservation, and the
    reservation is the thing that fails when the volume is full or read-only.
    If that path does not release the marker, the nullifier is held for the
    life of the process: a nullifier is per-human and single-use on chain, and
    sponsored submit is the only enrolment path, so the person can never
    verify any wallet again until someone restarts the container.
    """

    def test_a_ledger_failure_releases_the_nullifier(self, client, rpc):
        wallet = Account.create().address
        att = sign(wallet)

        def refuse(**kwargs):
            raise Exception("attempt to write a readonly database")

        # Swap only the ledger write. monkeypatch.undo() would also revert the
        # rpc fixture, and the retry would then fail on an unreachable node
        # rather than on the thing under test.
        healthy = faucet.STORE.reserve
        faucet.STORE.reserve = refuse
        try:
            first = submit(client, wallet, att)
            assert first.status_code == 503
            assert first.json()["detail"] == "ledger_unavailable"
            assert getattr(rpc, "sent_calls", []) == [], "nothing may be broadcast"
        finally:
            faucet.STORE.reserve = healthy  # the volume comes back

        second = submit(client, wallet, att)
        assert second.status_code != 409, "the marker outlived the failed attempt"
        assert second.json()["submitted"] is True

    def test_the_marker_is_empty_once_a_submit_settles(self, client, rpc):
        wallet = Account.create().address
        assert submit(client, wallet, sign(wallet)).json()["submitted"] is True
        assert faucet._SUBMITS_IN_FLIGHT == set()

    def test_a_send_failure_also_releases_it(self, client, rpc, monkeypatch):
        wallet = Account.create().address
        att = sign(wallet)

        def boom(**kwargs):
            raise faucet.ChainError("broadcast refused")

        monkeypatch.setattr(rpc, "send_call", boom)
        assert submit(client, wallet, att).status_code == 502
        assert faucet._SUBMITS_IN_FLIGHT == set()


class TestNullifierIsValidatedInTheFormItIsUsed:
    """`bytes.fromhex` ignores ASCII whitespace, so 64 characters is not 32 bytes.

    The length check counts characters and the decode check only asserts the
    string parses. A 64-character value carrying whitespace passes both, then
    the RAW string is concatenated into the calldata and the short decode
    becomes the ledger's per-human key.
    """

    SHORT = "ab" * 31 + "  "  # 64 chars, decodes to 31 bytes

    def test_whitespace_padding_is_refused(self, client, rpc):
        wallet = Account.create().address
        att = sign(wallet)
        att["nullifier"] = self.SHORT
        res = submit(client, wallet, att)
        assert res.status_code == 400
        assert "nullifier" in res.json()["detail"]
        assert getattr(rpc, "sent_calls", []) == []

    def test_the_encoder_refuses_it_directly(self):
        with pytest.raises(HTTPException) as caught:
            faucet._encode_submit(
                Account.create().address, self.SHORT, 1, 2, "0x" + "11" * 65
            )
        assert caught.value.status_code == 400

    def test_calldata_is_always_hex(self, rpc):
        data = faucet._encode_submit(
            Account.create().address, "0x" + "ab" * 32, 1, 2, "0x" + "11" * 65
        )
        assert all(c in "0123456789abcdefx" for c in data), "non-hex reached the calldata"


class TestSponsorRespectsTheFloat:
    """The sponsor path spends gas, so it owes the same float guards as a drip.

    The drip provisions the worst-case fee before deciding the funder can
    afford it. A submit that skips that check keeps signing until the sends
    themselves fail for want of gas, which is a 502 where a clean refusal was
    available.
    """

    def test_an_empty_funder_refuses_before_signing(self, client, rpc):
        rpc.funder_wei = 1
        wallet = Account.create().address
        res = submit(client, wallet, sign(wallet))
        assert res.status_code == 503
        assert res.json()["detail"] == "faucet_empty"
        assert getattr(rpc, "sent_calls", []) == []

    def test_a_funded_float_still_sponsors(self, client, rpc):
        wallet = Account.create().address
        assert submit(client, wallet, sign(wallet)).json()["submitted"] is True


# ── security review, 2026-08-24 ─────────────────────────────────────────────


class TestNoSecretsInErrorBodies:
    """H1. Every 502 carried str(exc), and httpx quotes the full RPC URL in
    its errors — which, for a keyed provider endpoint, IS the API key. The
    send-failure 502 echoed the node too, and a node refusing an underfunded
    key says "insufficient funds ... have <balance>": the float, to anyone."""

    def _rpc_with(self, handler):
        import chain as chain_mod
        import httpx

        rpc = chain_mod.Rpc("http://provider.example/v2/SECRET-KEY")
        rpc._client = httpx.Client(transport=httpx.MockTransport(handler))
        return rpc, chain_mod

    def test_a_transport_error_never_carries_the_rpc_url(self):
        import httpx

        rpc, chain_mod = self._rpc_with(lambda request: httpx.Response(429, text="slow down"))
        with pytest.raises(chain_mod.ChainError) as caught:
            rpc.call("eth_blockNumber", [])
        assert caught.value.transport
        assert "SECRET-KEY" not in str(caught.value)
        assert "<rpc>" in str(caught.value), "the URL is replaced, not merely absent"

    def test_a_non_json_body_is_a_transport_fault_not_a_500(self):
        # L3. A proxy's HTML error page on a 200 used to raise JSONDecodeError
        # past every `except ChainError`.
        import httpx

        rpc, chain_mod = self._rpc_with(lambda request: httpx.Response(200, text="<html>oops"))
        with pytest.raises(chain_mod.ChainError) as caught:
            rpc.call("eth_blockNumber", [])
        assert caught.value.transport

    def test_a_null_quantity_is_a_transport_fault_not_a_500(self):
        import httpx

        rpc, chain_mod = self._rpc_with(
            lambda request: httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": None})
        )
        with pytest.raises(chain_mod.ChainError) as caught:
            rpc.balance(Account.create().address)
        assert caught.value.transport

    def test_a_502_body_is_a_fixed_word(self, client, rpc):
        rpc.fail_reads = True
        r = req(client, Account.create().address)
        assert r.status_code == 502
        assert r.json()["detail"] == "chain_unreachable"

    def test_a_failed_send_does_not_echo_the_node(self, client, rpc, monkeypatch):
        w = Account.create().address
        rpc.verified.add(w.lower())

        def broke(**k):
            raise faucet.ChainError(
                "insufficient funds for gas * price + value: have 12345 want 99999"
            )

        monkeypatch.setattr(rpc, "send_value", broke)
        r = req(client, w)
        assert r.status_code == 502
        assert r.json()["detail"] == "send_failed"
        assert "12345" not in r.text


class TestOpsTokenInHeader:
    """H2. A `?token=` query string is written to the edge access log, browser
    history and every proxy's log. The header is not."""

    def test_the_query_string_is_no_longer_a_credential(self, client, rpc, monkeypatch):
        monkeypatch.setenv("FAUCET_OPS_TOKEN", "secret-value")
        assert client.get("/v1/ops/health", params={"token": "secret-value"}).status_code == 404

    def test_a_bearer_header_is_accepted(self, client, rpc, monkeypatch):
        monkeypatch.setenv("FAUCET_OPS_TOKEN", "secret-value")
        r = client.get("/v1/ops/health", headers={"Authorization": "Bearer secret-value"})
        assert r.status_code == 200
        assert r.json()["funder"] == faucet._ACCOUNT.address

    def test_an_x_ops_token_header_is_accepted(self, client, rpc, monkeypatch):
        monkeypatch.setenv("FAUCET_OPS_TOKEN", "secret-value")
        r = client.get("/v1/ops/health", headers={"X-Ops-Token": "secret-value"})
        assert r.status_code == 200

    def test_guessing_is_rate_limited(self, client, monkeypatch):
        monkeypatch.setenv("FAUCET_OPS_TOKEN", "secret-value")
        monkeypatch.setattr(faucet, "RATE_IP_PER_MIN", 3)
        codes = [
            client.get("/v1/ops/health", headers={"X-Ops-Token": f"guess{i}"}).status_code
            for i in range(5)
        ]
        assert codes == [404, 404, 404, 429, 429]


class TestForwardedFor:
    """M2. The leftmost X-Forwarded-For hop is whatever the client wrote; only
    the rightmost TRUSTED_PROXIES hops came from something we trust."""

    def _status(self, client, xff, wallet=None):
        return client.get(
            "/v1/gas/status",
            params={"chainId": CHAIN, "integrator": INTEG,
                    "wallet": wallet or Account.create().address},
            headers={"x-forwarded-for": xff},
        ).status_code

    def test_the_leftmost_hop_cannot_pick_the_limit_key(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_IP_PER_MIN", 2)
        # Same real client behind the proxy, spoofing a fresh leftmost hop each
        # time. Used to reset its own limiter with every request.
        codes = [self._status(client, f"10.0.0.{i}, 203.0.113.9") for i in range(4)]
        assert codes[2:] == [429, 429]

    def test_distinct_clients_behind_the_proxy_are_limited_separately(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_IP_PER_MIN", 2)
        codes = [self._status(client, f"1.1.1.1, 203.0.113.{i % 2}") for i in range(4)]
        assert codes == [200, 200, 200, 200]

    def test_with_no_proxy_the_header_is_ignored(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "TRUSTED_PROXIES", 0)
        monkeypatch.setattr(faucet, "RATE_IP_PER_MIN", 2)
        codes = [self._status(client, f"203.0.113.{i}") for i in range(4)]
        assert codes[2:] == [429, 429], "rotating the header must not rotate the key"

    def test_status_is_limited_per_wallet_too(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "RATE_WALLET_PER_MIN", 2)
        w = Account.create().address
        # A different trusted hop every time, so only the wallet key can trip.
        codes = [self._status(client, f"203.0.113.{i}", wallet=w) for i in range(4)]
        assert codes[2:] == [429, 429]


class TestRateBucketEviction:
    def test_a_hot_key_survives_a_flood_of_fresh_keys(self, monkeypatch):
        # M3. Insertion-order eviction dropped the OLDEST bucket first — the
        # very key being hammered, created before the flood — so the flood
        # un-throttled it. LRU keeps whatever is still being touched.
        monkeypatch.setattr(faucet, "_RATE_MAX_BUCKETS", 5)
        for _ in range(3):
            faucet._over_limit("hot", 3)
        for i in range(50):
            faucet._over_limit(f"cold{i}", 3)
            assert faucet._over_limit("hot", 3) is True, f"hot key lost its history at {i}"
        assert len(faucet._RATE_BUCKETS) <= 5


class TestInputBounds:
    """M5. Unbounded string fields were accepted by the schema and handed to
    bytes.fromhex — CPU and memory on input that can never be valid."""

    def test_an_oversized_nullifier_is_refused_at_the_schema(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        att["nullifier"] = "0x" + "ab" * 50_000
        r = submit(client, w, att)
        assert 400 <= r.status_code < 500
        assert getattr(rpc, "sent_calls", []) == []

    def test_an_oversized_signature_is_refused_at_the_schema(self, client, rpc):
        w = Account.create().address
        att = sign(w)
        att["signature"] = "0x" + "ab" * 50_000
        assert 400 <= submit(client, w, att).status_code < 500

    def test_an_oversized_wallet_is_refused_on_every_endpoint(self, client, rpc):
        huge = "0x" + "a" * 50_000
        assert 400 <= client.post("/v1/gas/request", json={
            "chainId": CHAIN, "integrator": INTEG, "wallet": huge}).status_code < 500
        assert 400 <= client.get("/v1/gas/status", params={
            "chainId": CHAIN, "integrator": INTEG, "wallet": huge}).status_code < 500

    def test_the_encoder_checks_length_before_decoding(self, monkeypatch):
        decoded = []
        real = bytes.fromhex
        # Shadow the builtin inside the module so the call is observable.
        monkeypatch.setattr(faucet, "bytes", type("B", (), {"fromhex": staticmethod(
            lambda h: decoded.append(len(h)) or real(h))}), raising=False)
        with pytest.raises(HTTPException) as caught:
            faucet._encode_submit(Account.create().address, "ab" * 40, 1, 2, "0x" + "11" * 65)
        assert caught.value.status_code == 400
        assert decoded == [], "an over-long value must not reach the decoder"


class TestReceiptParsing:
    """M1. The `status` parse sat outside the inner try: a node answering with
    a malformed status raised ValueError out of the wait — after the money had
    moved — as a 500, and on the sponsor path past the marker release."""

    @pytest.fixture(autouse=True)
    def _no_sleep(self, monkeypatch):
        monkeypatch.setattr(faucet.time, "sleep", lambda s: None)

    def test_a_malformed_status_is_pending_not_a_500(self, client, rpc):
        w = Account.create().address
        rpc.verified.add(w.lower())
        rpc.receipt_status = "not-hex"
        r = req(client, w)
        assert r.status_code == 200
        assert r.json()["funded"] is True and r.json()["pending"] is True

    def test_a_malformed_receipt_on_submit_releases_the_marker(self, client, rpc):
        w = Account.create().address
        rpc.receipt_status = "garbage"
        r = submit(client, w, sign(w))
        assert r.status_code == 200
        assert faucet._SUBMITS_IN_FLIGHT == set()

    def test_an_exception_in_the_wait_still_releases_the_marker(self, client, rpc, monkeypatch):
        def explode(rpc_, tx_hash, **k):
            raise RuntimeError("anything at all")

        monkeypatch.setattr(faucet, "_await_receipt", explode)
        w = Account.create().address
        with pytest.raises(RuntimeError):
            submit(client, w, sign(w))
        assert faucet._SUBMITS_IN_FLIGHT == set(), "the marker outlived the request"


class TestFeeClamp:
    def test_an_absurd_receipt_fee_cannot_trip_the_breaker(self, client, rpc):
        # L2. A hostile or broken RPC reporting a 10^24 wei fee used to book
        # it verbatim, tripping the global breaker from the read side.
        import chain as chain_mod

        rpc.receipt_gas_used = hex(10**12)
        rpc.receipt_gas_price = hex(10**12)
        w = Account.create().address
        rpc.verified.add(w.lower())
        assert req(client, w).json()["funded"] is True
        row = faucet.STORE._conn.execute(
            "SELECT fee_wei FROM drips WHERE wallet = ?", (w.lower(),)
        ).fetchone()
        assert row[0] == str(chain_mod.max_transfer_fee_wei())
        # and the next wallet is still served
        w2 = Account.create().address
        rpc.verified.add(w2.lower())
        assert req(client, w2).json()["funded"] is True

    def test_the_ledger_refuses_a_negative_or_overflowing_fee(self, store_direct):
        a = store_direct.reserve(chain_id=CHAIN, wallet="0xA", nullifier=None, amount_wei=1)
        store_direct.record_fee(a, -5)
        assert store_direct._conn.execute("SELECT fee_wei FROM drips WHERE id=?", (a,)).fetchone()[0] == "0"
        store_direct.record_fee(a, 10**30)
        assert int(store_direct._conn.execute("SELECT fee_wei FROM drips WHERE id=?", (a,)).fetchone()[0]) == 2**63 - 1


class TestRevertSelectorMatching:
    def test_the_contract_errors_the_table_missed_decode(self):
        # L5. Both are real reverts of submitPassportAttestation.
        from eth_utils import keccak

        for err, name in [("InvalidLimit", "invalid_limit"),
                          ("AttestationWindowTooLong", "attestation_window_too_long")]:
            sel = "0x" + keccak(text=err + "()")[:4].hex()
            assert faucet._submit_reason(f"eth_call: execution reverted data={sel}") == name

    def test_a_selector_buried_inside_other_hex_is_not_a_match(self):
        # L6. Eight hex characters recur by chance inside signatures and
        # addresses; a substring match mislabelled such reverts.
        sel = list(faucet._SUBMIT_ERRORS)[0][2:]
        blob = "0x" + "12" * 20 + sel + "00" * 8
        assert faucet._submit_reason(f"execution reverted data={blob}") == "simulation_reverted"

    def test_a_selector_at_the_head_of_the_data_matches(self):
        sel = list(faucet._SUBMIT_ERRORS)[0]
        assert faucet._submit_reason(
            f"execution reverted data={sel}{'00' * 32}") == "nullifier_already_spent"
        assert faucet._submit_reason(f"execution reverted: {sel[2:]}") == "nullifier_already_spent"


class TestStatusHidesTheFloat:
    """L1. /v1/gas/status needs no verified wallet, so through it the float's
    emptiness and the breaker's state were a public gauge."""

    def _status(self, client):
        return client.get("/v1/gas/status", params={
            "chainId": CHAIN, "integrator": INTEG, "wallet": Account.create().address}).json()

    def test_an_empty_float_is_not_announced(self, client, rpc):
        rpc.funder_wei = 1
        body = self._status(client)
        assert body["wouldFund"] is False
        assert body["reason"] == "temporarily_unavailable"

    def test_a_tripped_breaker_is_not_announced(self, client, rpc, monkeypatch):
        monkeypatch.setattr(faucet, "LIMITS", faucet.LIMITS.__class__(
            **{**faucet.LIMITS.__dict__, "max_wei_global": 0}))
        assert self._status(client)["reason"] == "temporarily_unavailable"

    def test_wallet_side_reasons_are_still_named(self, client, rpc):
        w = Account.create().address
        rpc.balances[w.lower()] = 10**18
        body = client.get("/v1/gas/status", params={
            "chainId": CHAIN, "integrator": INTEG, "wallet": w}).json()
        assert body["reason"] == "sufficient_balance"


class TestNonceTracking:
    """L4. Both spend paths release the lock before the receipt wait, so a
    second send can follow within a second; an RPC whose pending count lags
    the first broadcast then hands out the same nonce twice."""

    def _rpc(self, pending):
        import chain as chain_mod

        rpc = chain_mod.Rpc("http://x")
        sent: list[str] = []

        def call(m, p):
            if m == "eth_getTransactionCount":
                return hex(pending[0])
            if m == "eth_sendRawTransaction":
                sent.append(p[0])
                return "0x" + "ab" * 32
            if m == "eth_getCode":
                return "0x"
            return "0x0"

        rpc.call = call
        return rpc, sent

    @staticmethod
    def _nonces(sent):
        import rlp

        # type-2 tx: 0x02 || rlp([chainId, nonce, ...]); nonce is field 1
        return [int.from_bytes(rlp.decode(bytes.fromhex(r[2:])[1:])[1], "big") for r in sent]

    def _send(self, rpc):
        rpc.send_value(account=faucet._ACCOUNT, to=Account.create().address,
                       amount_wei=1, chain_id=CHAIN, base_fee=5_000_000)

    def test_a_lagging_pending_count_does_not_reuse_a_nonce(self):
        rpc, sent = self._rpc([5])
        self._send(rpc)
        self._send(rpc)  # the node still says 5
        assert self._nonces(sent) == [5, 6]

    def test_the_node_wins_when_it_is_ahead(self):
        # An operator sending from the key by hand, or a restart: re-sync.
        pending = [5]
        rpc, sent = self._rpc(pending)
        self._send(rpc)
        pending[0] = 9
        self._send(rpc)
        assert self._nonces(sent) == [5, 9]

    def test_a_nonce_refusal_forgets_the_local_view(self):
        pending = [5]
        rpc, sent = self._rpc(pending)
        self._send(rpc)  # local view is now 6
        healthy = rpc.call

        def refusing(m, p):
            if m == "eth_sendRawTransaction":
                raise faucet.ChainError("eth_sendRawTransaction: nonce too low")
            return healthy(m, p)

        rpc.call = refusing
        with pytest.raises(faucet.ChainError):
            self._send(rpc)
        rpc.call = healthy
        pending[0] = 3  # the node's word, after a reorg or a drop
        self._send(rpc)
        assert self._nonces(sent)[-1] == 3, "a stale local view must not walk ahead"

    def test_the_submit_path_shares_the_tracker(self):
        rpc, sent = self._rpc([5])
        data = faucet.SEL_SUBMIT_ATTESTATION + "00" * 100
        rpc.call = (lambda orig: (lambda m, p: hex(150_000) if m == "eth_estimateGas" else orig(m, p)))(rpc.call)
        rpc.send_call(account=faucet._ACCOUNT, to=INTEG, data=data, chain_id=CHAIN, base_fee=5_000_000)
        self._send(rpc)
        assert self._nonces(sent) == [5, 6]
