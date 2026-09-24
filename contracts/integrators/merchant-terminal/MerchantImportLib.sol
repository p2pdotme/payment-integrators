// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import { MerchantTypes } from "./MerchantTypes.sol";

/**
 * @title MerchantImportLib
 * @notice Carries a merchant's registration over from a PREVIOUS integrator, so
 *         a contract upgrade never makes merchants register again.
 *
 * WHY
 * Every upgrade deploys a fresh integrator with an empty registry. Without this,
 * every merchant had to register again — and a merchant FROZEN on the old
 * contract could simply register fresh on the new one and walk out of the
 * freeze. Here the new integrator reads the merchant's record from the previous
 * integrators (newest first) and copies it, INCLUDING the frozen flag.
 *
 * WHAT IS COPIED
 *   shop name, currency, encrypted payout handle, business sector, frozen flag.
 * NOT copied: balances (funds stay on the old contract and are withdrawn there),
 * daily counters, links, in-flight withdrawals. A frozen merchant's `frozenAt`
 * restarts at import time, so the escheat window on the new contract is
 * measured from when it first knew about them.
 *
 * TRUST
 * The previous addresses are set once by the super-admin (see the integrator's
 * setPreviousIntegrators) and are OUR OWN earlier deployments. Reads are raw
 * staticcalls that never revert this call: an address that is not a contract,
 * reverts, or returns something unexpected is simply skipped.
 *
 * VERSION TOLERANCE
 * `merchants(address)` is decoded as its leading six fields, which have the
 * same shape on every integrator version. The business sector exists only on
 * newer versions; on the oldest one `getMerchantInfo` returns five values, so
 * the sixth word is garbage. The sector is therefore validated with the same
 * rule registration uses, and replaced with "Unspecified" when it fails — the
 * merchant can correct it later with updateProfile.
 *
 * Reached by DELEGATECALL (public functions), so every storage reference is
 * the integrator's and events are emitted from the integrator's address.
 */
library MerchantImportLib {
    /// @notice A merchant's record was copied from a previous integrator.
    event MerchantImported(address indexed merchant, address indexed fromIntegrator, bool frozen);

    event PreviousIntegratorsSet(address[] previous);

    error AlreadyRegistered();
    error InvalidAddress();

    bytes32 internal constant UNSPECIFIED_SECTOR = bytes32("Unspecified");

    /// @notice Set the previous integrators once: 1-5 addresses, non-zero, not
    ///         this contract. Reverts AlreadyRegistered if already set.
    function setPrevious(address[] storage previous, address[] calldata list) public {
        if (previous.length != 0) revert AlreadyRegistered();
        if (list.length == 0 || list.length > 5) revert InvalidAddress();
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == address(0) || list[i] == address(this)) revert InvalidAddress();
            previous.push(list[i]);
        }
        emit PreviousIntegratorsSet(list);
    }

    /**
     * @notice Copy `merchant` from the newest previous integrator that has them.
     * @return imported true if a record was copied; false if the merchant is
     *         already registered here or on none of `previous`.
     */
    function importFrom(
        mapping(address => MerchantTypes.Merchant) storage merchants,
        mapping(address => bool) storage registered,
        address[] storage previous,
        address merchant
    ) public returns (bool imported) {
        if (registered[merchant]) return false;
        uint256 n = previous.length;
        for (uint256 i = 0; i < n; i++) {
            address prev = previous[i];
            if (!_isRegisteredOn(prev, merchant)) continue;

            (bool ok, bytes memory ret) = prev.staticcall(
                abi.encodeWithSignature("merchants(address)", merchant)
            );
            if (!ok || ret.length < 6 * 32) continue;
            (
                ,
                bytes memory encPayoutId,
                string memory shopName,
                bytes32 currency,
                ,
                bool frozen
            ) = abi.decode(ret, (address, bytes, string, bytes32, uint256, bool));

            MerchantTypes.Merchant storage m = merchants[merchant];
            m.merchantAddr = merchant;
            m.encPayoutId = encPayoutId;
            m.shopName = shopName;
            m.currency = currency;
            m.businessSector = _sectorOn(prev, merchant);
            if (frozen) {
                m.isFrozen = true;
                m.frozenAt = block.timestamp;
            }
            registered[merchant] = true;
            emit MerchantImported(merchant, prev, frozen);
            return true;
        }
        return false;
    }

    function _isRegisteredOn(address prev, address merchant) private view returns (bool) {
        (bool ok, bytes memory ret) = prev.staticcall(
            abi.encodeWithSignature("registered(address)", merchant)
        );
        // Exactly one word holding 1 — anything else (no code, revert, junk)
        // counts as "not registered there".
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    /// @dev The sector from getMerchantInfo's sixth word, if it is a valid label.
    ///      Read raw rather than abi-decoded: on the oldest version there is no
    ///      sixth value and a strict decode could revert the whole call.
    function _sectorOn(address prev, address merchant) private view returns (bytes32 sector) {
        (bool ok, bytes memory ret) = prev.staticcall(
            abi.encodeWithSignature("getMerchantInfo(address)", merchant)
        );
        if (ok && ret.length >= 6 * 32) {
            assembly {
                sector := mload(add(ret, 192)) // 32 (length) + 5 * 32
            }
            if (_isLabel(sector)) return sector;
        }
        return UNSPECIFIED_SECTOR;
    }

    /// @dev Registration's own rule for a bytes32 label (non-empty, left-aligned,
    ///      nothing after the first NUL) plus printable bytes. Offsets and
    ///      lengths — what the garbage word actually is — always fail it.
    function _isLabel(bytes32 b) private pure returns (bool) {
        if (b == bytes32(0) || b[0] == 0) return false;
        bool seenNul = false;
        for (uint256 i = 0; i < 32; i++) {
            bytes1 c = b[i];
            if (c == 0) {
                seenNul = true;
            } else if (seenNul || uint8(c) < 0x20 || uint8(c) == 0x7f) {
                return false;
            }
        }
        return true;
    }
}
