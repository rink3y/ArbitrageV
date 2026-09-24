// SPDX-License-Identifier: MIT
//v2, v3 & carbon
pragma solidity ^0.8.0;

import "./interfaces/Withdrawable.sol";
import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./TransferProbe.sol";

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface ICarbonController {
    struct TradeAction {
        uint256 strategyId;
        uint128 amount;
    }

    function tradeBySourceAmount(
        address sourceToken,
        address targetToken,
        TradeAction[] calldata tradeActions,
        uint256 deadline,
        uint128 minReturn
    ) external payable returns (uint128);
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

error ArrayLengthMismatch();
error StartTokenNotInFlashLoanPair();
error ArbitrageMustReturnToStart();
error RepaymentTransferFailed();
error InsufficientFlashLoanRepayment();
error NoProfit();
error InsufficientProfitAfterGas(uint256 profit, uint256 gasCost);
error SwapPathError();
error InvalidReserves();
error OutputExceedsReserve();
error TokenTransferFailed();
error UnsupportedProtocol();
error InvalidV3SwapCallback();
error InvalidV3SwapDelta();
error InvalidFlashLoanCallback();
error InvalidCarbonAmount();
error CarbonApprovalFailed();
error UnsupportedV2QuoteMode();
error InvalidStablePair();
error StableSolverDidNotConverge();
error InvalidSplitPlan();
error SplitMinimumNotMet();
error ExecutionInProgress();
error InvalidWrappedNativeToken();

contract ArbitrageExecutor is Withdrawable, TransferProbe {
    uint8 private constant V2 = 0;
    uint8 private constant V3 = 1;
    uint8 private constant CARBON = 2;
    address private constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public immutable wrappedNativeToken;
    uint256 private constant FEE_DENOMINATOR = 10000;
    // Entry dispatch/owner check before gasleft(), plus the final check and lock cleanup.
    uint256 private constant GAS_ACCOUNTING_OVERHEAD = 10_000;
    uint256 private constant ONE = 1e18;
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    uint8 private pendingFlashProtocol;
    address private pendingFlashPool;
    address private pendingV3Pool;
    address private pendingV3Token;
    uint256 private pendingV3Amount;
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

    struct StablePairState {
        uint256 scale0;
        uint256 scale1;
        uint256 reserve0;
        uint256 reserve1;
        bool stable;
        address token0;
        address token1;
    }

    constructor(address owner_, address wrappedNativeToken_) Withdrawable(owner_) {
        if (wrappedNativeToken_ == NATIVE_TOKEN || wrappedNativeToken_.code.length == 0) revert InvalidWrappedNativeToken();
        wrappedNativeToken = wrappedNativeToken_;
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
        if (token != wrappedNativeToken) return;

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
        if (
            params.pools.length != params.protocols.length ||
            params.pools.length != params.fees.length ||
            params.pools.length != params.data.length
        ) revert ArrayLengthMismatch();
        bool borrowToken0 = _isToken0(params.flashPool, params.borrowToken);
        _startFlashLoan(params, borrowToken0, _flashData(params, borrowToken0));
    }

    function executeSplitArbitrage(SplitParams calldata params) external onlyOwner executionLock(params.borrowToken) {
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

    function _validateSplit(SplitParams calldata params) private view {
        if (params.deadline < block.timestamp || params.borrowAmount == 0 || params.stages.length < 2 || params.stages.length > 3 ||
            params.flashPool.code.length == 0 || params.flashProtocol > V3 || params.v2RepayFee >= FEE_DENOMINATOR) revert InvalidSplitPlan();
        address token = params.borrowToken;
        uint256 available = params.borrowAmount;
        uint256 swaps;
        bytes32[] memory used = new bytes32[](48);
        uint256 usedCount;
        for (uint256 i; i < params.stages.length; ++i) {
            SplitStage calldata stage = params.stages[i];
            if (stage.tokenIn != token || stage.tokenIn == stage.tokenOut || stage.branches.length == 0 || stage.branches.length > 2 ||
                (i + 1 < params.stages.length && stage.tokenOut == params.borrowToken)) revert InvalidSplitPlan();
            for (uint256 prior; prior < i; ++prior) if (params.stages[prior].tokenIn == stage.tokenIn) revert InvalidSplitPlan();
            uint256 spent;
            uint256 proceeds;
            for (uint256 j; j < stage.branches.length; ++j) {
                SplitBranch calldata branch = stage.branches[j];
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
        if (swaps > 6 || token != params.borrowToken) revert InvalidSplitPlan();
    }

    function _splitResources(SplitBranch calldata branch) private pure returns (bytes32[] memory resources) {
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
        if (msg.sender == pendingV3Pool && pendingV3Pool != address(0)) {
            (int256 amount0Delta, int256 amount1Delta, ) =
                abi.decode(msg.data[4:], (int256, int256, bytes));
            _finishV3SwapCallback(amount0Delta, amount1Delta);
            return;
        }

        if (msg.sender != pendingFlashPool || msg.data.length < 132) {
            revert InvalidFlashLoanCallback();
        }

        if (pendingFlashProtocol == V3) {
            (uint256 fee0, uint256 fee1, bytes memory flashPayload) =
                abi.decode(msg.data[4:], (uint256, uint256, bytes));
            _consumeFlashPayload(flashPayload);
            FlashData memory v3Loan = abi.decode(flashPayload, (FlashData));
            _finishFlashLoan(v3Loan, v3Loan.borrowedAmount + (v3Loan.borrowedToken0 ? fee0 : fee1));
            return;
        }

        if (pendingFlashProtocol != V2) revert InvalidFlashLoanCallback();

        (address sender, uint256 amount0, uint256 amount1, bytes memory data) =
            abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        if (sender != address(this)) revert InvalidFlashLoanCallback();

        _consumeFlashPayload(data);

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

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _finishV3SwapCallback(amount0Delta, amount1Delta);
    }

    function _finishV3SwapCallback(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != pendingV3Pool || pendingV3Pool == address(0)) revert InvalidV3SwapCallback();

        address owedToken;
        uint256 owedAmount;
        if (amount0Delta > 0 && amount1Delta <= 0) {
            owedToken = IUniswapV3Pool(msg.sender).token0(); owedAmount = uint256(amount0Delta);
        } else if (amount1Delta > 0 && amount0Delta <= 0) {
            owedToken = IUniswapV3Pool(msg.sender).token1(); owedAmount = uint256(amount1Delta);
        } else {
            revert InvalidV3SwapDelta();
        }
        if (owedToken != pendingV3Token || owedAmount != pendingV3Amount) revert InvalidV3SwapDelta();
        pendingV3Pool = address(0);
        pendingV3Amount = 0;
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
        address token = loan.borrowedToken;
        uint256 amount = loan.borrowedAmount;

        for (uint256 i; i < loan.pools.length; ) {
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
                    i > 0 && loan.protocols[i - 1] == V2 && loan.pools[i - 1] != loan.pools[i] &&
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

        if (token != loan.borrowedToken) revert ArbitrageMustReturnToStart();
        return amount;
    }

    function _swapV2(
        address tokenIn,
        uint256 amountIn,
        address pairAddr,
        uint256 fee,
        bytes memory quoteData,
        address recipient,
        bool inputAlreadySent
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        uint256 reserveIn = tokenIn == pair.token0() ? reserve0 : reserve1;
        if (!inputAlreadySent) {
            uint256 beforeInput = IERC20(tokenIn).balanceOf(address(this));
            _safeTransfer(tokenIn, pairAddr, amountIn);
            if (IERC20(tokenIn).balanceOf(address(this)) + amountIn != beforeInput) revert TokenTransferFailed();
        }
        // A forwarded or taxed transfer may deliver less than the previous nominal output.
        amountIn = IERC20(tokenIn).balanceOf(pairAddr) - reserveIn;
        bool zeroForOne;
        (tokenOut, amountOut, zeroForOne) = _quoteV2(pair, tokenIn, amountIn, fee, quoteData);
        uint256 beforeOutput = IERC20(tokenOut).balanceOf(recipient);
        pair.swap(
            zeroForOne ? 0 : amountOut,
            zeroForOne ? amountOut : 0,
            recipient,
            hex""
        );
        amountOut = IERC20(tokenOut).balanceOf(recipient) - beforeOutput;
    }

    function _custodyV2(bytes memory data) private pure returns (bool) {
        return data.length == 1 && (data[0] == 0x02 || data[0] == 0x03);
    }

    function _quoteV2(
        IUniswapV2Pair pair,
        address tokenIn,
        uint256 amountIn,
        uint256 fee,
        bytes memory quoteData
    ) internal view returns (address tokenOut, uint256 amountOut, bool zeroForOne) {
        if (quoteData.length != 0) {
            if (quoteData.length != 1 || uint8(quoteData[0]) > 3 || quoteData[0] == 0x00) revert UnsupportedV2QuoteMode();
            if (quoteData[0] == 0x01 || quoteData[0] == 0x03) return _quoteStableV2(address(pair), tokenIn, amountIn, fee);
        }

        address token0 = pair.token0();
        address token1 = pair.token1();
        zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        amountOut = _v2AmountOut(amountIn, reserveIn, reserveOut, fee);
        if (amountOut >= reserveOut) revert OutputExceedsReserve();
        tokenOut = zeroForOne ? token1 : token0;
    }

    function _quoteStableV2(
        address pair,
        address tokenIn,
        uint256 amountIn,
        uint256 fee
    ) internal view returns (address tokenOut, uint256 amountOut, bool zeroForOne) {
        StablePairState memory state = _stablePairState(pair);
        if (!state.stable) revert InvalidStablePair();

        zeroForOne = tokenIn == state.token0;
        if (!zeroForOne && tokenIn != state.token1) revert SwapPathError();
        if (state.reserve0 == 0 || state.reserve1 == 0 || state.scale0 == 0 || state.scale1 == 0) revert InvalidReserves();

        amountOut = zeroForOne
            ? _stableAmountOut(amountIn, state.reserve0, state.reserve1, state.scale0, state.scale1, fee)
            : _stableAmountOut(amountIn, state.reserve1, state.reserve0, state.scale1, state.scale0, fee);
        if (amountOut >= (zeroForOne ? state.reserve1 : state.reserve0)) revert OutputExceedsReserve();
        tokenOut = zeroForOne ? state.token1 : state.token0;
    }

    function _stablePairState(address pair) private view returns (StablePairState memory state) {
        (
            state.scale0,
            state.scale1,
            state.reserve0,
            state.reserve1,
            state.stable,
            state.token0,
            state.token1
        ) = IBaseV1Pair(pair).metadata();
    }

    function _swapV3(
        address tokenIn,
        uint256 amountIn,
        address poolAddr
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddr);
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        tokenOut = zeroForOne ? token1 : token0;

        pendingV3Pool = poolAddr;
        if (amountIn > uint256(type(int256).max)) revert InvalidV3SwapDelta();
        pendingV3Token = tokenIn;
        pendingV3Amount = amountIn;
        (int256 amount0, int256 amount1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            hex""
        );
        if (pendingV3Pool != address(0) || (zeroForOne ? amount0 : amount1) != int256(amountIn)) revert InvalidV3SwapDelta();
        pendingV3Token = address(0);

        int256 outputDelta = zeroForOne ? amount1 : amount0;
        if (outputDelta >= 0) revert InvalidV3SwapDelta();
        amountOut = uint256(-outputDelta);
    }

    function _swapCarbon(
        address tokenIn,
        uint256 amountIn,
        address controller,
        bytes memory data
    ) internal returns (address tokenOut, uint256 amountOut) {
        if (amountIn > type(uint128).max) revert InvalidCarbonAmount();

        address rawSourceToken;
        address rawTargetToken;
        ICarbonController.TradeAction[] memory actions;
        if (data.length == 96) {
            uint256 strategyId;
            (strategyId, rawSourceToken, rawTargetToken) = abi.decode(data, (uint256, address, address));
            actions = new ICarbonController.TradeAction[](1);
            actions[0] = ICarbonController.TradeAction({strategyId: strategyId, amount: uint128(amountIn)});
        } else {
            uint256[] memory strategyIds;
            uint128[] memory amounts;
            (rawSourceToken, rawTargetToken, strategyIds, amounts) =
                abi.decode(data, (address, address, uint256[], uint128[]));
            if (strategyIds.length == 0 || strategyIds.length != amounts.length) revert SwapPathError();

            actions = new ICarbonController.TradeAction[](strategyIds.length);
            uint256 totalActionAmount;
            for (uint256 i; i < strategyIds.length; ) {
                totalActionAmount += amounts[i];
                actions[i] = ICarbonController.TradeAction({
                    strategyId: strategyIds[i],
                    amount: amounts[i]
                });
                unchecked { ++i; }
            }
            if (totalActionAmount != amountIn) revert InvalidCarbonAmount();
        }
        bool sourceIsNative = rawSourceToken == NATIVE_TOKEN;
        bool targetIsNative = rawTargetToken == NATIVE_TOKEN;
        tokenOut = targetIsNative ? wrappedNativeToken : rawTargetToken;
        if (sourceIsNative && tokenIn != wrappedNativeToken) revert SwapPathError();
        if (!sourceIsNative && tokenIn != rawSourceToken) revert SwapPathError();

        if (sourceIsNative) {
            IWrappedNative(wrappedNativeToken).withdraw(amountIn);
        } else {
            _approveCarbonIfNeeded(tokenIn, controller, amountIn);
        }

        uint256 balanceBefore = targetIsNative
            ? address(this).balance
            : IERC20(rawTargetToken).balanceOf(address(this));

        ICarbonController(controller).tradeBySourceAmount{value: sourceIsNative ? amountIn : 0}(
            rawSourceToken,
            rawTargetToken,
            actions,
            block.timestamp,
            1
        );
        if (!sourceIsNative && IERC20(tokenIn).allowance(address(this), controller) != 0 &&
            !IERC20(tokenIn).approve(controller, 0)) revert CarbonApprovalFailed();

        if (targetIsNative) {
            amountOut = address(this).balance - balanceBefore;
            IWrappedNative(wrappedNativeToken).deposit{value: amountOut}();
        } else {
            amountOut = IERC20(rawTargetToken).balanceOf(address(this)) - balanceBefore;
        }

        if (amountOut == 0) revert SwapPathError();
    }

    function _approveCarbonIfNeeded(address token, address controller, uint256 amount) internal {
        uint256 allowance = IERC20(token).allowance(address(this), controller);
        if (allowance == amount) return;

        if (allowance != 0 && !IERC20(token).approve(controller, 0)) revert CarbonApprovalFailed();
        if (!IERC20(token).approve(controller, amount)) revert CarbonApprovalFailed();
    }

    function _isToken0(address pool, address token) internal view returns (bool) {
        address token0 = IUniswapV2Pair(pool).token0();
        if (token == token0) return true;
        if (token != IUniswapV2Pair(pool).token1()) revert StartTokenNotInFlashLoanPair();
        return false;
    }

    function _flashData(ArbParams calldata params, bool borrowedToken0) internal view returns (bytes memory) {
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

    function _v2AmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - fee);
        return (amountInWithFee * reserveOut) / ((reserveIn * FEE_DENOMINATOR) + amountInWithFee);
    }

    function _v2RepayAmount(uint256 borrowedAmount, uint256 fee) internal pure returns (uint256) {
        uint256 denominator = FEE_DENOMINATOR - fee;
        return borrowedAmount + ((borrowedAmount * fee + denominator - 1) / denominator);
    }

    function _stableAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 scaleIn,
        uint256 scaleOut,
        uint256 fee
    ) internal pure returns (uint256) {
        amountIn -= (amountIn * fee) / FEE_DENOMINATOR;
        uint256 normalizedIn = (reserveIn * ONE) / scaleIn;
        uint256 normalizedOut = (reserveOut * ONE) / scaleOut;
        uint256 invariant = _stableK(normalizedIn, normalizedOut);
        uint256 nextOut = _stableY(
            normalizedIn + (amountIn * ONE) / scaleIn,
            invariant,
            normalizedOut
        );
        return ((normalizedOut - nextOut) * scaleOut) / ONE;
    }

    function _stableK(uint256 x, uint256 y) private pure returns (uint256) {
        uint256 a = (x * y) / ONE;
        uint256 b = ((x * x) / ONE) + ((y * y) / ONE);
        return (a * b) / ONE;
    }

    function _stableF(uint256 x, uint256 x3, uint256 y) private pure returns (uint256) {
        return _stableF(x, x3, y, (y * y) / ONE);
    }

    function _stableF(uint256 x, uint256 x3, uint256 y, uint256 y2) private pure returns (uint256) {
        return (x * ((y2 * y) / ONE)) / ONE + (x3 * y) / ONE;
    }

    function _stableY(uint256 x, uint256 invariant, uint256 y) private pure returns (uint256) {
        uint256 x3 = ((((x * x) / ONE) * x) / ONE);
        for (uint256 i; i < 255; ) {
            uint256 y2 = (y * y) / ONE;
            uint256 k = _stableF(x, x3, y, y2);
            uint256 d = (3 * x * y2) / ONE + x3;
            if (d == 0) revert InvalidReserves();

            if (k < invariant) {
                uint256 dy = ((invariant - k) * ONE) / d;
                if (dy == 0) {
                    if (k == invariant) return y;
                    if (_stableF(x, x3, y + 1) > invariant) return y + 1;
                    dy = 1;
                }
                y += dy;
            } else {
                uint256 dy = ((k - invariant) * ONE) / d;
                if (dy == 0) {
                    if (k == invariant || _stableF(x, x3, y - 1) < invariant) return y;
                    dy = 1;
                }
                y -= dy;
            }
            unchecked { ++i; }
        }
        revert StableSolverDidNotConverge();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }
}
