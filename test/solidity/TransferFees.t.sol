// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ArbitrageExecutor} from "../../Contract/NArb.sol";
import {FlashUniswapQueryV1} from "../../Contract/UniswapFlashQuery.sol";
import {SplitToken, SplitV2Pool} from "./NArbSplit.t.sol";

contract TaxToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public fee;
    bool public blocked;
    bool public extraDebit;
    uint256 public cap = type(uint256).max;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function setFee(address from, address to, uint256 bps) external { fee[from][to] = bps; }
    function setBlocked(bool value) external { blocked = value; }
    function setExtraDebit(bool value) external { extraDebit = value; }
    function setCap(uint256 value) external { cap = value; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked, "blocked");
        balanceOf[msg.sender] -= amount + (extraDebit ? 1 : 0);
        uint256 received = amount - amount * fee[msg.sender][to] / 10000;
        balanceOf[to] += received < cap ? received : cap;
        return true;
    }
}

contract TaxExecutorHarness is ArbitrageExecutor {
    constructor(address wrapped) ArbitrageExecutor(msg.sender, wrapped) {}
    function hop(address token, uint256 amount, address pool, address recipient, bool sent) external returns (address, uint256) {
        return _swapV2(token, amount, pool, 30, hex"", recipient, sent);
    }
}

