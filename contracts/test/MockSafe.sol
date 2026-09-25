// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test double for a Safe multisig: exposes getThreshold/getOwners (what the
///      deploy tooling checks) and a minimal `exec` that forwards a call once
///      `threshold` distinct owners have approved it.
contract MockSafe {
    address[] private _owners;
    uint256 private _threshold;
    mapping(address => bool) public isSafeOwner;
    mapping(bytes32 => mapping(address => bool)) public approved;
    mapping(bytes32 => uint256) public approvals;

    constructor(address[] memory owners_, uint256 threshold_) {
        require(threshold_ > 0 && threshold_ <= owners_.length, "threshold");
        _owners = owners_;
        _threshold = threshold_;
        for (uint256 i; i < owners_.length; i++) isSafeOwner[owners_[i]] = true;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    /// Approve (and, at threshold, execute) `data` on `to`. `nonce` separates repeats.
    function exec(address to, bytes calldata data, uint256 nonce) external {
        require(isSafeOwner[msg.sender], "not owner");
        bytes32 id = keccak256(abi.encode(to, data, nonce));
        require(!approved[id][msg.sender], "dup");
        approved[id][msg.sender] = true;
        if (++approvals[id] == _threshold) {
            (bool ok, bytes memory ret) = to.call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
