// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ArbitrageExecutor, ICarbonController} from "../../Contract/NArb.sol";

interface SplitVm {
    function prank(address) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function deal(address, uint256) external;
}

contract SplitToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 value) external { balanceOf[to] += value; }
    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value; balanceOf[to] += value; return true;
    }
    function approve(address to, uint256 value) external returns (bool) { allowance[msg.sender][to] = value; return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        allowance[from][msg.sender] -= value; balanceOf[from] -= value; balanceOf[to] += value; return true;
    }
}

contract SplitV2Pool {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    bool private locked;
    address private reentryTarget;
    bytes private reentryData;
    function startWithReentry(address target, bytes calldata payload) external {
        reentryTarget = target; reentryData = payload;
        (bool ok, bytes memory reason) = target.call(payload);
        if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
    }
    constructor(SplitToken a, SplitToken b, uint112 x, uint112 y) {
        token0 = address(a); token1 = address(b); r0 = x; r1 = y;
        a.mint(address(this), x); b.mint(address(this), y);
    }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }
    function swap(uint256 x, uint256 y, address to, bytes calldata data) external {
        require(!locked, "pool locked"); locked = true;
        if (reentryData.length > 0) {
            (bool ok, ) = reentryTarget.call(reentryData); require(!ok, "reentry accepted");
        }
        if (x > 0) SplitToken(token0).transfer(to, x);
        if (y > 0) SplitToken(token1).transfer(to, y);
        if (data.length > 0) {
            (bool ok, bytes memory reason) = to.call(abi.encodeWithSignature("uniswapV2Call(address,uint256,uint256,bytes)", msg.sender, x, y, data));
            if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
        }
        uint256 next0 = SplitToken(token0).balanceOf(address(this));
        uint256 next1 = SplitToken(token1).balanceOf(address(this));
        require(next0 * next1 >= uint256(r0) * r1, "invariant");
        r0 = uint112(next0); r1 = uint112(next1);
        locked = false;
    }
}

contract SplitV3Pool {
    address public token0;
    address public token1;
    uint256 public mode;
    constructor(SplitToken a, SplitToken b) { token0 = address(a); token1 = address(b); a.mint(address(this), 100000); b.mint(address(this), 100000); }
    function setMode(uint256 value) external { mode = value; }
    function swap(address to, bool zeroForOne, int256 amount, uint160, bytes calldata data) external returns (int256, int256) {
        int256 input = mode == 1 ? amount / 2 : mode == 2 ? amount + 1 : amount;
        int256 output = input * 2;
        SplitToken(zeroForOne ? token1 : token0).transfer(to, uint256(output));
        ArbitrageExecutor(payable(to)).uniswapV3SwapCallback(zeroForOne ? input : -output, zeroForOne ? -output : input, data);
        if (mode == 3) ArbitrageExecutor(payable(to)).uniswapV3SwapCallback(zeroForOne ? input : -output, zeroForOne ? -output : input, data);
        return zeroForOne ? (input, -output) : (-output, input);
    }
    function flash(address to, uint256 x, uint256 y, bytes calldata data) external {
        uint256 start0 = SplitToken(token0).balanceOf(address(this));
        uint256 start1 = SplitToken(token1).balanceOf(address(this));
        if (x > 0) SplitToken(token0).transfer(to, x);
        if (y > 0) SplitToken(token1).transfer(to, y);
        bytes memory payload = mode == 4 ? abi.encode(uint256(0)) : data;
        ArbitrageExecutor(payable(to)).uniswapV3FlashCallback(x > 0 ? 1 : 0, y > 0 ? 1 : 0, payload);
        if (mode == 5) ArbitrageExecutor(payable(to)).uniswapV3FlashCallback(0, 0, payload);
        require(SplitToken(token0).balanceOf(address(this)) >= start0 + (x > 0 ? 1 : 0), "flash0");
        require(SplitToken(token1).balanceOf(address(this)) >= start1 + (y > 0 ? 1 : 0), "flash1");
    }
}

contract SplitCarbon {
    address constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    function tradeBySourceAmount(address source, address target, ICarbonController.TradeAction[] calldata actions, uint256, uint128) external payable returns (uint128) {
        uint256 amount;
        for (uint256 i; i < actions.length; ++i) amount += actions[i].amount;
        if (source == NATIVE) require(msg.value == amount, "native input");
        else SplitToken(source).transferFrom(msg.sender, address(this), amount);
        if (target == NATIVE) { (bool ok, ) = msg.sender.call{value: amount * 2}(hex""); require(ok); }
        else SplitToken(target).mint(msg.sender, amount * 2);
        return uint128(amount * 2);
    }
    receive() external payable {}
}

