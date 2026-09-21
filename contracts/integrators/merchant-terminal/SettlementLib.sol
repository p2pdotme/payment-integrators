// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { MerchantTypes } from "./MerchantTypes.sol";

/**
 * @title SettlementLib
 * @notice The settlement-bucket fund helpers, extracted from
 *         MerchantTerminalIntegrator into an external (delegatecall) library.
 *
 * WHY THIS MOVED
 * hardhat.config.ts named this exact refactor as the structural answer to the
 * integrator's EIP-170 problem: "move the withdrawal / fund-helper sections into
 * their own library". The integrator had 61 bytes of headroom and the two
 * requested features (a merchant->links index, a required business sector) need
 * roughly 700 more.
 *
 * Two earlier attempts are recorded so nobody retries them. Lowering the
 * optimizer to runs: 1 left it 258 bytes over while raising gas on every
 * function in the contract. Moving the merchant VIEW functions out made it WORSE
 * by 330 bytes: they return bytes, string and dynamic arrays, and encoding those
 * across a delegatecall boundary costs more than reading them inline. The
 * helpers here are the right shape for the opposite reason — simple value
 * arguments, and nothing dynamic crossing the boundary.
 *
 * WHAT DID NOT MOVE, AND WHY
 * totalOwed. Solidity cannot pass a uint256 storage pointer to a plain state
 * variable, and wrapping it in a struct to make it passable would relocate the
 * one number the solvency invariant is written against. So creditBucket RETURNS
 * what it credited and the integrator adds it to totalOwed itself: the global
 * accounting stays in the contract that owns it, and this library's job is only
 * the bucket array.
 *
 * Because these are public library functions they are reached by DELEGATECALL,
 * so every storage reference resolves in the INTEGRATOR's storage. The merge
 * logic below is the audited version, copied rather than rewritten — including
 * the round-1 FIX D and round-2 #7 comments, which record two real bugs found in
 * exactly this code.
 */
