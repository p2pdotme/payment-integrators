// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

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
            if (currency[i] == 0) {
                seenNul = true;
            } else if (seenNul) {
                revert InvalidCurrency();
            }
        }

        // Required, per the integration request. Unlike the payout handle there
        // is no later point at which this becomes necessary, so there is no
        // deferred check to fall back on — it is required here or nowhere.
        //
        // bytes32, not string. A sector label is short ("Food & Beverage",
        // "Professional Services"), and a dynamic string costs real bytecode on
        // a contract that had 61 bytes of headroom: the storage copy, the ABI
        // encoder in the generated `merchants` getter, and the event encoding
        // all grow. Measured at ~550 bytes for this one field. bytes32 holds 31
        // characters, which covers every real label, and `fromCurrency` above
        // already gives callers a bytes32→string decoder to render it with.
        if (businessSector == bytes32(0)) revert BusinessSectorRequired();

        // Same canonical-form rule as the currency, for the same reason: without
        // it "Retail\0<junk>" would display as "Retail" via fromCurrency while
        // comparing unequal to bytes32("Retail"), so two merchants could hold
        // sectors that render identically but are distinct values — and any
        // future rule that keys off the sector would silently miss one of them.
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
