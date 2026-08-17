"""Tests for the parts of the faucet that decide to spend money.

The chain client is not tested here — it is a thin RPC wrapper, and the
interesting failures all live in the policy and in the attestation check.
"""

from __future__ import annotations

import time

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from attestation import (
    Attestation,
    InvalidAttestation,
    canonical_nullifier,
    check_attestation,
    recover_attestor,
)
from policy import Limits, decide, drip_target_wei, floor_wei
from store import Store, utc_day_start

GWEI = 10**9

LIMITS = Limits(
    gas_units=1_500_000,
    safety_factor=4,
    min_target=20_000_000_000_000,
    max_target=400_000_000_000_000,
    max_drips_per_wallet=4,
    max_wei_per_wallet=800_000_000_000_000,
    max_wei_per_nullifier=1_600_000_000_000_000,
    max_wei_global=200_000_000_000_000_000,
)


def _decide(**overrides):
    args = dict(
        balance=0,
        target=30_000_000_000_000,
        wallet_drips_today=0,
        wallet_wei_today=0,
        nullifier_wei_today=0,
        global_wei_today=0,
        funder_balance=10**18,
        limits=LIMITS,
    )
    args.update(overrides)
    return decide(**args)


# ── sizing ──────────────────────────────────────────────────────────────────


