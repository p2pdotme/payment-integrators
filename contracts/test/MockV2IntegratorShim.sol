// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { UserProxyV2 } from "../base/UserProxyV2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockV2IntegratorShim {
    IERC20 public immutable usdc;
    address public immutable diamond;
    bool private _deprecated;

    constructor(IERC20 _usdc, address _diamond) {
        usdc = _usdc;
        diamond = _diamond;
    }

    function deprecated() external view returns (bool) {
        return _deprecated;
    }

    function setDeprecated(bool v) external {
        _deprecated = v;
    }

    function callInitialize(address proxy) external {
        UserProxyV2(payable(proxy)).initialize();
    }

    function callExecute(
        address proxy,
        address target,
        uint256 /* value — reserved for future payable upgrade */,
        bytes calldata data,
        address usdcAddr,
        uint256 allowance
    ) external {
        UserProxyV2(payable(proxy)).execute(target, data, usdcAddr, allowance);
    }

    function callNotifyCashbackCredit(address proxy) external {
        UserProxyV2(payable(proxy)).notifyCashbackCredit();
    }

    function callSweepStale(address proxy, address to) external {
        UserProxyV2(payable(proxy)).sweepStale(to);
    }
}
