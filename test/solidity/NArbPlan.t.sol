// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import {ArbitrageExecutor, InvalidV3SwapDelta, InvalidWrappedNativeToken} from "../../Contract/NArb.sol";
import {SplitToken, SplitWrappedToken, SplitV2Pool, SplitV3Pool, SplitCarbon, SplitVm} from "./NArbSplit.t.sol";

contract PlanStablePool is SplitV2Pool {
    constructor(SplitToken a, SplitToken b) SplitV2Pool(a, b, 1000 ether, 2000 ether) {}
    function metadata() external view returns (uint256, uint256, uint256, uint256, bool, address, address) {
        (uint112 x, uint112 y,) = this.getReserves();
        return (1 ether, 1 ether, x, y, true, token0, token1);
    }
}

contract BatchFailurePool {
    address public token0;
    address public token1;
    bool private exhaust;
    constructor(address a, address b, bool exhaust_) { token0 = a; token1 = b; exhaust = exhaust_; }
    function getReserves() external view returns (uint112, uint112, uint32) {
        if (exhaust) assembly { invalid() }
        bytes memory reason = new bytes(65536);
        assembly { revert(add(reason, 32), mload(reason)) }
    }
}

interface BatchVm is SplitVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function txGasPrice(uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract NArbPlanTest {
    BatchVm constant vm = BatchVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SplitWrappedToken a;
    SplitWrappedToken b;
    ArbitrageExecutor executor;
    SplitV2Pool pool;

    function setUp() public {
        a = new SplitWrappedToken(); b = new SplitWrappedToken();
        executor = new ArbitrageExecutor(address(this), address(a));
        executor.setWrapper(address(b), true);
        pool = new SplitV2Pool(a, b, 1000000, 2000000);
        vm.deal(address(b), 3000000);
    }

    function plan(address first, uint8 protocol) private view returns (ArbitrageExecutor.Plan memory p) {
        p.deadline = block.timestamp; p.routeSwap = true;
        p.route.borrowToken = address(a); p.route.borrowAmount = 1000;
        p.route.pools = new address[](1); p.route.pools[0] = first;
        p.route.protocols = new uint8[](1); p.route.protocols[0] = protocol;
        p.route.fees = new uint256[](1); p.route.fees[0] = 30;
        p.route.data = new bytes[](1); p.route.data[0] = hex"02";
    }

    function testSingleSwapSettlesAnotherWrapperAndProtectsInventory() public {
        a.mint(address(executor), 111); b.mint(address(executor), 222);
        vm.deal(address(executor), 333);
        executor.executePlan(plan(address(pool), 0));
        require(a.balanceOf(address(executor)) > 111, "no profit");
        require(b.balanceOf(address(executor)) == 222, "old output spent");
        require(address(executor).balance == 333, "old native spent");
    }

    function testUnapprovedWrapperRevertsAtomically() public {
        executor.setWrapper(address(b), false);
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executePlan, (plan(address(pool), 0))));
        require(!ok && a.balanceOf(address(pool)) == 1000000 && b.balanceOf(address(pool)) == 2000000, "not atomic");
    }

    function testV3SwapFundsOppositeTokenAndRejectsPartialOrRepeatedCallback() public {
        SplitV3Pool v3 = new SplitV3Pool(a, b);
        executor.executePlan(plan(address(v3), 1));
        require(a.balanceOf(address(executor)) == 1000, "wrong V3 funding profit");
        for (uint256 mode = 1; mode <= 3; ++mode) {
            v3.setMode(mode);
            (bool ok,) = address(executor).call(abi.encodeCall(executor.executePlan, (plan(address(v3), 1))));
            require(!ok && a.balanceOf(address(executor)) == 1000, "invalid callback spent inventory");
        }
    }

    function testBatchKeepsEachIndependentOutcomeAndExistingInventory() public {
        for (uint256 mask; mask < 4; ++mask) {
            setUp();
            SplitV2Pool second = new SplitV2Pool(a, b, 1000000, 2000000);
            a.mint(address(executor), 111); b.mint(address(executor), 222);
            vm.deal(address(executor), 333);
            ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
            plans[0] = plan(address(pool), 0); plans[1] = plan(address(second), 0);
            if (mask & 1 == 0) plans[0].route.borrowAmount = 10000000;
            if (mask & 2 == 0) plans[1].route.borrowAmount = 10000000;
            vm.recordLogs();
            require(executor.executeBatch{gas: 1500000}(plans, 500000) == mask, "wrong outcomes");
            BatchVm.Log[] memory logs = vm.getRecordedLogs();
            require(logs.length == 2, "missing attempt results");
            for (uint256 i; i < logs.length; ++i) {
                require(logs[i].emitter == address(executor) && logs[i].topics[0] == keccak256("BatchAttempt(uint256,bool)"), "wrong event");
                require(uint256(logs[i].topics[1]) == i && abi.decode(logs[i].data, (bool)) == (mask & (1 << i) != 0), "wrong attempt result");
            }
            uint256 wins = (mask & 1) + ((mask >> 1) & 1);
            require(a.balanceOf(address(executor)) == 111 + wins * 992, "success lost or old inventory spent");
            require(a.balanceOf(address(pool)) == 1000000 + (mask & 1) * 1000, "A not isolated");
            require(a.balanceOf(address(second)) == 1000000 + ((mask >> 1) & 1) * 1000, "B not isolated");
            require(b.balanceOf(address(executor)) == 222 && address(executor).balance == 333, "old balances changed");
            executor.executePlan(plan(address(pool), 0)); // Locks and callback context are clean.
        }
    }

    function testBatchFailureCannotConsumeLaterGasOrCopyUnboundedRevertData() public {
        for (uint256 mode; mode < 2; ++mode) {
            SplitV2Pool second = new SplitV2Pool(a, b, 1000000, 2000000);
            ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](3);
            plans[0] = plan(address(pool), 0);
            plans[1] = plan(address(new BatchFailurePool(address(a), address(b), mode == 0)), 0);
            plans[2] = plan(address(second), 0);
            require(executor.executeBatch{gas: 2000000}(plans, 500000) == 5, "failure stopped later plan");
            require(a.balanceOf(address(second)) == 1001000, "last plan did not repay");
        }
    }

    function testBatchAllowsDifferentStartTokens() public {
        SplitV2Pool second = new SplitV2Pool(b, a, 1000000, 2000000);
        vm.deal(address(a), 3000000);
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(second), 0);
        plans[1].route.borrowToken = address(b);
        require(executor.executeBatch(plans, 500000) == 3, "different tokens failed");
        require(a.balanceOf(address(executor)) == 992 && b.balanceOf(address(executor)) == 992, "wrong profits");
    }

    function testSuccessfulPlanCannotSubsidizeAnotherPlansGasCheck() public {
        SplitV2Pool rich = new SplitV2Pool(a, b, 1000000 ether, 2000000 ether);
        vm.deal(address(b), 3000000 ether);
        vm.txGasPrice(1 gwei);
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(rich), 0); plans[0].route.borrowAmount = 1000 ether;
        plans[1] = plan(address(pool), 0); // Positive raw surplus, but not enough for its gas.
        require(executor.executeBatch(plans, 500000) == 1, "batch subsidized uneconomic plan");
        require(a.balanceOf(address(executor)) > 900 ether, "A profit lost");
        require(a.balanceOf(address(pool)) == 1000000, "B changes survived");
    }

    function testBatchRejectsUnauthenticatedEntryAndInsufficientOuterGasBeforeTrading() public {
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(pool), 0);
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeBatchPlan, (plans[0])));
        require(!ok, "owner entered internal batch plan");
        vm.prank(address(executor));
        (ok,) = address(executor).call(abi.encodeCall(executor.executeBatchPlan, (plans[0])));
        require(!ok, "self call outside batch accepted");
        vm.prank(address(123));
        (ok,) = address(executor).call(abi.encodeCall(executor.executeBatch, (plans, 500000)));
        require(!ok, "nonowner submitted batch");
        (ok,) = address(executor).call{gas: 300000}(abi.encodeCall(executor.executeBatch, (plans, 500000)));
        require(!ok && a.balanceOf(address(pool)) == 1000000, "inadequate outer gas traded");
        plans = new ArbitrageExecutor.Plan[](0);
        (ok,) = address(executor).call(abi.encodeCall(executor.executeBatch, (plans, 500000)));
        require(!ok, "empty batch accepted");
    }

    function testBatchOwnerCannotReenter() public {
        ArbitrageExecutor owned = new ArbitrageExecutor(address(pool), address(a));
        pool.startWithReentry(address(owned), abi.encodeCall(owned.setWrapper, (address(b), true)));
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(pool), 0);
        pool.startWithReentry(address(owned), abi.encodeCall(owned.executeBatch, (plans, 500000)));
        require(a.balanceOf(address(owned)) > 1900, "outer attempts failed instead of rejecting reentry");
    }

    function testAllDeployableModulesFitCodeSizeLimit() public view {
        require(address(executor).code.length <= 24576, "NArb too large");
        require(address(executor.v2Logic()).code.length > 0, "missing V2 module");
        require(address(executor.v3Logic()).code.length > 0, "missing V3 module");
        require(address(executor.carbonLogic()).code.length > 0, "missing Carbon module");
        require(address(executor.v2Logic()).code.length <= 24576, "V2 too large");
        require(address(executor.v3Logic()).code.length <= 24576, "V3 too large");
        require(address(executor.carbonLogic()).code.length <= 24576, "Carbon too large");
    }

    function testStableFirstSwapUsesStableQuoteAndWrapperSettlement() public {
        PlanStablePool stable = new PlanStablePool(a, b);
        ArbitrageExecutor.Plan memory p = plan(address(stable), 0);
        p.route.borrowAmount = 1 ether; p.route.fees[0] = 0; p.route.data[0] = hex"03";
        vm.deal(address(b), 3000 ether);
        executor.executePlan(p);
        uint256 profit = a.balanceOf(address(executor));
        require(profit > 0.07 ether && profit < 0.08 ether, "wrong stable output");
        (uint112 x, uint112 y,) = stable.getReserves();
        require(stableK(x, y) >= stableK(1000 ether, 2000 ether), "stable invariant");
    }

    function stableK(uint256 x, uint256 y) private pure returns (uint256) {
        return (x * y / 1 ether) * (x * x / 1 ether + y * y / 1 ether) / 1 ether;
    }

    function testBatchRunsV2V3CarbonThenReusesFirstPool() public {
        SplitToken c = new SplitToken();
        SplitV3Pool middle = new SplitV3Pool(b, c);
        SplitCarbon carbon = new SplitCarbon();
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(pool), 0);
        plans[0].route.pools = new address[](3);
        plans[0].route.protocols = new uint8[](3);
        plans[0].route.fees = new uint256[](3);
        plans[0].route.data = new bytes[](3);
        plans[0].route.pools[0] = address(pool); plans[0].route.fees[0] = 30; plans[0].route.data[0] = hex"02";
        plans[0].route.pools[1] = address(middle); plans[0].route.protocols[1] = 1;
        plans[0].route.pools[2] = address(carbon); plans[0].route.protocols[2] = 2;
        plans[0].route.data[2] = abi.encode(uint256(1), address(c), address(a));
        require(executor.executeBatch(plans, 1000000) == 3, "mixed attempts failed");
        require(a.balanceOf(address(executor)) > 7000, "mixed batch profit");
        require(c.allowance(address(executor), address(carbon)) == 0, "approval leaked");
        require(a.balanceOf(address(pool)) == 1002000, "both plans must repay");
    }
}
