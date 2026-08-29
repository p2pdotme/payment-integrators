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


class TestDripCoversTheWalletTip:
    """The drip must cover what a WALLET charges to sign: `gas ×
    (base_fee × multiple + priority_tip)`. At Base's floor base fee the tip is
    most of that, so a pure `base_fee × multiple` drip lands short — this is the
    bug that stranded no-gas MetaMask wallets. These pin the tip term.
    """

    TIP = 20_000_000  # 0.02 gwei — a consumer wallet's priority floor
    L = Limits(
        gas_units=2_200_000,
        safety_factor=2,
        wallet_tip_wei=TIP,
        min_target=10_000_000_000_000,
        max_target=400_000_000_000_000,
        max_drips_per_wallet=4,
        max_wei_per_wallet=800_000_000_000_000,
        max_wei_per_nullifier=1_600_000_000_000_000,
        max_wei_global=200_000_000_000_000_000,
    )

    def test_target_adds_the_tip_term_on_top_of_the_multiple(self):
        base = 5_000_000  # Base's floor base fee
        pure = self.L.gas_units * base * self.L.safety_factor  # old formula
        assert drip_target_wei(base, self.L) == pure + self.L.gas_units * self.TIP

    def test_one_drip_covers_a_wallets_buyusdc_reservation_at_the_floor(self):
        # A ~2M-gas buyUsdc priced at maxFee = base×2 + tip must be affordable
        # from a single drip — the whole point of the fix.
        base = 5_000_000
        reservation = 2_000_000 * (base * self.L.safety_factor + self.TIP)
        assert drip_target_wei(base, self.L) >= reservation

    def test_tip_still_funds_a_usable_amount_when_base_fee_reads_zero(self):
        # Even at base_fee 0 the tip alone provisions a real amount, where the
        # old formula collapsed to just min_target.
        assert drip_target_wei(0, self.L) == self.L.gas_units * self.TIP

    def test_tip_zero_reproduces_the_old_pure_multiple_formula(self):
        # The rollback guarantee: tip=0 ⇒ identical to `base × gas × multiple`.
        base = 5_000_000
        old_style = Limits(
            gas_units=1_500_000,
            safety_factor=5,
            wallet_tip_wei=0,
            min_target=10_000_000_000_000,
            max_target=400_000_000_000_000,
            max_drips_per_wallet=4,
            max_wei_per_wallet=800_000_000_000_000,
            max_wei_per_nullifier=1_600_000_000_000_000,
            max_wei_global=200_000_000_000_000_000,
        )
        assert drip_target_wei(base, old_style) == base * 1_500_000 * 5


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
        store.reserve(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, now=now)
        store.reserve(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, now=now - 86_400)
        usage = store.usage(wallet="0xA", nullifier="0xN", now=now)
        assert usage.wallet_drips == 1
        assert usage.wallet_wei == 100

    def test_sums_one_identity_across_wallets(self, store):
        now = utc_day_start() + 3_600
        store.reserve(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, now=now)
        store.reserve(chain_id=8453, wallet="0xB", nullifier="0xN",
                     amount_wei=250, now=now)
        usage = store.usage(wallet="0xB", nullifier="0xN", now=now)
        assert usage.wallet_wei == 250   # this wallet only
        assert usage.nullifier_wei == 350  # the human, across both

    def test_is_case_insensitive_about_addresses(self, store):
        now = utc_day_start() + 60
        store.reserve(chain_id=8453, wallet="0xAbCd", nullifier=None,
                     amount_wei=7, now=now)
        assert store.usage(wallet="0xABCD", nullifier=None, now=now).wallet_wei == 7

    def test_wallet_and_identity_sums_are_scoped_per_chain(self, store):
        # The same address exists on every chain with independent balances;
        # pooling one wallet's allowance across chains would under-fund a
        # legitimate cross-chain user. The GLOBAL sum stays unscoped on
        # purpose — one process, one key, one float.
        now = utc_day_start() + 60
        store.reserve(chain_id=8453, wallet="0xA", nullifier="0xN",
                     amount_wei=100, now=now)
        store.reserve(chain_id=84532, wallet="0xA", nullifier="0xN",
                     amount_wei=40, now=now)

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
        drip_id = store.reserve(chain_id=8453, wallet="0xA", nullifier="0xN",
                                amount_wei=100, now=now)
        store.record_fee(drip_id, 7)
        usage = store.usage(wallet="0xA", nullifier="0xN", chain_id=8453, now=now)
        assert usage.wallet_wei == 107
        assert usage.nullifier_wei == 107
        assert usage.global_wei == 107

    def test_a_missing_fee_books_as_zero(self, store):
        now = utc_day_start() + 60
        store.reserve(chain_id=8453, wallet="0xA", nullifier=None,
                     amount_wei=100, now=now)
        assert store.usage(wallet="0xA", nullifier=None, chain_id=8453, now=now).wallet_wei == 100

    def test_global_total_spans_every_wallet(self, store):
        now = utc_day_start() + 60
        store.reserve(chain_id=8453, wallet="0xA", nullifier=None,
                     amount_wei=10, now=now)
        store.reserve(chain_id=8453, wallet="0xB", nullifier=None,
                     amount_wei=20, now=now)
        assert store.usage(wallet="0xC", nullifier=None, now=now).global_wei == 30
