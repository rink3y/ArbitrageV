// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;
import "../ExecutionTypes.sol";
import "../interfaces/IERC20.sol";
contract CarbonLogic {
    address private constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    function swap(
        address tokenIn,
        uint256 amountIn,
        address controller,
        bytes memory data,
        address wrappedNativeToken
    ) external returns (address tokenOut, uint256 amountOut) {
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

}
