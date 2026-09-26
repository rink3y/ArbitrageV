// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "../../Contract/UniswapFlashQuery.sol";

contract MockV3Pool is IUniswapV3Pool {
    address public immutable factory;
    address public immutable token0;
    address public constant token1 = address(2);
    uint24 public constant fee = 3000;
    int24 public constant tickSpacing = 60;
    uint128 public constant liquidity = 1000;

    constructor(address token) { factory = msg.sender; token0 = token; }

    function slot0() external pure returns (uint160, int24) { return (uint160(1) << 96, -60); }
    function tickBitmap(int16 word) external pure returns (uint256) { return uint256(uint16(word)) + 1; }
    function ticks(int24 tick) external pure returns (uint128, int128, uint256, uint256, int56, uint160, uint32, bool) {
        return (tick == 0 ? 0 : 1000, tick < 0 ? int128(1000) : tick > 0 ? int128(-1000) : int128(0), 0, 0, 0, 0, 0, tick != 0);
    }
}

contract UniswapFlashQueryTest {
    FlashUniswapQueryV1 private query;
    MockV3Pool private pool;

    function setUp() public {
        query = new FlashUniswapQueryV1();
        pool = new MockV3Pool(address(1));
    }

    function testMetadataAndLiveStatePreservePoolOrder() public {
        IUniswapV3Pool[] memory pools = new IUniswapV3Pool[](2);
        pools[0] = pool;
        pools[1] = new MockV3Pool(address(3));
        FlashUniswapQueryV1.V3PoolMetadata[] memory metadata = query.getV3PoolMetadata(pools);
        require(metadata.length == 2 && metadata[0].pool == address(pool));
        require(metadata[0].factory == address(this) && metadata[0].token0 == address(1));
        require(metadata[1].token0 == address(3) && metadata[1].token1 == address(2));
        require(metadata[1].fee == 3000 && metadata[1].tickSpacing == 60);
        FlashUniswapQueryV1.V3LiveState[] memory live = query.getV3LiveStates(pools);
        require(live[1].pool == address(pools[1]) && live[1].liquidity == 1000);
        require(live[0].tick == -60 && live[0].sqrtPriceX96 == uint160(1) << 96);
    }

    function testBitmapPagesIncludeEveryWordAcrossZero() public view {
        FlashUniswapQueryV1.V3BitmapRequest[] memory requests = new FlashUniswapQueryV1.V3BitmapRequest[](1);
        requests[0] = FlashUniswapQueryV1.V3BitmapRequest(pool, -2, 4);
        FlashUniswapQueryV1.V3BitmapData[][] memory result = query.getV3TickBitmapWords(requests);
        require(result.length == 1 && result[0].length == 4);
        for (uint256 i; i < 4; i++) {
            int16 position = int16(int256(i) - 2);
            require(result[0][i].wordPosition == position);
            require(result[0][i].bitmap == uint256(uint16(position)) + 1);
        }
    }

    function testTickReadsIncludeDeletedTicksInRequestedOrder() public view {
        FlashUniswapQueryV1.V3TicksRequest[] memory requests = new FlashUniswapQueryV1.V3TicksRequest[](1);
        int24[] memory indexes = new int24[](3);
        indexes[0] = -60; indexes[1] = 0; indexes[2] = 60;
        requests[0] = FlashUniswapQueryV1.V3TicksRequest(pool, indexes);
        FlashUniswapQueryV1.V3TickData[][] memory result = query.getV3Ticks(requests);
        require(result[0].length == 3);
        require(result[0][0].tick == -60 && result[0][0].liquidityNet == 1000);
        require(!result[0][1].initialized && result[0][1].liquidityGross == 0);
        require(result[0][2].initialized && result[0][2].liquidityNet == -1000);
    }

    function testMultipleTickPagesAreNotTruncatedAt512() public view {
        FlashUniswapQueryV1.V3TicksRequest[] memory requests = new FlashUniswapQueryV1.V3TicksRequest[](2);
        for (uint256 page; page < 2; page++) {
            int24[] memory indexes = new int24[](300);
            for (uint256 i; i < 300; i++) indexes[i] = int24(int256(page * 300 + i + 1));
            requests[page] = FlashUniswapQueryV1.V3TicksRequest(pool, indexes);
        }
        FlashUniswapQueryV1.V3TickData[][] memory result = query.getV3Ticks(requests);
        require(result[0].length == 300 && result[1].length == 300);
        require(result[1][299].tick == 600);
    }

    function testRejectsInvalidBitmapBoundsAndTotal() public view {
        FlashUniswapQueryV1.V3BitmapRequest[] memory requests = new FlashUniswapQueryV1.V3BitmapRequest[](1);
        requests[0] = FlashUniswapQueryV1.V3BitmapRequest(pool, 0, 0);
        mustRevert(abi.encodeCall(query.getV3TickBitmapWords, (requests)));
        requests[0].wordCount = 257;
        mustRevert(abi.encodeCall(query.getV3TickBitmapWords, (requests)));
        requests[0] = FlashUniswapQueryV1.V3BitmapRequest(pool, type(int16).max, 2);
        mustRevert(abi.encodeCall(query.getV3TickBitmapWords, (requests)));
        requests = new FlashUniswapQueryV1.V3BitmapRequest[](5);
        for (uint256 i; i < 5; i++) requests[i] = FlashUniswapQueryV1.V3BitmapRequest(pool, 0, 256);
        mustRevert(abi.encodeCall(query.getV3TickBitmapWords, (requests)));
    }

    function testRejectsOversizedTickAndMetadataBatches() public view {
        FlashUniswapQueryV1.V3TicksRequest[] memory requests = new FlashUniswapQueryV1.V3TicksRequest[](1);
        requests[0] = FlashUniswapQueryV1.V3TicksRequest(pool, new int24[](513));
        mustRevert(abi.encodeCall(query.getV3Ticks, (requests)));
        requests = new FlashUniswapQueryV1.V3TicksRequest[](5);
        for (uint256 i; i < 5; i++) requests[i] = FlashUniswapQueryV1.V3TicksRequest(pool, new int24[](512));
        mustRevert(abi.encodeCall(query.getV3Ticks, (requests)));
        IUniswapV3Pool[] memory pools = new IUniswapV3Pool[](129);
        mustRevert(abi.encodeCall(query.getV3PoolMetadata, (pools)));
    }

    function mustRevert(bytes memory data) private view {
        (bool success, bytes memory reason) = address(query).staticcall(data);
        require(!success && bytes4(reason) == InvalidRange.selector, "Expected InvalidRange");
    }
}
