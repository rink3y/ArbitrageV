// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

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


library ExecutionState {
    // Ordinary V3 swaps can occur inside a funding callback. Keep their callback
    // context separate from NArb's funding context and from inherited storage.
    bytes32 internal constant SLOT = keccak256("narb.execution.v3.callback");
    struct V3Callback { address pool; address token; uint256 amount; }
    function v3() internal pure returns (V3Callback storage state) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") { state.slot := slot }
    }
}
