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

contract NArbPlanTest {
    SplitVm constant vm = SplitVm(address(uint160(uint256(keccak256("hevm cheat code")))));
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

    function testBatchReusesPoolOnlyAfterFundingReturns() public {
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(pool), 0);
        executor.executeBatch(plans);
        require(a.balanceOf(address(executor)) > 1900, "missing combined profit");
        require(a.balanceOf(address(pool)) == 1002000, "both plans must repay");
    }

    function testBatchFailureRollsBackFirstPlan() public {
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        plans[0] = plan(address(pool), 0); plans[1] = plan(address(pool), 0);
        plans[1].route.borrowAmount = 10000000;
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeBatch, (plans)));
        require(!ok, "loss accepted");
        require(a.balanceOf(address(pool)) == 1000000 && a.balanceOf(address(executor)) == 0, "A not rolled back");
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
        executor.executeBatch(plans);
        require(a.balanceOf(address(executor)) > 7000, "mixed batch profit");
        require(c.allowance(address(executor), address(carbon)) == 0, "approval leaked");
        require(a.balanceOf(address(pool)) == 1002000, "both plans must repay");
    }
}
