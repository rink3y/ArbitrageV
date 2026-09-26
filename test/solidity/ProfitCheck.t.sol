// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ArbitrageExecutor, ICarbonController, NoProfit, InsufficientProfitAfterGas, InsufficientFlashLoanRepayment} from "../../Contract/NArb.sol";
import {SplitToken, SplitV3Pool} from "./NArbSplit.t.sol";

interface ProfitVm {
    function txGasPrice(uint256) external;
}

// Fixed fills isolate the final profit policy from market quoting. These are not fork tests.
contract ProfitSwap {
    uint256 public output;
    constructor(uint256 amount) { output = amount; }
    function setOutput(uint256 amount) external { output = amount; }
    function tradeBySourceAmount(address source, address target, ICarbonController.TradeAction[] calldata actions, uint256, uint128) external returns (uint128) {
        uint256 input;
        for (uint256 i; i < actions.length; ++i) input += actions[i].amount;
        SplitToken(source).transferFrom(msg.sender, address(this), input);
        SplitToken(target).mint(msg.sender, output);
        return uint128(output);
    }
}

contract ProfitLender {
    address public token0;
    address public token1;
    uint256 public gasAfterRepayment;
    constructor(SplitToken a, SplitToken b) {
        token0 = address(a); token1 = address(b); a.mint(address(this), 100 ether);
    }
    function setGasAfterRepayment(uint256 amount) external { gasAfterRepayment = amount; }
    function swap(uint256 amount, uint256 amount1, address to, bytes calldata data) external {
        require(amount1 == 0, "wrong token");
        SplitToken token = SplitToken(token0);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.transfer(to, amount);
        (bool ok, bytes memory reason) = to.call(abi.encodeWithSignature("uniswapV2Call(address,uint256,uint256,bytes)", msg.sender, amount, 0, data));
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        require(token.balanceOf(address(this)) >= beforeBalance + (amount * 15 + 9984) / 9985, "not repaid");
        // A check inside the callback would miss this lender work.
        uint256 stopAt = gasleft() - gasAfterRepayment;
        while (gasleft() > stopAt) {}
    }
}

