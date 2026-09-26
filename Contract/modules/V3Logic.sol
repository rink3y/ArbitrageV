// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "../ExecutionTypes.sol";
import "../interfaces/IERC20.sol";
contract V3Logic {
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    function swap(
        address tokenIn,
        uint256 amountIn,
        address poolAddr
    ) external returns (address tokenOut, uint256 amountOut) {
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddr);
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        tokenOut = zeroForOne ? token1 : token0;

        ExecutionState.v3().pool = poolAddr;
        if (amountIn > uint256(type(int256).max)) revert InvalidV3SwapDelta();
        ExecutionState.v3().token = tokenIn;
        ExecutionState.v3().amount = amountIn;
        (int256 amount0, int256 amount1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            hex""
        );
        if (ExecutionState.v3().pool != address(0) || (zeroForOne ? amount0 : amount1) != int256(amountIn)) revert InvalidV3SwapDelta();
        ExecutionState.v3().token = address(0);

        int256 outputDelta = zeroForOne ? amount1 : amount0;
        if (outputDelta >= 0) revert InvalidV3SwapDelta();
        amountOut = uint256(-outputDelta);
    }

}
