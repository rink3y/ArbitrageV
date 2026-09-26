// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "../ExecutionTypes.sol";
import "../interfaces/IERC20.sol";
import "../interfaces/IBaseV1Pair.sol";
import "../interfaces/IUniswapV2Pair.sol";
contract V2Logic {
    function _safeTransfer(address token, address to, uint256 amount) private {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }
    uint256 private constant FEE_DENOMINATOR = 10000;
    uint256 private constant ONE = 1e18;
    struct V2Reserves {
        address token0;
        uint112 reserve0;
        uint112 reserve1;
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

    function swap(
        address tokenIn,
        uint256 amountIn,
        address pairAddr,
        uint256 fee,
        bytes memory quoteData,
        address recipient,
        bool inputAlreadySent
    ) external returns (address tokenOut, uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        V2Reserves memory reserves;
        reserves.token0 = pair.token0();
        (reserves.reserve0, reserves.reserve1, ) = pair.getReserves();
        uint256 reserveIn = tokenIn == reserves.token0 ? reserves.reserve0 : reserves.reserve1;
        if (!inputAlreadySent) {
            uint256 beforeInput = IERC20(tokenIn).balanceOf(address(this));
            _safeTransfer(tokenIn, pairAddr, amountIn);
            if (IERC20(tokenIn).balanceOf(address(this)) + amountIn != beforeInput) revert TokenTransferFailed();
        }
        // A forwarded or taxed transfer may deliver less than the previous nominal output.
        amountIn = IERC20(tokenIn).balanceOf(pairAddr) - reserveIn;
        bool zeroForOne;
        (tokenOut, amountOut, zeroForOne) = _quoteV2(pair, tokenIn, amountIn, fee, quoteData, reserves);
        uint256 beforeOutput = IERC20(tokenOut).balanceOf(recipient);
        pair.swap(
            zeroForOne ? 0 : amountOut,
            zeroForOne ? amountOut : 0,
            recipient,
            hex""
        );
        amountOut = IERC20(tokenOut).balanceOf(recipient) - beforeOutput;
    }

    function _quoteV2(
        IUniswapV2Pair pair,
        address tokenIn,
        uint256 amountIn,
        uint256 fee,
        bytes memory quoteData,
        V2Reserves memory reserves
    ) internal view returns (address tokenOut, uint256 amountOut, bool zeroForOne) {
        if (quoteData.length != 0) {
            if (quoteData.length != 1 || uint8(quoteData[0]) > 3 || quoteData[0] == 0x00) revert UnsupportedV2QuoteMode();
            if (quoteData[0] == 0x01 || quoteData[0] == 0x03) return _quoteStableV2(address(pair), tokenIn, amountIn, fee);
        }

        address token1 = pair.token1();
        zeroForOne = tokenIn == reserves.token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        uint256 reserveIn = zeroForOne ? reserves.reserve0 : reserves.reserve1;
        uint256 reserveOut = zeroForOne ? reserves.reserve1 : reserves.reserve0;
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        amountOut = _v2AmountOut(amountIn, reserveIn, reserveOut, fee);
        if (amountOut >= reserveOut) revert OutputExceedsReserve();
        tokenOut = zeroForOne ? token1 : reserves.token0;
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

    function _v2AmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - fee);
        return (amountInWithFee * reserveOut) / ((reserveIn * FEE_DENOMINATOR) + amountInWithFee);
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


    function quote(address pool, address token, uint256 amount, uint256 fee, bytes calldata data)
        external view returns (address, uint256, bool) {
        V2Reserves memory reserves;
        reserves.token0 = IUniswapV2Pair(pool).token0();
        (reserves.reserve0, reserves.reserve1,) = IUniswapV2Pair(pool).getReserves();
        return _quoteV2(IUniswapV2Pair(pool), token, amount, fee, data, reserves);
    }
}
