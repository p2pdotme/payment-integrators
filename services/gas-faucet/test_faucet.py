"""Tests for the parts of the faucet that decide to spend money.

The chain client is not tested here — it is a thin RPC wrapper, and the
interesting failures all live in the policy and in the attestation check.
"""

from __future__ import annotations

import time

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

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
# Gone, deliberately. This file used to re-test an off-chain EIP-712
# verifier (attestation.py) that duplicated the contract's checks — domain,
# typehash, expiry, low-s, wallet binding, canonical nullifier spelling. The
# sponsored-submission contract change deleted that module: the faucet now
# submits attestations to the CHAIN, which is the only verifier, simulating
# first so invalid ones cost nothing. The behavioural coverage lives in
# test_app.py::TestSubmitEndpoint against the service, and in
# test/own-integrator.test.ts against the contract itself.

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
