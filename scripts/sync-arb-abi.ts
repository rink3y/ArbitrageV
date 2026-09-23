// Run after forge build. Solidity artifacts are the only ABI source.
for (const [artifactPath, output, required] of [
  ['NArb.sol/ArbitrageExecutor', 'Arb', 'probeV2Transfer'],
  ['UniswapFlashQuery.sol/FlashUniswapQueryV1', 'UniswapFlashQuery', 'probeV2Transfers'],
]) {
  const artifact = await Bun.file(new URL(`../out/forge/${artifactPath}.json`, import.meta.url)).json();
  if (!Array.isArray(artifact.abi) || !artifact.abi.some((item: { name?: string }) => item.name === required)) {
    throw new Error(`Build ${artifactPath} before syncing its ABI`);
  }
  await Bun.write(new URL(`../src/ABI/${output}.json`, import.meta.url), JSON.stringify(artifact.abi, null, 2) + '\n');
}
