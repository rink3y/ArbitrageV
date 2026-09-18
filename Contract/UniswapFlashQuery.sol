//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/UniswapV2Factory.sol";

interface IUniswapV3Pool {
	function factory() external view returns (address);
	function token0() external view returns (address);
	function token1() external view returns (address);
	function fee() external view returns (uint24);
	function tickSpacing() external view returns (int24);
	function liquidity() external view returns (uint128);
	function slot0()
		external
		view
		returns (
			uint160 sqrtPriceX96,
			int24 tick
		);
	function ticks(int24 tick)
		external
		view
		returns (
			uint128 liquidityGross,
			int128 liquidityNet,
			uint256 feeGrowthOutside0X128,
			uint256 feeGrowthOutside1X128,
			int56 tickCumulativeOutside,
			uint160 secondsPerLiquidityOutsideX128,
			uint32 secondsOutside,
			bool initialized
		);
	function tickBitmap(int16 wordPosition) external view returns (uint256);
}

interface ICarbonController {
	struct Order {
		uint128 y;
		uint128 z;
		uint64 A;
		uint64 B;
	}

	struct Strategy {
		uint256 id;
		address owner;
		address[2] tokens;
		Order[2] orders;
	}

	function strategiesByPair(
		address token0,
		address token1,
		uint256 startIndex,
		uint256 endIndex
	) external view returns (Strategy[] memory);

	function pairTradingFeePPM(address token0, address token1) external view returns (uint32);
}

error InvalidRange();

