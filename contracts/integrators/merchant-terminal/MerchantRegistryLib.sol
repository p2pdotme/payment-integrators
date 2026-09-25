// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { MerchantTypes } from "./MerchantTypes.sol";

/**
 * @title MerchantRegistryLib
 * @notice Currency packing and registration validation, extracted from
 *         `MerchantTerminalIntegrator` into an external (delegatecall) library.
 *
 * WHY THIS IS A LIBRARY, NOT INLINE CODE
 * Same reason as PaymentLinksLib, one step further along. The integrator sat at
 * 24,515 of the 24,576-byte EIP-170 ceiling — 61 bytes of headroom — and
 * hardhat.config.ts already recorded the prediction that "the next change to
 * this contract will hit the ceiling again". It did: adding the merchant→links
 * index put it 533 bytes over, and lowering the optimizer to `runs: 1` still
 * left it 258 over while raising gas on every function in the contract.
 *
 * So the pure, self-contained parts of registration move out here. These were
 * good candidates because they touch NO custody state: two `pure` codecs and
 * one `pure` validator. The withdrawal and fund-helper sections are the larger
 * prize (~44% of the contract) but they are audited custody code and belong in
 * their own reviewed change.
 *
 * Because these are `public` library functions they are reached by DELEGATECALL,
 * so behaviour is identical and only the code's location changes.
 */
