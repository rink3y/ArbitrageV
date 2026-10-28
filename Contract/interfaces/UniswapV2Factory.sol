// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface UniswapV2Factory {
    function allPairs(uint256 index) external view returns (address pair);
    function allPairsLength() external view returns (uint256);
}