contract SplitWrappedToken is SplitToken {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}(hex""); require(ok);
    }
    receive() external payable {}
}

contract NArbSplitTest {
    SplitVm constant vm = SplitVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SplitToken private a;
    SplitToken private b;
    ArbitrageExecutor private executor;
    SplitV2Pool private funding;
    SplitV2Pool private buy1;
    SplitV2Pool private buy2;
    SplitV2Pool private sell;

    function setUp() public {
        a = new SplitToken(); b = new SplitToken();
        executor = new ArbitrageExecutor(address(this), address(new SplitWrappedToken()));
        funding = new SplitV2Pool(a, b, 100000, 100000);
        buy1 = new SplitV2Pool(a, b, 1000, 2000);
        buy2 = new SplitV2Pool(a, b, 1000, 2000);
        sell = new SplitV2Pool(a, b, 2000, 2000);
    }
    function testBatchRetainsSplitProfitWhenAnotherPlanFails() public {
        ArbitrageExecutor.SplitParams memory split = plan();
        ArbitrageExecutor.Plan[] memory plans = new ArbitrageExecutor.Plan[](2);
        for (uint256 i; i < 2; ++i) {
            plans[i].deadline = split.deadline;
            plans[i].stages = split.stages;
            plans[i].route.flashProtocol = split.flashProtocol;
            plans[i].route.flashPool = split.flashPool;
            plans[i].route.borrowToken = split.borrowToken;
            plans[i].route.borrowAmount = split.borrowAmount;
            plans[i].route.v2RepayFee = split.v2RepayFee;
        }
        plans[1].route.borrowAmount = 999999;
        require(executor.executeBatch(plans, 1000000) == 1, "split result not isolated");
        require(a.balanceOf(address(executor)) == 106, "split profit lost");
    }

    function plan() private view returns (ArbitrageExecutor.SplitParams memory p) {
        p.flashProtocol = 0; p.flashPool = address(funding); p.borrowToken = address(a); p.borrowAmount = 200;
        p.deadline = block.timestamp;
        p.stages = new ArbitrageExecutor.SplitStage[](2);
        p.stages[0].tokenIn = address(a); p.stages[0].tokenOut = address(b);
        p.stages[0].branches = new ArbitrageExecutor.SplitBranch[](2);
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(buy1), 0, 0, 100, 181, hex"");
        p.stages[0].branches[1] = ArbitrageExecutor.SplitBranch(address(buy2), 0, 0, 100, 181, hex"");
        p.stages[1].tokenIn = address(b); p.stages[1].tokenOut = address(a);
        p.stages[1].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[1].branches[0] = ArbitrageExecutor.SplitBranch(address(sell), 0, 0, 362, 306, hex"");
    }
    function testSplitMergesAndRepaysWithoutSpendingOldBalances() public {
        a.mint(address(executor), 777); b.mint(address(executor), 888);
        executor.executeSplitArbitrage(plan());
        require(a.balanceOf(address(executor)) == 883, "profit");
        require(b.balanceOf(address(executor)) == 888, "old inventory");
        require(a.balanceOf(address(funding)) == 100000, "repay");
    }
    function reject(ArbitrageExecutor.SplitParams memory p) private {
        a.mint(address(executor), 1000000); b.mint(address(executor), 1000000);
        (bool ok, ) = address(executor).call(abi.encodeCall(executor.executeSplitArbitrage, (p)));
        require(!ok, "accepted invalid plan");
        require(a.balanceOf(address(executor)) == 1000000 && b.balanceOf(address(executor)) == 1000000, "not atomic");
    }
    function testRejectsLossDespiteOldInventory() public { ArbitrageExecutor.SplitParams memory p = plan(); p.v2RepayFee = 3500; reject(p); }
    function testRejectsUnfundedSecondStageDespiteOldInventory() public { ArbitrageExecutor.SplitParams memory p = plan(); p.stages[1].branches[0].amountIn = 363; reject(p); }
    function testRejectsMinimumOutputMiss() public { ArbitrageExecutor.SplitParams memory p = plan(); p.stages[0].branches[0].minAmountOut = 182; reject(p); }
    function testRejectsDuplicatePool() public { ArbitrageExecutor.SplitParams memory p = plan(); p.stages[0].branches[1].pool = address(buy1); reject(p); }
    function testRejectsFundingPoolAsBranch() public { ArbitrageExecutor.SplitParams memory p = plan(); p.stages[0].branches[0].pool = address(funding); reject(p); }
    function testRejectsNonCircularPath() public { ArbitrageExecutor.SplitParams memory p = plan(); p.stages[1].tokenOut = address(b); reject(p); }
    function testRejectsExpiredPlan() public { ArbitrageExecutor.SplitParams memory p = plan(); vm.warp(block.timestamp + 1); reject(p); }
    function testRejectsUnauthorizedEntry() public {
        ArbitrageExecutor.SplitParams memory p = plan(); vm.prank(address(123));
        (bool ok, ) = address(executor).call(abi.encodeCall(executor.executeSplitArbitrage, (p))); require(!ok, "authorization");
    }
    function testRejectsCallbackOutsideExecution() public {
        (bool ok, ) = address(executor).call(abi.encodeCall(executor.uniswapV3SwapCallback, (int256(1), int256(-1), hex""))); require(!ok, "callback");
    }
    function testV3BranchKeepsFavorableIntermediateSurplus() public {
        SplitV3Pool v3 = new SplitV3Pool(a, b);
        ArbitrageExecutor.SplitParams memory p = plan(); p.stages[0].branches[0].pool = address(v3); p.stages[0].branches[0].protocol = 1;
        executor.executeSplitArbitrage(p);
        require(a.balanceOf(address(executor)) == 106 && b.balanceOf(address(executor)) == 19, "surplus");
    }
    function testRejectsV3PartialInput() public { rejectV3(1); }
    function testRejectsV3OverpaymentCallback() public { rejectV3(2); }
    function testRejectsDuplicateV3Callback() public { rejectV3(3); }
    function rejectV3(uint256 mode) private {
        SplitV3Pool v3 = new SplitV3Pool(a, b); v3.setMode(mode);
        ArbitrageExecutor.SplitParams memory p = plan(); p.stages[0].branches[0].pool = address(v3); p.stages[0].branches[0].protocol = 1; reject(p);
    }
    function testV3FlashRepayment() public {
        SplitV3Pool v3 = new SplitV3Pool(a, b);
        ArbitrageExecutor.SplitParams memory p = plan(); p.flashPool = address(v3); p.flashProtocol = 1;
        executor.executeSplitArbitrage(p); require(a.balanceOf(address(executor)) == 105, "flash fee");
    }
    function testRejectsChangedFlashPayload() public { rejectFlash(4); }
    function testRejectsDuplicateFlashCallback() public { rejectFlash(5); }
    function rejectFlash(uint256 mode) private {
        SplitV3Pool v3 = new SplitV3Pool(a, b); v3.setMode(mode);
        ArbitrageExecutor.SplitParams memory p = plan(); p.flashPool = address(v3); p.flashProtocol = 1; reject(p);
    }
    function testCarbonBranchAndApprovalCleared() public {
        SplitCarbon carbon = new SplitCarbon();
        ArbitrageExecutor.SplitParams memory p = plan();
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 100, 181, abi.encode(uint256(42), address(a), address(b)));
        executor.executeSplitArbitrage(p);
        require(a.balanceOf(address(executor)) == 106 && b.balanceOf(address(executor)) == 19, "carbon proceeds");
        require(a.allowance(address(executor), address(carbon)) == 0, "allowance");
    }
    function testRejectsOverlappingCarbonGroupAndSingle() public {
        SplitCarbon carbon = new SplitCarbon();
        ArbitrageExecutor.SplitParams memory p = plan();
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 100, 181, abi.encode(uint256(42), address(a), address(b)));
        uint256[] memory ids = new uint256[](2); ids[0] = 42; ids[1] = 43;
        uint128[] memory amounts = new uint128[](2); amounts[0] = 50; amounts[1] = 50;
        p.stages[0].branches[1] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 100, 181, abi.encode(address(a), address(b), ids, amounts)); reject(p);
    }
    function testGroupedCarbonUsesExactActionAmounts() public {
        SplitCarbon carbon = new SplitCarbon();
        ArbitrageExecutor.SplitParams memory p = plan();
        uint256[] memory ids = new uint256[](2); ids[0] = 42; ids[1] = 43;
        uint128[] memory amounts = new uint128[](2); amounts[0] = 30; amounts[1] = 70;
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 100, 181, abi.encode(address(a), address(b), ids, amounts));
        executor.executeSplitArbitrage(p); require(a.balanceOf(address(executor)) == 106, "group");
    }
    function testRejectsResizedCarbonActions() public {
        SplitCarbon carbon = new SplitCarbon(); ArbitrageExecutor.SplitParams memory p = plan();
        uint256[] memory ids = new uint256[](2); ids[0] = 42; ids[1] = 43;
        uint128[] memory amounts = new uint128[](2); amounts[0] = 30; amounts[1] = 69;
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 100, 181, abi.encode(address(a), address(b), ids, amounts)); reject(p);
    }
    function testNativeCarbonBothDirectionsPreserveOldNativeBalance() public {
        address wrapped = executor.wrappedNativeToken();
        address native = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
        vm.deal(wrapped, 1000000);
        SplitToken w = SplitToken(wrapped);
        SplitV2Pool loan = new SplitV2Pool(w, b, 100000, 100000);
        SplitCarbon carbon = new SplitCarbon(); vm.deal(address(carbon), 1000000); vm.deal(address(executor), 777);
        ArbitrageExecutor.SplitParams memory p = plan(); p.flashPool = address(loan); p.borrowToken = wrapped;
        p.stages[0].tokenIn = wrapped; p.stages[1].tokenOut = wrapped;
        p.stages[0].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 200, 400, abi.encode(uint256(1), native, address(b)));
        p.stages[1].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 400, 800, abi.encode(uint256(2), address(b), native));
        executor.executeSplitArbitrage(p);
        require(w.balanceOf(address(executor)) == 600 && address(executor).balance == 777, "native accounting");
    }
    function testRejectsMissingWrappedNativeContract() public {
        try new ArbitrageExecutor(address(this), address(0)) { revert("accepted zero address"); } catch {}
        try new ArbitrageExecutor(address(this), address(123)) { revert("accepted non-contract"); } catch {}
    }
    function testOwnerCannotReenterAnActiveSplit() public {
        ArbitrageExecutor.SplitParams memory p = plan();
        executor.transferOwnership(address(buy1));
        buy1.startWithReentry(address(executor), abi.encodeCall(executor.executeSplitArbitrage, (p)));
        require(a.balanceOf(address(executor)) == 106, "outer execution");
    }
    function testThreeStages() public {
        SplitToken c = new SplitToken(); SplitCarbon carbon = new SplitCarbon();
        ArbitrageExecutor.SplitParams memory p = plan();
        ArbitrageExecutor.SplitStage[] memory stages = new ArbitrageExecutor.SplitStage[](3);
        stages[0] = p.stages[0];
        stages[1].tokenIn = address(b); stages[1].tokenOut = address(c); stages[1].branches = new ArbitrageExecutor.SplitBranch[](1);
        stages[1].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 362, 724, abi.encode(uint256(10), address(b), address(c)));
        stages[2].tokenIn = address(c); stages[2].tokenOut = address(a); stages[2].branches = new ArbitrageExecutor.SplitBranch[](1);
        stages[2].branches[0] = ArbitrageExecutor.SplitBranch(address(carbon), 2, 0, 724, 1448, abi.encode(uint256(11), address(c), address(a)));
        p.stages = stages; executor.executeSplitArbitrage(p);
        require(a.balanceOf(address(executor)) == 1248, "three stages");
    }
    function testLinearEntryStillWorksForOwner() public {
        ArbitrageExecutor.ArbParams memory p;
        p.flashPool = address(funding); p.borrowToken = address(a); p.borrowAmount = 100;
        p.pools = new address[](2); p.pools[0] = address(buy1); p.pools[1] = address(sell);
        p.protocols = new uint8[](2); p.fees = new uint256[](2); p.data = new bytes[](2);
        executor.executeArbitrage(p); require(a.balanceOf(address(executor)) == 65, "linear compatibility");
    }
    function testFuzzRepaymentCannotSpendExistingBorrowToken(uint16 fee, uint128 oldBalance) public {
        ArbitrageExecutor.SplitParams memory p = plan(); p.v2RepayFee = uint256(fee) % 10000;
        uint256 denominator = 10000 - p.v2RepayFee;
        uint256 repayAmount = 200 + (200 * p.v2RepayFee + denominator - 1) / denominator;
        a.mint(address(executor), oldBalance);
        (bool ok, ) = address(executor).call(abi.encodeCall(executor.executeSplitArbitrage, (p)));
        require(ok == (306 > repayAmount), "profit acceptance");
        require(a.balanceOf(address(executor)) == uint256(oldBalance) + (ok ? 306 - repayAmount : 0), "isolated balance");
    }
}