library SettlementLib {
    error InsufficientAvailableBalance();

    /// @dev Bucket-array cap. Mirrors the integrator's public constant of the
    ///      same name; both must stay in step, and the integrator keeps its own
    ///      so the value stays readable on-chain.
    uint256 internal constant MAX_BUCKETS = 256;

    function creditBucket(
        MerchantTypes.Merchant storage m,
        uint256 amount,
        uint256 unlockTimestamp
    ) public returns (uint256 credited) {
        if (amount == 0) return 0;
        credited = amount;
        compact(m);
        // Fold into an existing bucket sharing this unlock window if present.
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp == unlockTimestamp) {
                m.buckets[i].amount += amount;
                return credited;
            }
        }
        // No matching window — must append. If at the cap, fold the new credit
        // into an existing bucket rather than revert: this keeps the credit path
        // infallible (a completed deposit can ALWAYS be recorded).
        //
        // AUDIT FIX D (round 1) + #7 (round 2): the merge must never move funds
        // across the locked/unlocked boundary in EITHER direction — it must not
        // re-lock a merchant's already-spendable principal (the round-1 concern),
        // and it must not make a still-locked incoming credit spendable early (the
        // round-2 regression). We enforce that by folding ONLY into a bucket whose
        // lock-state MATCHES the incoming credit:
        //   • incoming LOCKED   → fold into the oldest still-LOCKED bucket, adopting
        //     max(hostTs, incomingTs) so neither unlocks earlier than intended.
        //   • incoming UNLOCKED → fold into the oldest already-UNLOCKED bucket,
        //     leaving its (past) timestamp untouched — both stay spendable.
        if (m.buckets.length >= MAX_BUCKETS) {
            bool incomingLocked = unlockTimestamp >= block.timestamp;
            // Find the oldest bucket whose lock-state MATCHES the incoming credit.
            uint256 target = type(uint256).max;
            uint256 targetTs = type(uint256).max;
            for (uint256 i = 0; i < len; i++) {
                uint256 ts = m.buckets[i].unlockTimestamp;
                bool bucketLocked = ts >= block.timestamp;
                if (bucketLocked == incomingLocked && ts < targetTs) {
                    targetTs = ts;
                    target = i;
                }
            }
            if (target != type(uint256).max) {
                // Same-state merge: locked→locked adopts the later unlock (never
                // early); unlocked→unlocked keeps the past timestamp (stays
                // spendable). The timestamp bump only ever applies to a locked
                // host, so it can never re-lock already-spendable principal.
                if (incomingLocked && unlockTimestamp > m.buckets[target].unlockTimestamp) {
                    m.buckets[target].unlockTimestamp = unlockTimestamp;
                }
                m.buckets[target].amount += amount;
                return credited;
            }
            // BUG FIX (#7 fallback): no same-state host exists (all 256 buckets are
            // the OPPOSITE lock-state). Folding into a mismatched bucket would
            // corrupt fund availability — re-locking incoming unlocked funds, or
            // re-locking a host's already-spendable principal (the exact bugs #7/D
            // fixed). Instead, coalesce the two oldest SAME-state EXISTING buckets
            // (all buckets share the opposite state, so a same-state pair always
            // exists) to free one slot, then append the incoming credit as its own
            // correctly-timestamped bucket. Every bucket keeps its true lock-state;
            // nothing is re-locked or unlocked early. This is a rare cap edge (256
            // buckets all one state, incoming the other, no exact-ts match).
            uint256 a = type(uint256).max;
            uint256 aTs = type(uint256).max;
            uint256 b = type(uint256).max;
            uint256 bTs = type(uint256).max;
            for (uint256 i = 0; i < len; i++) {
                uint256 ts = m.buckets[i].unlockTimestamp; // all are !incomingLocked here
                if (ts < aTs) {
                    b = a;
                    bTs = aTs;
                    a = i;
                    aTs = ts;
                } else if (ts < bTs) {
                    b = i;
                    bTs = ts;
                }
            }
            // Merge b into a using the safe (later) timestamp — both share the
            // opposite lock-state, so max() never crosses the locked/unlocked line.
            if (bTs > aTs) m.buckets[a].unlockTimestamp = bTs;
            m.buckets[a].amount += m.buckets[b].amount;
            m.buckets[b].amount = 0;
            compact(m); // drop the now-zeroed slot, freeing room to append
        }
        m.buckets.push(
            MerchantTypes.SettlementBucket({ amount: amount, unlockTimestamp: unlockTimestamp })
        );
    }

    /// @dev Removes ALL fully-spent (amount == 0) buckets, preserving order of
    ///      the live ones. A stable compaction: spent buckets can appear
    ///      anywhere (a locked bucket can sit in front of a spent unlocked
    ///      one), so a head-only pass would leave interior zeros and let the
    ///      array drift toward MAX_BUCKETS. This pass reclaims every zero.
    function compact(MerchantTypes.Merchant storage m) public {
        uint256 len = m.buckets.length;
        uint256 write = 0;
        for (uint256 read = 0; read < len; read++) {
            if (m.buckets[read].amount != 0) {
                if (write != read) {
                    m.buckets[write] = m.buckets[read];
                }
                write++;
            }
        }
        // Pop the tail left after compaction (len - write spent slots).
        while (m.buckets.length > write) {
            m.buckets.pop();
        }
    }

    /**
     * @notice Deduct `amount` from a merchant's UNLOCKED buckets, oldest first.
     * @dev Reverts `InsufficientAvailableBalance` if the unlocked total is short.
     *      Buckets are pushed chronologically, so index order IS age order.
     *
     *      Does not touch `totalOwed` — see this file's header. The caller
     *      decrements it after this returns, which is safe because a shortfall
     *      reverts here before any state changes.
     */
    function deductUnlocked(MerchantTypes.Merchant storage m, uint256 amount) public {
        uint256 unlocked = 0;
        uint256 len = m.buckets.length;
        for (uint256 i = 0; i < len; i++) {
            if (m.buckets[i].unlockTimestamp < block.timestamp) {
                unlocked += m.buckets[i].amount;
            }
        }
        if (unlocked < amount) revert InsufficientAvailableBalance();

        uint256 remaining = amount;
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            MerchantTypes.SettlementBucket storage b = m.buckets[i];
            if (b.unlockTimestamp >= block.timestamp || b.amount == 0) continue;
            uint256 take = b.amount < remaining ? b.amount : remaining;
            b.amount -= take;
            remaining -= take;
        }
    }
}
