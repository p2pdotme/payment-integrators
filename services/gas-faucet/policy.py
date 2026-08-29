"""How much gas to hand out, and whether to hand out any at all.

Pure functions. No chain, no database, no clock — everything they need is an
argument, so the rules can be tested exhaustively and read in one sitting.
That matters more here than in most modules: this file is the only thing
standing between a funded hot wallet and anyone who can call the API.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Limits:
    """Every ceiling the faucet enforces, in wei unless named otherwise."""

    #: Gas units a full first journey burns — attestation, buy, mark-paid.
    gas_units: int
    #: Base-fee MULTIPLE the drip provisions for — a wallet's maxFeePerGas is
    #: roughly `base_fee * this + a fixed priority tip`, so this is the
    #: proportional half of that fee model.
    safety_factor: int
    #: Clamp on the computed target. The ceiling is the important one: it is
    #: what stops a gas spike turning each drip into a real amount of money.
    min_target: int
    max_target: int
    #: Per-wallet, per-UTC-day.
    max_drips_per_wallet: int
    max_wei_per_wallet: int
    #: Per-human, per-UTC-day. A nullifier is per-(tenant, human), so this is
    #: the ceiling that survives one person spreading drips over many wallets.
    max_wei_per_nullifier: int
    #: Whole-faucet circuit breaker.
    max_wei_global: int
    #: Fixed priority-tip a consumer wallet adds ON TOP of the base fee, in
    #: wei-per-gas. This is the ADDITIVE half of the wallet's fee model, and at
    #: Base's floor base fee (~0.005 gwei) it DOMINATES: a wallet's maxFeePerGas
    #: is mostly this tip, not the base fee. A pure `base_fee * multiple` drip
    #: has no term for it and so systematically under-funds when base fee is low
    #: — no constant multiple can track a fixed additive as base fee varies.
    #: `0` reproduces the old pure-multiple formula exactly (used for rollback).
    wallet_tip_wei: int = 0


@dataclass(frozen=True)
class Decision:
    fund: bool
    amount: int
    reason: str


def drip_target_wei(base_fee_wei: int, limits: Limits) -> int:
    """What a funded wallet should hold, at the current gas price.

    Derived rather than configured. A fixed wei constant is wrong within a
    week: too small after any fee rise (users strand mid-order, which is the
    exact failure this service exists to prevent) and needlessly generous the
    rest of the time. Clamped at both ends so neither a zero-fee read nor a
    spike can distort it.

    Modelled on what a WALLET actually charges to sign — `gas_units * per_gas`,
    where `per_gas = base_fee * multiple + priority_tip` — rather than the
    naive `base_fee * gas_units * multiple`. The tip term is the fix: at Base's
    floor base fee the tip is most of the fee, so a pure-multiple drip lands
    below what any wallet (MetaMask especially) demands to sign, and no
    constant multiple can cover it across base-fee levels. With
    `wallet_tip_wei == 0` this reduces to the old formula exactly.
    """
    per_gas = base_fee_wei * limits.safety_factor + limits.wallet_tip_wei
    target = limits.gas_units * per_gas
    return max(limits.min_target, min(target, limits.max_target))


def floor_wei(target: int) -> int:
    """Below this, top up; at or above it, leave the wallet alone.

    Half the target, so a wallet oscillates between one and two journeys'
    worth instead of being topped up a few wei at a time on every request.
    """
    return target // 2


def decide(
    *,
    balance: int,
    target: int,
    wallet_drips_today: int,
    wallet_wei_today: int,
    nullifier_wei_today: int,
    global_wei_today: int,
    funder_balance: int,
    limits: Limits,
) -> Decision:
    """Fund this wallet, or say precisely why not.

    Order matters: the cheap local checks come first so an abusive caller is
    turned away before it costs a transaction, and `sufficient_balance` is
    checked before the caps so a well-funded wallet asking repeatedly never
    burns its own daily allowance.
    """
    if balance >= floor_wei(target):
        return Decision(False, 0, "sufficient_balance")

    if wallet_drips_today >= limits.max_drips_per_wallet:
        return Decision(False, 0, "wallet_daily_count_reached")

    amount = target - balance

    remaining_wallet = limits.max_wei_per_wallet - wallet_wei_today
    if remaining_wallet <= 0:
        return Decision(False, 0, "wallet_daily_budget_reached")

    remaining_nullifier = limits.max_wei_per_nullifier - nullifier_wei_today
    if remaining_nullifier <= 0:
        return Decision(False, 0, "identity_daily_budget_reached")

    remaining_global = limits.max_wei_global - global_wei_today
    if remaining_global <= 0:
        return Decision(False, 0, "global_daily_budget_reached")

    # Trim rather than refuse: a partial top-up still gets this user further
    # than nothing, and the caps stay honest.
    amount = min(amount, remaining_wallet, remaining_nullifier, remaining_global)

    if funder_balance <= amount:
        return Decision(False, 0, "faucet_empty")

    if amount <= 0:
        return Decision(False, 0, "nothing_to_send")

    return Decision(True, amount, "funded")