library MerchantRegistryLib {
    error InvalidCurrency();
    error BusinessSectorRequired();
    error LimitOutOfBounds();

    event PerTxCapSet(bytes32 indexed currency, uint256 cap);
    event LimitBoundsSet(uint256 minDaily, uint256 maxDaily, uint256 minCap, uint256 maxCap);

    // ─── Merchant limits and their range (PR #108 review #4) ──────────
    //
    // FINANCE admins, owners and the super-admin set a [min, max] range
    // (setBounds); MANAGER admins and above set the limits inside it
    // (setPerTxCap, checkDailyLimit). Two tiers so a MANAGER can move a limit
    // but never its max. Here rather than in the integrator for size only.

    /// @dev Per-tx cap when no override is set: India 50 USDC, elsewhere 100.
    uint256 internal constant PER_TX_CAP_INR = 50 * 1e6;
    uint256 internal constant PER_TX_CAP_DEFAULT = 100 * 1e6;

    /// @notice The per-tx cap for `currency`: the override if set, else the
    ///         default — always pulled inside [minCap, maxCap], so narrowing the
    ///         range takes effect at once for defaults and existing overrides.
    function perTxCap(
        mapping(bytes32 => uint256) storage overrides,
        MerchantTypes.LimitBounds storage b,
        bytes32 currency
    ) public view returns (uint256 cap) {
        cap = overrides[currency];
        if (cap == 0) cap = currency == bytes32("INR") ? PER_TX_CAP_INR : PER_TX_CAP_DEFAULT;
        if (cap > b.maxCap) cap = b.maxCap;
        if (cap < b.minCap) cap = b.minCap;
    }

    /// @notice Set (cap > 0) or clear (cap = 0) a currency's per-tx cap. A set
    ///         cap must be inside [minCap, maxCap].
    function setPerTxCap(
        mapping(bytes32 => uint256) storage overrides,
        MerchantTypes.LimitBounds storage b,
        bytes32 currency,
        uint256 cap
    ) public {
        if (currency == bytes32(0)) revert InvalidCurrency();
        if (cap != 0 && (cap < b.minCap || cap > b.maxCap)) revert LimitOutOfBounds();
        overrides[currency] = cap;
        emit PerTxCapSet(currency, cap);
    }

    /// @notice Reverts unless `limit` is inside [minDaily, maxDaily]. minDaily is
    ///         at least 1, so a 0 limit (which would block every order) never passes.
    function checkDailyLimit(MerchantTypes.LimitBounds storage b, uint256 limit) public view {
        if (limit < b.minDaily || limit > b.maxDaily) revert LimitOutOfBounds();
    }

    /// @notice Set the range, and return `dailyLimit` pulled inside it (the
    ///         caller stores it if it changed).
    function setBounds(
        MerchantTypes.LimitBounds storage b,
        uint256 minDaily,
        uint256 maxDaily,
        uint256 minCap,
        uint256 maxCap,
        uint256 dailyLimit
    ) public returns (uint256) {
        if (
            minDaily == 0 ||
            minDaily > maxDaily ||
            maxDaily > type(uint64).max ||
            minCap == 0 ||
            minCap > maxCap ||
            maxCap > type(uint64).max
        ) revert LimitOutOfBounds();
        b.minDaily = uint64(minDaily);
        b.maxDaily = uint64(maxDaily);
        b.minCap = uint64(minCap);
        b.maxCap = uint64(maxCap);
        emit LimitBoundsSet(minDaily, maxDaily, minCap, maxCap);
        if (dailyLimit > maxDaily) return maxDaily;
        if (dailyLimit < minDaily) return minDaily;
        return dailyLimit;
    }

    /**
     * @notice Pack a currency code string ("INR") into the bytes32 the Diamond
     *         uses. Reverts on empty / >31 chars.
     */
    function toCurrency(string memory code) public pure returns (bytes32 out) {
        bytes memory b = bytes(code);
        if (b.length == 0 || b.length > 31) revert InvalidCurrency();
        // Reject interior NUL bytes so the value always round-trips through
        // fromCurrency (which truncates at the first NUL). Otherwise "IN\0R"
        // would store distinctly yet display as "IN", and two merchants could
        // register codes that render identically but route to different circles.
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == 0) revert InvalidCurrency();
        }
        assembly {
            out := mload(add(b, 32))
        }
    }

    /// @notice Unpack a bytes32 currency back to its readable code string.
    function fromCurrency(bytes32 cur) public pure returns (string memory) {
        uint256 len = 0;
        while (len < 32 && cur[len] != 0) {
            len++;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = cur[i];
        }
        return string(out);
    }

    /**
     * @notice Validate the fields a registration supplies, or revert.
     *
     * @dev Pure: it reads and writes no state. The caller does the storage
     *      writes, so nothing about custody or accounting moves out of the
     *      integrator.
     *
     *      Currency bytes must be uppercase A-Z (ISO-4217 style): see the loop.
     *
     *      AUDIT (MED), preserved verbatim from the inline version: enforce
     *      CANONICAL bytes32 form on BOTH entry points — left-aligned code,
     *      zero-padded, no non-zero byte after the first NUL. `toCurrency`
     *      already guarantees this; without the same check here,
     *      `registerMerchantRaw` could smuggle "INR\0<junk>": it displays as
     *      "INR" via fromCurrency but fails the `== bytes32("INR")` compare in
     *      perTxCap, self-granting the 100 USDC default cap instead of INR's 50
     *      (and dodging any admin setPerTxCap("INR") override).
     *
     *      NOTE what is NOT checked here: `encPayoutId` being non-empty. It used
     *      to be required at registration. It is now optional — see
     *      `MerchantTerminalIntegrator.withdrawFiat`, which requires it at the
     *      point the money actually needs somewhere to land.
     */
    function validateRegistration(bytes32 currency, bytes32 businessSector) public pure {
        if (currency == bytes32(0)) revert InvalidCurrency();

        bool seenNul = false;
        for (uint256 i = 0; i < 32; i++) {
            bytes1 c = currency[i];
            if (c == 0) {
                seenNul = true;
            } else if (seenNul || c < 0x41 || c > 0x5A) {
                // Uppercase A-Z only (audit 2026-09 L-2). "inr" used to register
                // as its own currency, distinct from "INR" — and perTxCap's
                // == bytes32("INR") compare then fell through to the 100 USDC
                // default instead of INR's 50.
                revert InvalidCurrency();
            }
        }

        validateSector(businessSector);
    }

    /**
     * @notice The business-sector rule, shared by registration and profile edits.
     * @dev Required, and canonical-form checked for the same reason the currency
     *      is: "Retail" followed by a NUL and junk renders as "Retail" via
     *      fromCurrency while comparing unequal to bytes32("Retail"), so two
     *      merchants could hold sectors that look identical and are not.
     *
     *      bytes32, not string: a dynamic string measured ~550 bytes of bytecode
     *      across the storage write, the generated getter and the event, on a
     *      contract that had 61 bytes of headroom. 31 characters covers every
     *      real label, and fromCurrency already decodes it for display.
     */
    function validateSector(bytes32 businessSector) public pure {
        if (businessSector == bytes32(0)) revert BusinessSectorRequired();
        bool sectorNul = false;
        for (uint256 i = 0; i < 32; i++) {
            if (businessSector[i] == 0) {
                sectorNul = true;
            } else if (sectorNul) {
                revert BusinessSectorRequired();
            }
        }
    }
}
