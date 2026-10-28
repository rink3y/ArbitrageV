// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IBaseV1Pair {
    function metadata()
        external
        view
        returns (
            uint256 dec0,
            uint256 dec1,
            uint256 r0,
            uint256 r1,
            bool isVolatile,
            address token0,
            address token1
        );
}
