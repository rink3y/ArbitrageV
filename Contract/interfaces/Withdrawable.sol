// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";

error NotOwner();
error InvalidOwner();
error WithdrawalFailed();

abstract contract Withdrawable {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // Function to withdraw ERC20 tokens
    function withdrawToken(address tokenAddress, uint256 amount) external onlyOwner {
        if (!IERC20(tokenAddress).transfer(owner, amount)) revert WithdrawalFailed();
    }

    // Function to withdraw native tokens (e.g., ETH, METIS)
    function withdrawNative(uint256 amount) external onlyOwner {
        _withdrawNative(amount);
    }

    // Function to withdraw all native tokens
    function withdrawAllNative() external onlyOwner {
        _withdrawNative(address(this).balance);
    }

    // Function to withdraw all of a specific ERC20 token
    function withdrawAllToken(address tokenAddress) external onlyOwner {
        IERC20 token = IERC20(tokenAddress);
        if (!token.transfer(owner, token.balanceOf(address(this)))) revert WithdrawalFailed();
    }

    // Function to transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidOwner();
        owner = newOwner;
    }

    function _withdrawNative(uint256 amount) private {
        (bool success,) = payable(owner).call{value: amount}("");
        if (!success) revert WithdrawalFailed();
    }

    // Fallback function to receive Ether
    receive() external payable {}
}
