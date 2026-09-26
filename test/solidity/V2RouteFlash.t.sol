// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ArbitrageExecutor, InvalidFlashLoanCallback, InsufficientFlashLoanRepayment} from "../../Contract/NArb.sol";
import {SplitToken, SplitV2Pool} from "./NArbSplit.t.sol";
import {TaxToken} from "./TransferFees.t.sol";

contract V2RouteFlashTest {
    SplitToken private a;
    TaxToken private b;
    ArbitrageExecutor private executor;
    SplitV2Pool private buy;
    SplitV2Pool private sell;

    function setUp() public {
        a = new SplitToken();
        b = new TaxToken();
        executor = new ArbitrageExecutor(address(this), address(a));
        buy = new SplitV2Pool(a, SplitToken(address(b)), 1_000_000, 1_000_000);
        sell = new SplitV2Pool(a, SplitToken(address(b)), 2_000_000, 1_000_000);
    }

    function route() private view returns (address[] memory pools, uint256[] memory fees) {
        pools = new address[](2); pools[0] = address(buy); pools[1] = address(sell);
        fees = new uint256[](2); fees[0] = 30; fees[1] = 30;
    }

    function testRouteFlashKeepsPoolSpecificTaxAndSavesSeparateLenderFee() public {
        b.setFee(address(buy), address(executor), 2200);
        b.setFee(address(executor), address(sell), 1000);
        b.setFee(address(buy), address(sell), 10000);
        (address[] memory pools, uint256[] memory fees) = route();
        uint256 firstOut = uint256(10000) * 9970 * 1000000 / (1000000 * 10000 + 10000 * 9970);
        uint256 received = firstOut - firstOut * 2200 / 10000;
        uint256 sellCredit = received - received * 1000 / 10000;
        uint256 finalOut = sellCredit * 9970 * 2000000 / (1000000 * 10000 + sellCredit * 9970);

        executor.executeV2RouteFlash(address(a), 10000, pools, fees);
        require(a.balanceOf(address(executor)) == finalOut - 10000, "wrong route profit");
        require(a.balanceOf(address(buy)) == 1010000, "first pair not repaid");
    }

    function testCannotRepayFromExistingInventory() public {
        (address[] memory pools, uint256[] memory fees) = route();
        a.mint(address(executor), 100000);
        // Removing the profitable sell pool makes the route unable to earn its repayment.
        pools[1] = address(new SplitV2Pool(a, SplitToken(address(b)), 500000, 1000000));
        (bool ok, bytes memory reason) = address(executor).call(
            abi.encodeCall(executor.executeV2RouteFlash, (address(a), 10000, pools, fees))
        );
        require(!ok && bytes4(reason) == InsufficientFlashLoanRepayment.selector, "old inventory spent");
        require(a.balanceOf(address(executor)) == 100000, "old inventory changed");
    }

    function testRejectsUnsolicitedCallback() public {
        (bool ok, bytes memory reason) = address(executor).call(
            abi.encodeWithSignature("uniswapV2Call(address,uint256,uint256,bytes)", address(executor), 0, 1, hex"")
        );
        require(!ok && bytes4(reason) == InvalidFlashLoanCallback.selector, "unsolicited callback accepted");
    }
}