contract TransferFeesTest {
    SplitToken a;
    TaxToken b;
    TaxExecutorHarness executor;
    SplitV2Pool pool;
    FlashUniswapQueryV1 query;
    function setUp() public {
        a = new SplitToken(); b = new TaxToken();
        executor = new TaxExecutorHarness(address(a));
        pool = new SplitV2Pool(a, SplitToken(address(b)), 1_000_000, 1_000_000);
        query = new FlashUniswapQueryV1();
    }
    function requests(uint256 count) private view returns (FlashUniswapQueryV1.TransferRequest[] memory r) {
        r = new FlashUniswapQueryV1.TransferRequest[](count);
        for (uint256 i; i < count; ++i) r[i] = FlashUniswapQueryV1.TransferRequest(address(pool), address(b), 10000, address(this));
    }
    function testMeasuresBuySellAndTransferSeparatelyAndRollsBackBatch() public {
        b.setFee(address(pool), address(executor), 2200);
        b.setFee(address(executor), address(pool), 1000);
        b.setFee(address(executor), address(this), 500);
        FlashUniswapQueryV1.TransferResult[] memory r = query.probeV2Transfers(address(executor), requests(2), 600000);
        require(r[0].measured && r[1].measured, "not measured");
        require(r[0].amounts[0] == 10000 && r[0].amounts[1] == 10000 && r[0].amounts[2] == 7800, "buy");
        require(r[0].amounts[3] == 3900 && r[0].amounts[4] == 3900 && r[0].amounts[5] == 3510, "sell");
        require(r[0].amounts[6] == 3900 && r[0].amounts[8] == 3705, "transfer");
        require(keccak256(abi.encode(r[0])) == keccak256(abi.encode(r[1])), "batch leaked state");
        require(b.balanceOf(address(pool)) == 1000000 && b.balanceOf(address(executor)) == 0 && b.balanceOf(address(this)) == 0, "persisted transfer");
    }
    function testPoolSpecificTaxDoesNotLeakToAnotherPool() public {
        SplitV2Pool other = new SplitV2Pool(a, SplitToken(address(b)), 1000000, 1000000);
        b.setFee(address(pool), address(executor), 2200);
        FlashUniswapQueryV1.TransferRequest[] memory r = requests(2); r[1].pool = address(other);
        FlashUniswapQueryV1.TransferResult[] memory result = query.probeV2Transfers(address(executor), r, 600000);
        require(result[0].amounts[2] == 7800 && result[1].amounts[2] == 10000, "pool-specific tax");
    }
    function testBlockedProbeIsNotZeroTax() public {
        b.setBlocked(true);
        FlashUniswapQueryV1.TransferResult[] memory r = query.probeV2Transfers(address(executor), requests(1), 600000);
        require(!r[0].measured, "failed transfer accepted");
    }
    function testProbeCannotPersistEvenWhenCalledDirectly() public {
        (bool ok,) = address(executor).call(abi.encodeCall(executor.probeV2Transfer, (address(pool), address(b), 10000, address(this))));
        require(!ok && b.balanceOf(address(pool)) == 1000000, "direct probe persisted");
    }
    function testTaxedInputUsesActualPoolCredit() public {
        b.mint(address(executor), 10000); b.setFee(address(executor), address(pool), 2200);
        (,uint256 out) = executor.hop(address(b), 10000, address(pool), address(executor), false);
        uint256 expected = 7800 * 9970 * uint256(1000000) / (1000000 * 10000 + 7800 * 9970);
        require(out == expected && a.balanceOf(address(executor)) == expected, "nominal input used");
    }
    function testForwardedTaxedInputUsesActualCredit() public {
        SplitV2Pool next = new SplitV2Pool(a, SplitToken(address(b)), 2000000, 1000000);
        b.setFee(address(pool), address(next), 2200); a.mint(address(executor), 10000);
        (,uint256 received) = executor.hop(address(a), 10000, address(pool), address(next), false);
        (,uint256 out) = executor.hop(address(b), received, address(next), address(executor), true);
        uint256 expected = received * 9970 * 2000000 / (1000000 * 10000 + received * 9970);
        require(out == expected && out > 0, "forwarded input failed");
    }
    function testOutputReturnsRecipientBalanceDelta() public {
        a.mint(address(executor), 10000); b.setCap(1);
        (,uint256 out) = executor.hop(address(a), 10000, address(pool), address(executor), false);
        require(out == 1, "nominal output returned");
    }
    function testRejectsSenderExtraDebit() public {
        b.mint(address(executor), 10001); b.setExtraDebit(true);
        (bool ok,) = address(executor).call(abi.encodeCall(executor.hop, (address(b), 10000, address(pool), address(executor), false)));
        require(!ok && b.balanceOf(address(executor)) == 10001, "extra debit accepted");
    }

    function prepareRoute() private returns (SplitV2Pool funding, SplitV2Pool sell, uint256 bought, uint256 returned) {
        funding = new SplitV2Pool(a, SplitToken(address(b)), 1000000, 1000000);
        sell = new SplitV2Pool(a, SplitToken(address(b)), 2000000, 1000000);
        b.setFee(address(pool), address(executor), 2200);
        b.setFee(address(executor), address(sell), 1000);
        // Forwarding has a different fee. The custody route must not use it.
        b.setFee(address(pool), address(sell), 10000);
        uint256 nominal = uint256(10000) * 9970 * 1000000 / (1000000 * 10000 + 10000 * 9970);
        bought = nominal - nominal * 2200 / 10000;
        uint256 received = bought - bought * 1000 / 10000;
        returned = received * 9970 * 2000000 / (1000000 * 10000 + received * 9970);
    }

    function linearPlan(SplitV2Pool funding, SplitV2Pool sell, uint256 floor) private view returns (ArbitrageExecutor.ArbParams memory p) {
        p.flashPool = address(funding); p.borrowToken = address(a); p.borrowAmount = 10000; p.v2RepayFee = 30;
        p.pools = new address[](2); p.pools[0] = address(pool); p.pools[1] = address(sell);
        p.protocols = new uint8[](2); p.fees = new uint256[](2); p.fees[0] = 30; p.fees[1] = 30;
        p.data = new bytes[](2); p.data[0] = hex"02"; p.data[1] = hex"02";
        p.minSurplusAfterRepayment = floor;
    }

    function testLinearCustodyRouteRepaysAndKeepsMeasuredProfit() public {
        (SplitV2Pool funding, SplitV2Pool sell,, uint256 returned) = prepareRoute();
        executor.executeArbitrage(linearPlan(funding, sell, 1000));
        require(a.balanceOf(address(executor)) == returned - 10031, "wrong linear profit");
    }

    function testLinearMinimumSurplusCannotSpendExistingInventory() public {
        (SplitV2Pool funding, SplitV2Pool sell,,) = prepareRoute();
        a.mint(address(executor), 1000000);
        (bool ok,) = address(executor).call(abi.encodeCall(executor.executeArbitrage, (linearPlan(funding, sell, 100000))));
        require(!ok && a.balanceOf(address(executor)) == 1000000, "minimum profit ignored");
    }

    function testSplitCustodyRouteRepaysAndKeepsMeasuredProfit() public {
        (SplitV2Pool funding, SplitV2Pool sell, uint256 bought, uint256 returned) = prepareRoute();
        ArbitrageExecutor.SplitParams memory p;
        p.flashPool = address(funding); p.borrowToken = address(a); p.borrowAmount = 10000; p.v2RepayFee = 30;
        p.deadline = block.timestamp; p.minSurplusAfterRepayment = 1000;
        p.stages = new ArbitrageExecutor.SplitStage[](2);
        p.stages[0].tokenIn = address(a); p.stages[0].tokenOut = address(b);
        p.stages[0].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[0].branches[0] = ArbitrageExecutor.SplitBranch(address(pool), 0, 30, 10000, bought, hex"02");
        p.stages[1].tokenIn = address(b); p.stages[1].tokenOut = address(a);
        p.stages[1].branches = new ArbitrageExecutor.SplitBranch[](1);
        p.stages[1].branches[0] = ArbitrageExecutor.SplitBranch(address(sell), 0, 30, bought, returned, hex"02");
        executor.executeSplitArbitrage(p);
        require(a.balanceOf(address(executor)) == returned - 10031, "wrong split profit");
    }
}