// In order to quickly load up data from Uniswap-like market, this contract allows easy iteration with a single eth_call
contract FlashUniswapQueryV1 {
	struct V3PoolMetadata {
		address pool;
		address factory;
		address token0;
		address token1;
		uint24 fee;
		int24 tickSpacing;
	}

	struct V3BitmapRequest { IUniswapV3Pool pool; int16 startWord; uint16 wordCount; }
	struct V3TicksRequest { IUniswapV3Pool pool; int24[] ticks; }

	function getV3PoolMetadata(IUniswapV3Pool[] calldata pools) external view returns (V3PoolMetadata[] memory result) {
		if (pools.length > 128) revert InvalidRange();
		result = new V3PoolMetadata[](pools.length);
		for (uint256 i; i < pools.length; ++i) {
			IUniswapV3Pool pool = pools[i];
			result[i] = V3PoolMetadata(address(pool), pool.factory(), pool.token0(), pool.token1(), pool.fee(), pool.tickSpacing());
		}
	}

	function getV3TickBitmapWords(V3BitmapRequest[] calldata requests) external view returns (V3BitmapData[][] memory result) {
		result = new V3BitmapData[][](requests.length);
		uint256 total;
		for (uint256 i; i < requests.length; ++i) {
			V3BitmapRequest calldata request = requests[i];
			total += request.wordCount;
			if (request.wordCount == 0 || request.wordCount > 256 || total > 1024) revert InvalidRange();
			result[i] = new V3BitmapData[](request.wordCount);
			for (uint256 j; j < request.wordCount; ++j) {
				int256 word = int256(request.startWord) + int256(j);
				if (word > type(int16).max) revert InvalidRange();
				result[i][j] = V3BitmapData(int16(word), request.pool.tickBitmap(int16(word)));
			}
		}
	}

	function getV3Ticks(V3TicksRequest[] calldata requests) external view returns (V3TickData[][] memory result) {
		result = new V3TickData[][](requests.length);
		uint256 total;
		for (uint256 i; i < requests.length; ++i) {
			total += requests[i].ticks.length;
			if (requests[i].ticks.length > 512 || total > 2048) revert InvalidRange();
			result[i] = new V3TickData[](requests[i].ticks.length);
			for (uint256 j; j < requests[i].ticks.length; ++j) {
				result[i][j] = _getV3Tick(requests[i].pool, requests[i].ticks[j]);
			}
		}
	}

	struct V3LiveState {
		address pool;
		uint160 sqrtPriceX96;
		int24 tick;
		uint128 liquidity;
	}

	struct V3BitmapData {
		int16 wordPosition;
		uint256 bitmap;
	}

	struct V3TickData {
		int24 tick;
		uint128 liquidityGross;
		int128 liquidityNet;
		bool initialized;
	}

	struct CarbonPairRequest {
		address token0;
		address token1;
		uint256 startIndex;
		uint256 endIndex;
	}

	struct CarbonPairStrategies {
		address token0;
		address token1;
		uint32 feePpm;
		ICarbonController.Strategy[] strategies;
	}

	function getReservesByPairs(IUniswapV2Pair[] calldata _pairs) external view returns (uint256[3][] memory) {
		uint256[3][] memory result = new uint256[3][](_pairs.length);
		for (uint256 i; i < _pairs.length; ) {
			(result[i][0], result[i][1], result[i][2]) = _pairs[i].getReserves();
			unchecked { ++i; }
		}
		return result;
	}

	function getV3LiveStates(IUniswapV3Pool[] calldata _pools) external view returns (V3LiveState[] memory) {
		V3LiveState[] memory result = new V3LiveState[](_pools.length);
		for (uint256 i; i < _pools.length; ) {
			result[i] = _getV3LiveState(_pools[i]);
			unchecked { ++i; }
		}
		return result;
	}

	function getCarbonStrategiesByPairs(
		ICarbonController _controller,
		CarbonPairRequest[] calldata _requests
	) external view returns (CarbonPairStrategies[] memory) {
		CarbonPairStrategies[] memory result = new CarbonPairStrategies[](_requests.length);
		for (uint256 i; i < _requests.length; ) {
			CarbonPairRequest calldata request = _requests[i];
			result[i] = CarbonPairStrategies({
				token0: request.token0,
				token1: request.token1,
				feePpm: _controller.pairTradingFeePPM(request.token0, request.token1),
				strategies: _controller.strategiesByPair(
					request.token0,
					request.token1,
					request.startIndex,
					request.endIndex
				)
			});
			unchecked { ++i; }
		}
		return result;
	}

	function _getV3LiveState(IUniswapV3Pool _pool) internal view returns (V3LiveState memory) {
		(uint160 sqrtPriceX96, int24 tick) = _pool.slot0();
		return V3LiveState({
			pool: address(_pool),
			sqrtPriceX96: sqrtPriceX96,
			tick: tick,
			liquidity: _pool.liquidity()
		});
	}

	function _getV3Tick(
		IUniswapV3Pool _pool,
		int24 _tick
	) internal view returns (V3TickData memory) {
			(
				uint128 liquidityGross,
				int128 liquidityNet,
				,
				,
				,
				,
				,
				bool initialized
			) = _pool.ticks(_tick);

			return V3TickData({
				tick: _tick,
				liquidityGross: liquidityGross,
				liquidityNet: liquidityNet,
				initialized: initialized
			});
	}

	function getPairsByIndexRange(
		UniswapV2Factory _uniswapFactory,
		uint256 _start,
		uint256 _stop
	) external view returns (address[3][] memory) {
		uint256 _allPairsLength = _uniswapFactory.allPairsLength();
		if (_stop > _allPairsLength) {
			_stop = _allPairsLength;
		}
		if (_stop < _start) revert InvalidRange();
		uint256 _qty = _stop - _start;
		address[3][] memory result = new address[3][](_qty);
		for (uint256 i; i < _qty; ) {
			IUniswapV2Pair _uniswapPair = IUniswapV2Pair(_uniswapFactory.allPairs(_start + i));
			result[i][0] = _uniswapPair.token0();
			result[i][1] = _uniswapPair.token1();
			result[i][2] = address(_uniswapPair);
			unchecked { ++i; }
		}
		return result;
	}

	function filterVolatileHermesPairs(IBaseV1Pair[] calldata _pairs) external view returns (bool[] memory) {
		bool[] memory result = new bool[](_pairs.length);
		for (uint256 i; i < _pairs.length; ) {
			(, , , , result[i], , ) = _pairs[i].metadata();
			unchecked { ++i; }
		}
		return result;
	}

	function getPairsLength(UniswapV2Factory[] calldata _factories) external view returns (uint256[] memory) {
		uint256[] memory result = new uint256[](_factories.length);
		for (uint256 i; i < _factories.length; ) {
			result[i] = _factories[i].allPairsLength();
			unchecked { ++i; }
		}
		return result;
	}
}
