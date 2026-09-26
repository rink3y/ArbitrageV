// SPDX-License-Identifier: MIT
//v2, v3 & carbon
pragma solidity ^0.8.0;

import "./interfaces/Withdrawable.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./TransferProbe.sol";

import "./ExecutionTypes.sol";
import "./modules/V2Logic.sol";
import "./modules/V3Logic.sol";
import "./modules/CarbonLogic.sol";

contract ArbitrageExecutor is Withdrawable, TransferProbe {
    uint8 private constant V2 = 0;
    uint8 private constant V3 = 1;
    uint8 private constant CARBON = 2;
    uint8 private constant V2_ROUTE_FLASH = 3;
    uint8 private constant V3_ROUTE_FLASH = 4;
    mapping(address => bool) public approvedWrapper;
    address private constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public immutable wrappedNativeToken;
    V2Logic public immutable v2Logic;
    V3Logic public immutable v3Logic;
    CarbonLogic public immutable carbonLogic;
    uint256 private constant FEE_DENOMINATOR = 10000;
    // Entry dispatch/owner check before gasleft(), plus the final check and lock cleanup.
    uint256 private constant GAS_ACCOUNTING_OVERHEAD = 10_000;
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    uint8 private pendingFlashProtocol;
    address private pendingFlashPool;
    bytes32 private pendingFlashHash;
    bool private executing;

    struct SplitBranch {
        address pool;
        uint8 protocol;
        uint256 fee;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes data;
    }

    struct SplitStage {
        address tokenIn;
        address tokenOut;
        SplitBranch[] branches;
    }

    struct SplitParams {
        uint8 flashProtocol;
        address flashPool;
        address borrowToken;
        uint256 borrowAmount;
        uint256 v2RepayFee;
        SplitStage[] stages;
        uint256 deadline;
    }

    struct FlashData {
        address borrowedToken;
        uint256 borrowedAmount;
        bool borrowedToken0;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
        SplitStage[] stages;
        uint256 startBalance;
    }

    struct ArbParams {
        uint8 flashProtocol;
        address flashPool;
        address borrowToken;
        uint256 borrowAmount;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
    }

    constructor(address owner_, address wrappedNativeToken_) Withdrawable(owner_) {
        if (wrappedNativeToken_ == NATIVE_TOKEN || wrappedNativeToken_.code.length == 0) revert InvalidWrappedNativeToken();
        wrappedNativeToken = wrappedNativeToken_;
        approvedWrapper[wrappedNativeToken_] = true;
        v2Logic = new V2Logic();
        v3Logic = new V3Logic();
        carbonLogic = new CarbonLogic();
    }

    modifier executionLock(address borrowToken) {
        uint256 gasStart = gasleft();
        if (executing) revert ExecutionInProgress();
        executing = true;
        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        _;
        _checkProfit(borrowToken, balanceBefore, gasStart);
        executing = false;
    }

    function _checkProfit(address token, uint256 balanceBefore, uint256 gasStart) private view {
        // The lender has returned: repayment and its final checks are already included.
        uint256 balanceAfter = IERC20(token).balanceOf(address(this));
        if (balanceAfter <= balanceBefore) revert NoProfit();
        if (!approvedWrapper[token]) return;

        uint256 profit = balanceAfter - balanceBefore;
        // Direct transactions from the bot have no access list. Charge all calldata bytes
        // as nonzero, and do not subtract refunds: both conservatively overestimate cost.
        uint256 gasUsed = gasStart - gasleft() + 21_000 + msg.data.length * 16 + GAS_ACCOUNTING_OVERHEAD;
        // Also cover the calldata floor on chains that have adopted EIP-7623.
        uint256 calldataFloor = 21_000 + msg.data.length * 40;
        if (gasUsed < calldataFloor) gasUsed = calldataFloor;
        uint256 gasCost = gasUsed * tx.gasprice;
        if (profit <= gasCost) revert InsufficientProfitAfterGas(profit, gasCost);
    }

    // Permissionless but always reverts. FlashQuery catches the measured result in eth_call.
    function probeV2Transfer(address pool, address token, uint256 amount, address recipient) external {
        if (executing) revert ExecutionInProgress();
        executing = true;
        _probeTransfer(pool, token, amount, recipient);
    }

    function executeArbitrage(ArbParams calldata params) external onlyOwner executionLock(params.borrowToken) {
        _executeLoan(params);
    }

    function _executeLoan(ArbParams memory params) private {
        if (
            params.pools.length != params.protocols.length ||
            params.pools.length != params.fees.length ||
            params.pools.length != params.data.length
        ) revert ArrayLengthMismatch();
        bool borrowToken0 = _isToken0(params.flashPool, params.borrowToken);
        _startFlashLoan(params, borrowToken0, _flashData(params, borrowToken0));
    }

    // Compact volatile-V2 entrypoint, sharing executePlan's swap implementation.
    function executeV2RouteFlash(
        address startToken, uint256 amountIn, address[] calldata pools, uint256[] calldata fees
    ) external onlyOwner executionLock(startToken) {
        ArbParams memory route;
        route.borrowToken = startToken;
        route.borrowAmount = amountIn;
        route.pools = pools;
        route.fees = fees;
        route.protocols = new uint8[](pools.length);
        route.data = new bytes[](pools.length);
        for (uint256 i; i < pools.length; ++i) route.data[i] = hex"02";
        _startRouteSwap(route);
    }

    function executeSplitArbitrage(SplitParams calldata params) external onlyOwner executionLock(params.borrowToken) {
        _executeSplitLoan(params);
    }

    function _executeSplitLoan(SplitParams memory params) private {
        _validateSplit(params);
        bool token0 = _isToken0(params.flashPool, params.borrowToken);
        FlashData memory loan;
        loan.borrowedToken = params.borrowToken;
        loan.borrowedAmount = params.borrowAmount;
        loan.borrowedToken0 = token0;
        loan.v2RepayFee = params.v2RepayFee;
        loan.stages = params.stages;
        loan.startBalance = IERC20(params.borrowToken).balanceOf(address(this));
        ArbParams memory funding;
        funding.flashProtocol = params.flashProtocol;
        funding.flashPool = params.flashPool;
        funding.borrowAmount = params.borrowAmount;
        _startFlashLoan(funding, token0, abi.encode(loan));
    }

    function _validateSplit(SplitParams memory params) private view {
        if (params.deadline < block.timestamp || params.borrowAmount == 0 || params.stages.length < 2 || params.stages.length > 3 ||
            params.flashPool.code.length == 0 || params.flashProtocol > V3 || params.v2RepayFee >= FEE_DENOMINATOR) revert InvalidSplitPlan();
        address token = params.borrowToken;
        uint256 available = params.borrowAmount;
        uint256 swaps;
        bytes32[] memory used = new bytes32[](48);
        uint256 usedCount;
        for (uint256 i; i < params.stages.length; ++i) {
            SplitStage memory stage = params.stages[i];
            if (stage.tokenIn != token || stage.tokenIn == stage.tokenOut || stage.branches.length == 0 || stage.branches.length > 2 ||
                (i + 1 < params.stages.length && stage.tokenOut == params.borrowToken)) revert InvalidSplitPlan();
            for (uint256 prior; prior < i; ++prior) if (params.stages[prior].tokenIn == stage.tokenIn) revert InvalidSplitPlan();
            uint256 spent;
            uint256 proceeds;
            for (uint256 j; j < stage.branches.length; ++j) {
                SplitBranch memory branch = stage.branches[j];
                if (branch.amountIn == 0 || branch.minAmountOut == 0 || branch.pool == params.flashPool || branch.pool.code.length == 0 ||
                    branch.protocol > CARBON || (branch.protocol == V2 && branch.fee >= FEE_DENOMINATOR)) revert InvalidSplitPlan();
                bytes32[] memory resources = _splitResources(branch);
                for (uint256 r; r < resources.length; ++r) {
                    for (uint256 k; k < usedCount; ++k) if (used[k] == resources[r]) revert InvalidSplitPlan();
                    used[usedCount++] = resources[r];
                }
                spent += branch.amountIn;
                proceeds += branch.minAmountOut;
                swaps++;
            }
            if (spent > available || (i == 0 && spent != available)) revert InvalidSplitPlan();
            available = proceeds;
            token = stage.tokenOut;
        }
        if (swaps > 6 || !_canSettle(token, params.borrowToken)) revert InvalidSplitPlan();
    }

    function _splitResources(SplitBranch memory branch) private pure returns (bytes32[] memory resources) {
        if (branch.protocol != CARBON) {
            resources = new bytes32[](1);
            resources[0] = keccak256(abi.encode(branch.pool));
            return resources;
        }
        uint256[] memory ids;
        if (branch.data.length == 96) {
            ids = new uint256[](1);
            (ids[0], , ) = abi.decode(branch.data, (uint256, address, address));
        } else {
            uint128[] memory amounts;
            (, , ids, amounts) = abi.decode(branch.data, (address, address, uint256[], uint128[]));
            if (ids.length == 0 || ids.length > 8 || ids.length != amounts.length) revert InvalidSplitPlan();
            uint256 total;
            for (uint256 i; i < amounts.length; ++i) { if (amounts[i] == 0) revert InvalidSplitPlan(); total += amounts[i]; }
            if (total != branch.amountIn) revert InvalidCarbonAmount();
        }
        resources = new bytes32[](ids.length);
        for (uint256 i; i < ids.length; ++i) resources[i] = keccak256(abi.encode(branch.pool, ids[i]));
    }

    function _startFlashLoan(
        ArbParams memory params,
        bool borrowToken0,
        bytes memory data
    ) internal {
        pendingFlashProtocol = params.flashProtocol;
        pendingFlashPool = params.flashPool;
        pendingFlashHash = keccak256(data);

        if (params.flashProtocol == V2) {
            IUniswapV2Pair(params.flashPool).swap(
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                address(this),
                data
            );
        } else if (params.flashProtocol == V3) {
            IUniswapV3Pool(params.flashPool).flash(
                address(this),
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                data
            );
        } else {
            revert UnsupportedProtocol();
        }

        if (pendingFlashHash != bytes32(0)) revert InvalidFlashLoanCallback();
        pendingFlashProtocol = 0;
        pendingFlashPool = address(0);
    }

    // ponytail: one generic fallback handles callback name variants instead of dozens of wrappers.
    fallback() external payable {
        if (_isTransferProbe()) _transferProbeCallback();
        if (msg.sender == ExecutionState.v3().pool && ExecutionState.v3().pool != address(0)) {
            (int256 amount0Delta, int256 amount1Delta, ) =
                abi.decode(msg.data[4:], (int256, int256, bytes));
            _finishV3SwapCallback(amount0Delta, amount1Delta);
            return;
        }

        if (msg.sender != pendingFlashPool || msg.data.length < 132) {
            revert InvalidFlashLoanCallback();
        }

        if (pendingFlashProtocol == V3_ROUTE_FLASH) {
            (int256 delta0, int256 delta1, bytes memory payload) = abi.decode(msg.data[4:], (int256, int256, bytes));
            _finishV3RouteSwap(delta0, delta1, payload);
            return;
        }

        if (pendingFlashProtocol == V3) {
            (uint256 fee0, uint256 fee1, bytes memory flashPayload) =
                abi.decode(msg.data[4:], (uint256, uint256, bytes));
            _consumeFlashPayload(flashPayload);
            FlashData memory v3Loan = abi.decode(flashPayload, (FlashData));
            _finishFlashLoan(v3Loan, v3Loan.borrowedAmount + (v3Loan.borrowedToken0 ? fee0 : fee1));
            return;
        }

        if (pendingFlashProtocol != V2 && pendingFlashProtocol != V2_ROUTE_FLASH) revert InvalidFlashLoanCallback();

        (address sender, uint256 amount0, uint256 amount1, bytes memory data) =
            abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        if (sender != address(this)) revert InvalidFlashLoanCallback();

        _consumeFlashPayload(data);

        if (pendingFlashProtocol == V2_ROUTE_FLASH) {
            RouteFunding memory funding = abi.decode(data, (RouteFunding));
            if ((funding.outputToken0 ? amount0 : amount1) != funding.output ||
                (funding.outputToken0 ? amount1 : amount0) != 0) revert InvalidFlashLoanCallback();
            _finishRouteSwap(funding);
            return;
        }

        FlashData memory loan = abi.decode(data, (FlashData));
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        if (borrowedAmount != loan.borrowedAmount || (loan.borrowedToken0 ? amount1 != 0 : amount0 != 0)) revert InvalidFlashLoanCallback();

        _finishFlashLoan(
            loan,
            _v2RepayAmount(borrowedAmount, loan.v2RepayFee)
        );
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (pendingFlashProtocol != V3 || msg.sender != pendingFlashPool) {
            revert InvalidFlashLoanCallback();
        }

        _consumeFlashPayload(data);
        FlashData memory loan = abi.decode(data, (FlashData));
        _finishFlashLoan(loan, loan.borrowedAmount + (loan.borrowedToken0 ? fee0 : fee1));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender == pendingFlashPool && pendingFlashProtocol == V3_ROUTE_FLASH) {
            _finishV3RouteSwap(amount0Delta, amount1Delta, data);
        } else _finishV3SwapCallback(amount0Delta, amount1Delta);
    }

    function _finishV3SwapCallback(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != ExecutionState.v3().pool || ExecutionState.v3().pool == address(0)) revert InvalidV3SwapCallback();

        address owedToken;
        uint256 owedAmount;
        if (amount0Delta > 0 && amount1Delta <= 0) {
            owedToken = IUniswapV3Pool(msg.sender).token0(); owedAmount = uint256(amount0Delta);
        } else if (amount1Delta > 0 && amount0Delta <= 0) {
            owedToken = IUniswapV3Pool(msg.sender).token1(); owedAmount = uint256(amount1Delta);
        } else {
            revert InvalidV3SwapDelta();
        }
        if (owedToken != ExecutionState.v3().token || owedAmount != ExecutionState.v3().amount) revert InvalidV3SwapDelta();
        ExecutionState.v3().pool = address(0);
        ExecutionState.v3().amount = 0;
        _safeTransfer(owedToken, msg.sender, owedAmount);
    }

    function _consumeFlashPayload(bytes memory data) private {
        if (!executing || pendingFlashHash == bytes32(0) || keccak256(data) != pendingFlashHash) revert InvalidFlashLoanCallback();
        pendingFlashHash = bytes32(0);
    }

    function _finishFlashLoan(FlashData memory loan, uint256 repayAmount) internal {
        if (IERC20(loan.borrowedToken).balanceOf(address(this)) < loan.startBalance + loan.borrowedAmount) revert InvalidFlashLoanCallback();
        if (loan.stages.length == 0) _executeCircularRoute(loan);
        else _executeSplitRoute(loan);
        if (IERC20(loan.borrowedToken).balanceOf(address(this)) < loan.startBalance + repayAmount) revert InsufficientFlashLoanRepayment();
        if (!IERC20(loan.borrowedToken).transfer(msg.sender, repayAmount)) {
            revert RepaymentTransferFailed();
        }
    }

    function _executeSplitRoute(FlashData memory loan) private returns (uint256 available) {
        available = loan.borrowedAmount;
        for (uint256 i; i < loan.stages.length; ++i) {
            SplitStage memory stage = loan.stages[i];
            uint256 spent;
            uint256 received;
            for (uint256 j; j < stage.branches.length; ++j) {
                spent += stage.branches[j].amountIn;
                if (spent > available) revert InvalidSplitPlan();
                received += _executeSplitBranch(stage.tokenIn, stage.tokenOut, stage.branches[j]);
            }
            available = received;
        }
        _settle(loan.stages[loan.stages.length - 1].tokenOut, loan.borrowedToken, available);
    }

    function _executeSplitBranch(address tokenIn, address tokenOut, SplitBranch memory branch) private returns (uint256 received) {
        uint256 beforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        address actualToken;
        if (branch.protocol == V2) (actualToken, ) = _swapV2(tokenIn, branch.amountIn, branch.pool, branch.fee, branch.data, address(this), false);
        else if (branch.protocol == V3) (actualToken, ) = _swapV3(tokenIn, branch.amountIn, branch.pool);
        else if (branch.protocol == CARBON) (actualToken, ) = _swapCarbon(tokenIn, branch.amountIn, branch.pool, branch.data);
        else revert UnsupportedProtocol();
        if (actualToken != tokenOut || IERC20(tokenIn).balanceOf(address(this)) + branch.amountIn != beforeIn) revert InvalidSplitPlan();
        received = IERC20(tokenOut).balanceOf(address(this)) - beforeOut;
        if (received < branch.minAmountOut) revert SplitMinimumNotMet();
    }

    function _executeCircularRoute(FlashData memory loan) internal returns (uint256) {
        return _executeRoute(loan, loan.borrowedToken, loan.borrowedAmount, 0);
    }

    function _executeRoute(FlashData memory loan, address token, uint256 amount, uint256 first) private returns (uint256) {
        for (uint256 i = first; i < loan.pools.length; ) {
            if (loan.protocols[i] == V2) {
                bool forwardToNextV2 =
                    i + 1 < loan.pools.length &&
                    loan.protocols[i + 1] == V2 &&
                    !_custodyV2(loan.data[i]) && !_custodyV2(loan.data[i + 1]) &&
                    loan.pools[i + 1] != loan.pools[i];
                (token, amount) = _swapV2(
                    token,
                    amount,
                    loan.pools[i],
                    loan.fees[i],
                    loan.data[i],
                    forwardToNextV2 ? loan.pools[i + 1] : address(this),
                    i > first && loan.protocols[i - 1] == V2 && loan.pools[i - 1] != loan.pools[i] &&
                    !_custodyV2(loan.data[i - 1]) && !_custodyV2(loan.data[i])
                );
            } else if (loan.protocols[i] == V3) {
                (token, amount) = _swapV3(token, amount, loan.pools[i]);
            } else if (loan.protocols[i] == CARBON) {
                (token, amount) = _swapCarbon(token, amount, loan.pools[i], loan.data[i]);
            } else {
                revert UnsupportedProtocol();
            }

            unchecked { ++i; }
        }

        _settle(token, loan.borrowedToken, amount);
        return amount;
    }

    function _swapV2(address token, uint256 amount, address pool, uint256 fee, bytes memory data, address recipient, bool sent)
        internal returns (address, uint256) {
        return abi.decode(_runLogic(address(v2Logic), abi.encodeCall(V2Logic.swap, (token, amount, pool, fee, data, recipient, sent))), (address, uint256));
    }

    function _custodyV2(bytes memory data) private pure returns (bool) {
        return data.length == 1 && (data[0] == 0x02 || data[0] == 0x03);
    }

    function _swapV3(address token, uint256 amount, address pool) internal returns (address, uint256) {
        return abi.decode(_runLogic(address(v3Logic), abi.encodeCall(V3Logic.swap, (token, amount, pool))), (address, uint256));
    }

    function _swapCarbon(address token, uint256 amount, address controller, bytes memory data) internal returns (address, uint256) {
        return abi.decode(_runLogic(address(carbonLogic), abi.encodeCall(CarbonLogic.swap, (token, amount, controller, data, wrappedNativeToken))), (address, uint256));
    }

    function _runLogic(address logic, bytes memory data) private returns (bytes memory result) {
        bool ok;
        (ok, result) = logic.delegatecall(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function _isToken0(address pool, address token) internal view returns (bool) {
        address token0 = IUniswapV2Pair(pool).token0();
        if (token == token0) return true;
        if (token != IUniswapV2Pair(pool).token1()) revert StartTokenNotInFlashLoanPair();
        return false;
    }

    function _flashData(ArbParams memory params, bool borrowedToken0) internal view returns (bytes memory) {
        FlashData memory loan;
        loan.borrowedToken = params.borrowToken;
        loan.borrowedAmount = params.borrowAmount;
        loan.borrowedToken0 = borrowedToken0;
        loan.v2RepayFee = params.v2RepayFee;
        loan.pools = params.pools;
        loan.protocols = params.protocols;
        loan.fees = params.fees;
        loan.data = params.data;
        loan.startBalance = IERC20(params.borrowToken).balanceOf(address(this));
        return abi.encode(loan);
    }

    function _v2RepayAmount(uint256 borrowedAmount, uint256 fee) internal pure returns (uint256) {
        uint256 denominator = FEE_DENOMINATOR - fee;
        return borrowedAmount + ((borrowedAmount * fee + denominator - 1) / denominator);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }

    struct Plan {
        ArbParams route;
        SplitStage[] stages;
        uint256 deadline;
        bool routeSwap;
    }

    struct RouteFunding {
        FlashData loan;
        address outputToken;
        uint256 output;
        uint256 outputBefore;
        bool outputToken0;
    }

    // Only approve audited WETH9-style wrappers of this chain's native coin.
    function setWrapper(address wrapper, bool approved) external onlyOwner {
        if (executing) revert ExecutionInProgress();
        if (wrapper == wrappedNativeToken && !approved) revert InvalidWrappedNativeToken();
        if (wrapper == NATIVE_TOKEN || wrapper.code.length == 0) revert InvalidWrappedNativeToken();
        approvedWrapper[wrapper] = approved;
    }

    function executePlan(Plan calldata plan) external onlyOwner executionLock(plan.route.borrowToken) {
        _executePlan(plan);
    }

    function executeBatch(Plan[] calldata plans) external onlyOwner executionLock(plans[0].route.borrowToken) {
        if (plans.length != 2) revert InvalidSplitPlan();
        if (plans[0].route.borrowToken != plans[1].route.borrowToken) revert ArbitrageMustReturnToStart();
        // Return from A's funding call before B, releasing the pool's swap lock.
        // Each repayment also protects the inventory present before that plan.
        _executePlan(plans[0]);
        _executePlan(plans[1]);
    }

    function _executePlan(Plan memory plan) private {
        if (plan.deadline < block.timestamp) revert InvalidSplitPlan();
        if (plan.routeSwap) {
            if (plan.stages.length != 0) revert InvalidSplitPlan();
            _startRouteSwap(plan.route);
        } else if (plan.stages.length != 0) {
            _executeSplitLoan(SplitParams(plan.route.flashProtocol, plan.route.flashPool,
                plan.route.borrowToken, plan.route.borrowAmount, plan.route.v2RepayFee, plan.stages, plan.deadline));
        } else _executeLoan(plan.route);
    }

    function _canSettle(address token, address target) private view returns (bool) {
        return token == target || (approvedWrapper[token] && approvedWrapper[target]);
    }

    function _settle(address token, address target, uint256 amount) private {
        if (token == target) return;
        if (!_canSettle(token, target)) revert ArbitrageMustReturnToStart();
        uint256 nativeBefore = address(this).balance;
        uint256 sourceBefore = IERC20(token).balanceOf(address(this));
        uint256 targetBefore = IERC20(target).balanceOf(address(this));
        IWrappedNative(token).withdraw(amount);
        if (address(this).balance != nativeBefore + amount ||
            IERC20(token).balanceOf(address(this)) + amount != sourceBefore) revert InvalidWrappedNativeToken();
        IWrappedNative(target).deposit{value: amount}();
        if (address(this).balance != nativeBefore ||
            IERC20(target).balanceOf(address(this)) != targetBefore + amount) revert InvalidWrappedNativeToken();
    }

    function _startRouteSwap(ArbParams memory params) private {
        uint256 length = params.pools.length;
        if (length == 0 || length != params.protocols.length || length != params.fees.length || length != params.data.length)
            revert ArrayLengthMismatch();
        if (params.borrowAmount == 0 || params.borrowAmount > uint256(type(int256).max)) revert InvalidV3SwapDelta();
        for (uint256 i = 1; i < length; ++i) if (params.pools[i] == params.pools[0]) revert InvalidSplitPlan();
        uint8 protocol = params.protocols[0];
        if (protocol > V3) revert UnsupportedProtocol();
        bool input0 = _isToken0(params.pools[0], params.borrowToken);
        RouteFunding memory funding;
        funding.loan = abi.decode(_flashData(params, input0), (FlashData));
        funding.outputToken = input0 ? IUniswapV2Pair(params.pools[0]).token1() : IUniswapV2Pair(params.pools[0]).token0();
        funding.outputToken0 = !input0;
        funding.outputBefore = IERC20(funding.outputToken).balanceOf(address(this));
        if (protocol == V2) {
            (, funding.output,) = v2Logic.quote(params.pools[0], params.borrowToken, params.borrowAmount, params.fees[0], params.data[0]);
        }
        bytes memory data = abi.encode(funding);
        pendingFlashPool = params.pools[0];
        pendingFlashProtocol = protocol == V2 ? V2_ROUTE_FLASH : V3_ROUTE_FLASH;
        pendingFlashHash = keccak256(data);
        if (protocol == V2) {
            IUniswapV2Pair(params.pools[0]).swap(input0 ? 0 : funding.output, input0 ? funding.output : 0, address(this), data);
        } else {
            (int256 delta0, int256 delta1) = IUniswapV3Pool(params.pools[0]).swap(address(this), input0,
                int256(params.borrowAmount), input0 ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE, data);
            if ((input0 ? delta0 : delta1) != int256(params.borrowAmount)) revert InvalidV3SwapDelta();
        }
        if (pendingFlashHash != bytes32(0)) revert InvalidFlashLoanCallback();
        pendingFlashPool = address(0);
        pendingFlashProtocol = 0;
    }

    function _finishV3RouteSwap(int256 delta0, int256 delta1, bytes memory data) private {
        if (msg.sender != pendingFlashPool || pendingFlashProtocol != V3_ROUTE_FLASH) revert InvalidFlashLoanCallback();
        _consumeFlashPayload(data);
        RouteFunding memory funding = abi.decode(data, (RouteFunding));
        int256 owed = funding.outputToken0 ? delta1 : delta0;
        int256 output = funding.outputToken0 ? delta0 : delta1;
        if (owed != int256(funding.loan.borrowedAmount) || output >= 0) revert InvalidV3SwapDelta();
        _finishRouteSwap(funding);
    }

    function _finishRouteSwap(RouteFunding memory funding) private {
        uint256 received = IERC20(funding.outputToken).balanceOf(address(this)) - funding.outputBefore;
        if (received == 0) revert InvalidFlashLoanCallback();
        _executeRoute(funding.loan, funding.outputToken, received, 1);
        uint256 repay = funding.loan.borrowedAmount;
        address token = funding.loan.borrowedToken;
        if (IERC20(token).balanceOf(address(this)) < funding.loan.startBalance + repay) revert InsufficientFlashLoanRepayment();
        uint256 beforePayment = IERC20(token).balanceOf(address(this));
        _safeTransfer(token, msg.sender, repay);
        if (IERC20(token).balanceOf(address(this)) + repay != beforePayment) revert TokenTransferFailed();
    }
}
