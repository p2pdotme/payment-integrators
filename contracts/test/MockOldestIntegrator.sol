// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/**
 * @dev Test-only stand-in for the OLDEST deployed MerchantTerminalIntegrator
 *      (Base Sepolia 0x10A0…): same `registered` / `merchants` getters, but no
 *      business sector, and a getMerchantInfo that returns FIVE values. Used to
 *      prove MerchantImportLib copies such a merchant correctly and does not
 *      mistake the missing sector for a real one.
 */
contract MockOldestIntegrator {
    struct Merchant {
        address merchantAddr;
        bytes encPayoutId;
        string shopName;
        bytes32 currency;
        uint256 totalDeposited;
        bool isFrozen;
        uint256 dailyTxCount;
    }

    mapping(address => Merchant) public merchants;
    mapping(address => bool) public registered;

    function seed(
        address who,
        bytes calldata encPayoutId,
        string calldata shopName,
        bytes32 currency,
        bool frozen
    ) external {
        merchants[who] = Merchant(who, encPayoutId, shopName, currency, 0, frozen, 0);
        registered[who] = true;
    }

    function getMerchantInfo(
        address who
    ) external view returns (bytes memory, string memory, bytes32, bool, bool) {
        Merchant storage m = merchants[who];
        return (m.encPayoutId, m.shopName, m.currency, registered[who], m.isFrozen);
    }
}