contract ProfitCheckTest {
    ProfitVm constant vm = ProfitVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SplitToken private token;
    SplitToken private intermediate;
    ArbitrageExecutor private executor;
    ProfitLender private lender;
    ProfitSwap private buy;
    ProfitSwap private sell;

    function setUp() public {
        token = new SplitToken(); intermediate = new SplitToken();
        executor = new ArbitrageExecutor(address(this), address(token));
        lender = new ProfitLender(token, intermediate);
        buy = new ProfitSwap(1 ether); sell = new ProfitSwap(0);
        vm.txGasPrice(1 gwei);
    }

    function repayment(uint256 borrowed) private pure returns (uint256) {
        return borrowed + (borrowed * 15 + 9984) / 9985;
    }

    function linearPlan(uint256 borrowed) private view returns (ArbitrageExecutor.ArbParams memory p) {
        p.flashPool = address(lender); p.borrowToken = address(token); p.borrowAmount = borrowed; p.v2RepayFee = 15;
        p.pools = new address[](2); p.pools[0] = address(buy); p.pools[1] = address(sell);
        p.protocols = new uint8[](2); p.protocols[0] = 2; p.protocols[1] = 2;
        p.fees = new uint256[](2); p.data = new bytes[](2);
        p.data[0] = abi.encode(uint256(1), address(token), address(intermediate));
        p.data[1] = abi.encode(uint256(1), address(intermediate), address(token));
    }

    function splitPlan(uint256 borrowed) private view returns (ArbitrageExecutor.SplitParams memory p) {
        p.flashPool = address(lender); p.borrowToken = address(token); p.borrowAmount = borrowed; p.v2RepayFee = 15;
        p.deadline = block.timestamp;
        p.stages = new ArbitrageExecutor.SplitStage[](2);
        p.stages[0].tokenIn = address(token); p.stages[0].tokenOut = address(intermediate);
        p.stages[1].tokenIn = address(intermediate); p.stages[1].tokenOut = address(token);
        p.stages[0].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[1].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(buy), 2, 0, borrowed, 1 ether,
            abi.encode(uint256(1), address(token), address(intermediate)));
        p.stages[1].branches[0] = ArbitrageExecutor.SplitBranch(address(sell), 2, 0, 1 ether, 1,
            abi.encode(uint256(1), address(intermediate), address(token)));
    }

    function payload(bool split, uint256 borrowed) private view returns (bytes memory) {
        return split ? abi.encodeCall(executor.executeSplitArbitrage, (splitPlan(borrowed)))
            : abi.encodeCall(executor.executeArbitrage, (linearPlan(borrowed)));
    }

    function testTraceOneLinearKeepsProfitBelowOldQuotedMinimum() public { traceOne(false); }
    function testTraceOneSplitKeepsProfitBelowOldQuotedMinimum() public { traceOne(true); }
    function traceOne(bool split) private {
        uint256 borrowed = 2328470935338368842;
        sell.setOutput(3339427529943367068);
        vm.txGasPrice(1000 gwei); lender.setGasAfterRepayment(300000);
        token.mint(address(executor), 777);
        // A five-million gas limit would cost 5 native tokens if charged as the limit.
        (bool ok,) = address(executor).call{gas: 5_000_000}(payload(split, borrowed));
        require(ok, "profitable trade rejected");
        require(token.balanceOf(address(executor)) == 777 + 1007458641271991162, "profit or old balance");
        require(token.balanceOf(address(lender)) == 100 ether + 3497953333007064, "flash fee");
    }

    function testTraceTwoLinearRejectsProfitBelowGas() public { traceTwo(false); }
    function testTraceTwoSplitRejectsProfitBelowGas() public { traceTwo(true); }
    function traceTwo(bool split) private {
        uint256 borrowed = 2159585574104778025;
        sell.setOutput(2358147382005785166);
        vm.txGasPrice(1000 gwei); lender.setGasAfterRepayment(300000);
        token.mint(address(executor), 1 ether);
        (bool ok, bytes memory reason) = address(executor).call(payload(split, borrowed));
        require(!ok, "gas loss accepted");
        (uint256 profit, uint256 gasCost) = gasFailure(reason);
        require(profit == 195317563172757599 && gasCost > profit, "wrong gas error");
        require(token.balanceOf(address(executor)) == 1 ether, "old balance spent");
        require(token.balanceOf(address(lender)) == 100 ether && token.balanceOf(address(buy)) == 0, "not rolled back");
    }

    function testOtherTokenLinearAcceptsOneUnitDespiteNativeGasCost() public { otherToken(true, false); }
    function testOtherTokenSplitAcceptsOneUnitDespiteNativeGasCost() public { otherToken(true, true); }
    function testOtherTokenLinearRejectsZeroSurplus() public { otherToken(false, false); }
    function testOtherTokenSplitRejectsZeroSurplus() public { otherToken(false, true); }
    function otherToken(bool profitable, bool split) private {
        executor = new ArbitrageExecutor(address(this), address(intermediate));
        vm.txGasPrice(1 ether);
        sell.setOutput(repayment(1 ether) + (profitable ? 1 : 0));
        token.mint(address(executor), 777);
        (bool ok, bytes memory reason) = address(executor).call(payload(split, 1 ether));
        require(ok == profitable, "other-token policy");
        if (!ok) require(bytes4(reason) == NoProfit.selector, "wrong zero-profit error");
        require(token.balanceOf(address(executor)) == (profitable ? 778 : 777), "old token balance");
    }

    function testWrappedTokenRejectsZeroSurplusEvenWithFreeGas() public {
        vm.txGasPrice(0); sell.setOutput(repayment(1 ether));
        (bool ok, bytes memory reason) = address(executor).call(payload(false, 1 ether));
        require(!ok && bytes4(reason) == NoProfit.selector, "zero profit accepted");
    }

    function testWrappedTokenAcceptsOneUnitWithFreeGas() public {
        vm.txGasPrice(0); sell.setOutput(repayment(1 ether) + 1);
        executor.executeArbitrage(linearPlan(1 ether));
        require(token.balanceOf(address(executor)) == 1, "free gas profit");
    }

    function testCannotRepayFromOldInventory() public {
        sell.setOutput(repayment(1 ether) - 1); token.mint(address(executor), 2 ether);
        (bool ok, bytes memory reason) = address(executor).call(payload(false, 1 ether));
        require(!ok && bytes4(reason) == InsufficientFlashLoanRepayment.selector, "wrong repayment error");
        require(token.balanceOf(address(executor)) == 2 ether, "old inventory spent");
    }

    function testGasCheckIncludesPostCallbackLenderWorkAndIntrinsicGas() public {
        sell.setOutput(repayment(1 ether) + 1);
        lender.setGasAfterRepayment(300000);
        bytes memory data = payload(false, 1 ether);
        uint256 beforeCall = gasleft();
        (bool ok, bytes memory reason) = address(executor).call(data);
        uint256 callGas = beforeCall - gasleft();
        require(!ok, "gas loss accepted");
        (, uint256 gasCost) = gasFailure(reason);
        require(gasCost / tx.gasprice >= callGas + 21000, "undercharged execution or intrinsic gas");
        require(gasCost / tx.gasprice > 300000 + 21000, "lender tail missed");
    }

    function testGasCheckCoversCalldataFloor() public {
        sell.setOutput(repayment(1 ether) + 1);
        bytes memory data = bytes.concat(payload(false, 1 ether), new bytes(20000));
        (bool ok, bytes memory reason) = address(executor).call(data);
        require(!ok, "gas loss accepted");
        (, uint256 gasCost) = gasFailure(reason);
        require(gasCost >= (21000 + data.length * 40) * tx.gasprice, "calldata floor missed");
    }

    function testV3FlashAlsoUsesFinalProfitCheck() public {
        SplitV3Pool v3 = new SplitV3Pool(token, intermediate);
        token.mint(address(v3), 100 ether);
        ArbitrageExecutor.ArbParams memory p = linearPlan(1 ether);
        p.flashPool = address(v3); p.flashProtocol = 1;
        sell.setOutput(1.1 ether + 1);
        executor.executeArbitrage(p);
        require(token.balanceOf(address(executor)) == 0.1 ether, "V3 net token surplus");
        require(token.balanceOf(address(v3)) == 100 ether + 100001, "V3 repayment");
    }

    function gasFailure(bytes memory reason) private pure returns (uint256 profit, uint256 gasCost) {
        require(reason.length == 68 && bytes4(reason) == InsufficientProfitAfterGas.selector, "wrong gas error selector");
        assembly {
            profit := mload(add(reason, 36))
            gasCost := mload(add(reason, 68))
        }
    }
}