class TestDripTarget:
    def test_scales_with_the_fee(self):
        low = drip_target_wei(GWEI // 200, LIMITS)  # Base's usual 0.005 gwei
        high = drip_target_wei(GWEI // 20, LIMITS)  # a 10x spike
        assert high > low

    def test_a_fee_spike_cannot_scale_the_drip_without_limit(self):
        # The ceiling is what keeps a gas spike from turning cent-sized drips
        # into real money, one wallet at a time.
        assert drip_target_wei(1_000 * GWEI, LIMITS) == LIMITS.max_target

    def test_a_zero_fee_read_still_funds_a_usable_amount(self):
        # Some RPCs return 0 for baseFeePerGas on quiet L2 blocks; funding
        # nothing would strand the user just as effectively as refusing.
        assert drip_target_wei(0, LIMITS) == LIMITS.min_target

    def test_base_at_its_normal_fee_lands_around_a_few_cents(self):
        # 0.005 gwei x 1.5M gas x 4 = 3e13 wei. At ~$1,886/ETH that is ~$0.057,
        # roughly four full journeys. Pinned because a change here changes what
        # every user costs.
        assert drip_target_wei(5_000_000, LIMITS) == 30_000_000_000_000

    def test_floor_is_half_the_target(self):
        assert floor_wei(30_000_000_000_000) == 15_000_000_000_000


# ── the decision ────────────────────────────────────────────────────────────


class TestDecide:
    def test_funds_an_empty_wallet_up_to_the_target(self):
        d = _decide(balance=0, target=30_000_000_000_000)
        assert d.fund
        assert d.amount == 30_000_000_000_000

    def test_tops_up_only_the_shortfall(self):
        d = _decide(balance=10_000_000_000_000, target=30_000_000_000_000)
        assert d.amount == 20_000_000_000_000

    def test_leaves_a_wallet_above_the_floor_alone(self):
        d = _decide(balance=15_000_000_000_000, target=30_000_000_000_000)
        assert not d.fund
        assert d.reason == "sufficient_balance"

    def test_a_funded_wallet_asking_again_does_not_burn_its_allowance(self):
        # sufficient_balance is checked before the caps on purpose: a client
        # that asks on every page load must not exhaust the user's day.
        d = _decide(
            balance=30_000_000_000_000,
            wallet_drips_today=LIMITS.max_drips_per_wallet,
        )
        assert d.reason == "sufficient_balance"

    def test_stops_at_the_per_wallet_count(self):
        d = _decide(wallet_drips_today=LIMITS.max_drips_per_wallet)
        assert not d.fund
        assert d.reason == "wallet_daily_count_reached"

    def test_stops_at_the_per_wallet_budget(self):
        d = _decide(wallet_wei_today=LIMITS.max_wei_per_wallet)
        assert d.reason == "wallet_daily_budget_reached"

    def test_one_human_spreading_over_wallets_shares_one_budget(self):
        # The nullifier is per-(tenant, human). Without this cap, a verified
        # user could drain the faucet a fresh wallet at a time.
        d = _decide(nullifier_wei_today=LIMITS.max_wei_per_nullifier)
        assert d.reason == "identity_daily_budget_reached"

    def test_global_breaker_stops_everyone(self):
        d = _decide(global_wei_today=LIMITS.max_wei_global)
        assert d.reason == "global_daily_budget_reached"

    def test_trims_to_whatever_headroom_is_left(self):
        d = _decide(
            target=30_000_000_000_000,
            wallet_wei_today=LIMITS.max_wei_per_wallet - 5_000_000_000_000,
        )
        assert d.fund
        assert d.amount == 5_000_000_000_000

    def test_refuses_rather_than_emptying_itself(self):
        d = _decide(target=30_000_000_000_000, funder_balance=1_000)
        assert not d.fund
        assert d.reason == "faucet_empty"

    def test_never_sends_a_negative_amount(self):
        d = _decide(balance=40_000_000_000_000, target=30_000_000_000_000)
        assert d.amount == 0


# ── attestation ─────────────────────────────────────────────────────────────

# Base Sepolia — matching the deployment INTEGRATOR below actually lives on.
# This used to say 8453 (mainnet) against the Sepolia address, which made every
# signature-domain test assert a (chainId, verifyingContract) pair that exists
# on no chain. The tests passed anyway because both sides used the same wrong
# pair — worth remembering when reading any "parity" test. (#83)
CHAIN_ID = 84532
INTEGRATOR = "0x6e2Feec8434de08732D7ed5A0cDDd748dEFbB032"
TYPES = {
    "KycAttestation": [
        {"name": "wallet", "type": "address"},
        {"name": "nullifier", "type": "bytes32"},
        {"name": "limit", "type": "uint256"},
        {"name": "expiry", "type": "uint256"},
    ]
}


def _sign(signer, *, wallet, nullifier=b"\x11" * 32, limit=100_000_000, expiry=None,
          chain_id=CHAIN_ID, integrator=INTEGRATOR):
    expiry = expiry if expiry is not None else int(time.time()) + 3600
    signable = encode_typed_data(
        domain_data={
            "name": "KycVerifier",
            "version": "1",
            "chainId": chain_id,
            "verifyingContract": integrator,
        },
        message_types=TYPES,
        message_data={
            "wallet": wallet,
            "nullifier": nullifier,
            "limit": limit,
            "expiry": expiry,
        },
    )
    signed = signer.sign_message(signable)
    return Attestation(
        wallet=wallet,
        nullifier="0x" + nullifier.hex(),
        limit=limit,
        expiry=expiry,
        signature="0x" + signed.signature.hex(),
    )


class TestAttestation:
    @pytest.fixture
    def attestor(self):
        return Account.from_key("0x" + "11" * 32)

    @pytest.fixture
    def user(self):
        return Account.from_key("0x" + "22" * 32)

    def test_recovers_the_signer(self, attestor, user):
        att = _sign(attestor, wallet=user.address)
        assert recover_attestor(att, chain_id=CHAIN_ID, integrator=INTEGRATOR) == attestor.address

    def test_accepts_a_good_attestation(self, attestor, user):
        att = _sign(attestor, wallet=user.address)
        check_attestation(
            att,
            chain_id=CHAIN_ID,
            integrator=INTEGRATOR,
            attestor=attestor.address,
            now=int(time.time()),
        )

    def test_rejects_a_signature_from_anyone_else(self, attestor, user):
        impostor = Account.from_key("0x" + "33" * 32)
        att = _sign(impostor, wallet=user.address)
        with pytest.raises(InvalidAttestation, match="attestor"):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_one_minted_for_a_different_integrator(self, attestor, user):
        # verifyingContract binding. Without it, an attestation issued for any
        # other P2P integrator would unlock this faucet's budget.
        other = "0x9c64B3B4e0F0C4A0E8b0F1A2B3c4D5e6F7080910"
        att = _sign(attestor, wallet=user.address, integrator=other)
        with pytest.raises(InvalidAttestation):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_one_minted_for_a_different_chain(self, attestor, user):
        att = _sign(attestor, wallet=user.address, chain_id=8453)
        with pytest.raises(InvalidAttestation):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_a_wallet_swap(self, attestor, user):
        # The signature binds the wallet, so redirecting the drip means
        # re-signing — which the attacker cannot do.
        att = _sign(attestor, wallet=user.address)
        swapped = Attestation(
            wallet="0x000000000000000000000000000000000000dEaD",
            nullifier=att.nullifier,
            limit=att.limit,
            expiry=att.expiry,
            signature=att.signature,
        )
        with pytest.raises(InvalidAttestation):
            check_attestation(
                swapped, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_a_limit_zero_attestation(self, attestor, user):
        # The attestor should never sign limit 0 — the funded wallet could
        # never buy. Reaching the contract would only surface it when the user
        # first tries to purchase; refusing here surfaces it at the source. (#80)
        att = _sign(attestor, wallet=user.address, limit=0)
        with pytest.raises(InvalidAttestation, match="limit"):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_an_expired_attestation(self, attestor, user):
        att = _sign(attestor, wallet=user.address, expiry=1_000)
        with pytest.raises(InvalidAttestation, match="expired"):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_treats_expiry_exactly_as_the_contract_does(self, attestor, user):
        # The contract reverts on `block.timestamp >= expiry`, so the instant
        # of expiry is already too late. Funding inside a window the contract
        # has closed spends money on a submit that will revert.
        expiry = 2_000_000_000
        att = _sign(attestor, wallet=user.address, expiry=expiry)
        with pytest.raises(InvalidAttestation, match="expired"):
            check_attestation(
                att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=expiry,
            )
        check_attestation(
            att, chain_id=CHAIN_ID, integrator=INTEGRATOR,
            attestor=attestor.address, now=expiry - 1,
        )

    def test_rejects_a_malleated_signature(self, attestor, user):
        # The contract refuses high-s signatures, so accepting one here would
        # fund a wallet whose submit then reverts InvalidSignature.
        att = _sign(attestor, wallet=user.address)
        raw = bytes.fromhex(att.signature[2:])
        n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
        s = int.from_bytes(raw[32:64], "big")
        flipped = raw[:32] + (n - s).to_bytes(32, "big") + bytes([raw[64] ^ 1])
        with pytest.raises(InvalidAttestation, match="high s"):
            check_attestation(
                Attestation(att.wallet, att.nullifier, att.limit, att.expiry,
                            "0x" + flipped.hex()),
                chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )

    def test_rejects_a_truncated_signature(self, attestor, user):
        att = _sign(attestor, wallet=user.address)
        with pytest.raises(InvalidAttestation, match="65 bytes"):
            check_attestation(
                Attestation(att.wallet, att.nullifier, att.limit, att.expiry, "0xdead"),
                chain_id=CHAIN_ID, integrator=INTEGRATOR,
                attestor=attestor.address, now=int(time.time()),
            )


# ── the ledger ──────────────────────────────────────────────────────────────


class TestStore:
    @pytest.fixture
    def store(self, tmp_path):
        return Store(str(tmp_path / "t.db"))

    def test_counts_today_only(self, store):
        now = utc_day_start() + 3_600
        store.record(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, tx_hash=None, now=now)
        store.record(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, tx_hash=None, now=now - 86_400)
        usage = store.usage(wallet="0xA", nullifier="0xN", now=now)
        assert usage.wallet_drips == 1
        assert usage.wallet_wei == 100

    def test_sums_one_identity_across_wallets(self, store):
        now = utc_day_start() + 3_600
        store.record(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, tx_hash=None, now=now)
        store.record(chain_id=8453, wallet="0xB", nullifier="0xN",
                     amount_wei=250, tx_hash=None, now=now)
        usage = store.usage(wallet="0xB", nullifier="0xN", now=now)
        assert usage.wallet_wei == 250   # this wallet only
        assert usage.nullifier_wei == 350  # the human, across both

    def test_is_case_insensitive_about_addresses(self, store):
        now = utc_day_start() + 60
        store.record(chain_id=8453, wallet="0xAbCd", nullifier=None,
                     amount_wei=7, tx_hash=None, now=now)
        assert store.usage(wallet="0xABCD", nullifier=None, now=now).wallet_wei == 7

    def test_wallet_and_identity_sums_are_scoped_per_chain(self, store):
        # The same address exists on every chain with independent balances;
        # pooling one wallet's allowance across chains would under-fund a
        # legitimate cross-chain user. The GLOBAL sum stays unscoped on
        # purpose — one process, one key, one float.
        now = utc_day_start() + 60
        store.record(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, tx_hash=None, now=now)
        store.record(chain_id=84532, wallet="0xA", nullifier="0xN",
                     amount_wei=40, tx_hash=None, now=now)

        base = store.usage(wallet="0xA", nullifier="0xN", chain_id=8453, now=now)
        assert base.wallet_wei == 100
        assert base.nullifier_wei == 100
        sepolia = store.usage(wallet="0xA", nullifier="0xN", chain_id=84532, now=now)
        assert sepolia.wallet_wei == 40
        # the float breaker sees both
        assert base.global_wei == 140

    def test_fees_count_toward_every_cap(self, store):
        # A drip's transaction fee is real spend from the same float. Booked
        # after the receipt, summed with the amount — otherwise real spend
        # exceeds booked spend by a number the recipient's receive() code
        # helps choose.
        now = utc_day_start() + 60
        store.record(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, tx_hash="0xT1", now=now)
        store.record_fee("0xT1", 7)
        usage = store.usage(wallet="0xA", nullifier="0xN", chain_id=8453, now=now)
        assert usage.wallet_wei == 107
        assert usage.nullifier_wei == 107
        assert usage.global_wei == 107

    def test_a_missing_fee_books_as_zero(self, store):
        now = utc_day_start() + 60
        store.record(chain_id=8453, wallet="0xA", nullifier=None,
                     amount_wei=100, tx_hash="0xT2", now=now)
        assert store.usage(wallet="0xA", nullifier=None, chain_id=8453, now=now).wallet_wei == 100

    def test_global_total_spans_every_wallet(self, store):
        now = utc_day_start() + 60
        store.record(chain_id=8453, wallet="0xA", nullifier=None,
                     amount_wei=10, tx_hash=None, now=now)
        store.record(chain_id=8453, wallet="0xB", nullifier=None,
                     amount_wei=20, tx_hash=None, now=now)
        assert store.usage(wallet="0xC", nullifier=None, now=now).global_wei == 30


# ── the per-identity ledger key ─────────────────────────────────────────────


class TestCanonicalNullifier:
    """`bytes.fromhex` is permissive enough that the raw request string is not
    a safe ledger key: whitespace is ignored and case does not matter, so one
    identity could hold unlimited distinct budget rows just by respelling its
    own nullifier — and the per-human cap would never bind."""

    CANON = "0x" + "ab" * 32

    @pytest.mark.parametrize(
        "spelling",
        [
            "ab" * 32,
            "0x" + "ab" * 32,
            "0X" + "ab" * 32,
            "AB" * 32,
            "0x" + "Ab" * 32,
            " ".join(["ab"] * 32),
            "\t".join(["ab"] * 32),
        ],
    )
    def test_every_spelling_collapses_to_one_key(self, spelling):
        assert canonical_nullifier(spelling) == self.CANON

    def test_the_permissiveness_this_defends_against_is_real(self):
        # Guard the premise: if bytes.fromhex ever stops ignoring whitespace,
        # this test should be the thing that notices.
        assert bytes.fromhex(" ".join(["ab"] * 32)) == bytes.fromhex("ab" * 32)

    def test_rejects_the_wrong_length(self):
        with pytest.raises(InvalidAttestation, match="32 bytes"):
            canonical_nullifier("0xabcd")

    def test_rejects_non_hex(self):
        with pytest.raises(InvalidAttestation, match="not hex"):
            canonical_nullifier("0x" + "zz" * 32)

    def test_distinct_identities_stay_distinct(self):
        assert canonical_nullifier("ab" * 32) != canonical_nullifier("cd" * 32)
