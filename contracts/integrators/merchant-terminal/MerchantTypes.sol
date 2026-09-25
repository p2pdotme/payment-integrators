// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @title MerchantTypes
 * @notice The merchant-side storage structs, lifted out of
 *         `MerchantTerminalIntegrator` so external (delegatecall) libraries can
 *         name them.
 *
 * WHY THIS FILE EXISTS
 * A library that takes `mapping(address => Merchant) storage` needs the struct
 * to be visible to it, and a struct declared inside the contract is not. Moving
 * the declarations here is the mechanical prerequisite for moving any merchant
 * code into a library — which the integrator now requires, because it reached
 * the EIP-170 ceiling with 61 bytes to spare.
 *
 * NOTHING ABOUT LAYOUT CHANGES. These are the same fields in the same order, so
 * every storage slot resolves exactly where it did. Only the declaration site
 * moves.
 */
library MerchantTypes {
    struct SettlementBucket {
        uint256 amount;
        uint256 unlockTimestamp;
    }

    struct Merchant {
        address merchantAddr;
        // ENCRYPTED payout handle. The raw UPI / PIX / CBU / alias must NEVER be
        // stored on-chain in plaintext (public-chain PII leak). The app encrypts
        // the handle CLIENT-SIDE to the merchant's relay pubkey before sending it
        // here; the contract treats it as an opaque blob it never decodes. The
        // LP/app decrypts off-chain when building the payout.
        //
        // MAY BE EMPTY: optional at registration, required by `_checkWithdraw`.
        bytes encPayoutId;
        string shopName;
        bytes32 currency; // offramp currency, e.g. bytes32("INR"|"BRL"|"ARS") — set once at registration
        uint256 totalDeposited;
        bool isFrozen;
        uint256 dailyTxCount;
        uint256 lastTxDate;
        uint256 inFlightWithdrawals; // count of this merchant's unsettled SELL withdrawals
        // UNIX time this merchant was CONTINUOUSLY frozen since (set on freeze,
        // cleared to 0 on unfreeze). Drives the 90-day dormant-account escheat:
        // adminEscheat is only reachable once (now - frozenAt) >= ESCHEAT_PERIOD.
        // Placed AFTER inFlightWithdrawals (index 9) so the public `merchants`
        // getter's earlier positional fields (0..8, which the frontend ABI reads)
        // are unchanged; the trailing `buckets` array is omitted by the getter.
        uint256 frozenAt;
        // Merchant's line of business, packed into bytes32 (up to 31 chars),
        // required at registration. Placed AFTER frozenAt (index 9) for the same
        // reason frozenAt went after inFlightWithdrawals: the earlier positional
        // fields the frontend reads stay where they are. PUBLIC and PERMANENT —
        // never put anything sensitive here.
        bytes32 businessSector;
        SettlementBucket[] buckets;
    }

    /// @dev The range the merchant limits must stay within (PR #108 review #4).
    ///      Set by FINANCE admins / owners; MANAGER admins move the limits
    ///      inside it. Caps are USDC 6-decimals and apply to every currency.
    struct LimitBounds {
        uint64 minDaily;
        uint64 maxDaily;
        uint64 minCap;
        uint64 maxCap;
    }
}
