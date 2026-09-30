// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";
import "./interfaces/IUniswapV2Pair.sol";

error TransferProbeResult(uint256[9] amounts);
error TransferProbeFailed();

// Inherited by NArb so tokens see the execution address, not a query helper.
abstract contract TransferProbe {
    address private probePool;
    address private probeToken;
    address private probeRecipient;
    uint256 private probeAmount;
    uint256 private probePoolBalance;
    uint256 private probeOwnBalance;

    function _probeTransfer(address pool, address token, uint256 amount, address recipient) internal {
        if (amount == 0 || recipient == address(this) || recipient == pool || recipient == address(0)) revert TransferProbeFailed();
        bool zero = IUniswapV2Pair(pool).token0() == token;
        if (!zero && IUniswapV2Pair(pool).token1() != token) revert TransferProbeFailed();
        probePool = pool;
        probeToken = token;
        probeRecipient = recipient;
        probeAmount = amount;
        probePoolBalance = IERC20(token).balanceOf(pool);
        probeOwnBalance = IERC20(token).balanceOf(address(this));
        IUniswapV2Pair(pool).swap(zero ? amount : 0, zero ? 0 : amount, address(this), abi.encode(amount));
        revert TransferProbeFailed(); // Never persist a probe, even with a nonstandard pool.
    }

    function _isTransferProbe() internal view returns (bool) { return probePool != address(0); }

    function _transferProbeCallback() internal {
        if (msg.sender != probePool) revert TransferProbeFailed();
        (address sender, uint256 amount0, uint256 amount1, bytes memory data) =
            abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        if (sender != address(this) || amount0 + amount1 != probeAmount || keccak256(data) != keccak256(abi.encode(probeAmount))) revert TransferProbeFailed();
        uint256[9] memory amounts;
        amounts[0] = probeAmount;
        amounts[1] = probePoolBalance - IERC20(probeToken).balanceOf(probePool);
        amounts[2] = IERC20(probeToken).balanceOf(address(this)) - probeOwnBalance;
        // Each leg has its own measured amount. Neither spends existing executor inventory.
        amounts[6] = amounts[2] / 2;
        (amounts[7], amounts[8]) = _measureTransfer(probeRecipient, amounts[6]);
        amounts[3] = amounts[2] - amounts[6];
        (amounts[4], amounts[5]) = _measureTransfer(probePool, amounts[3]);
        revert TransferProbeResult(amounts);
    }

    function _measureTransfer(address to, uint256 amount) private returns (uint256 debited, uint256 credited) {
        uint256 beforeSender = IERC20(probeToken).balanceOf(address(this));
        uint256 beforeRecipient = IERC20(probeToken).balanceOf(to);
        (bool ok, bytes memory result) = probeToken.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TransferProbeFailed();
        debited = beforeSender - IERC20(probeToken).balanceOf(address(this));
        credited = IERC20(probeToken).balanceOf(to) - beforeRecipient;
    }
}
