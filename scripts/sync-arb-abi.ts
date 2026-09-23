// Run after forge build. The Solidity artifact is the only ABI source.
const artifact = await Bun.file(new URL('../out/forge/NArb.sol/ArbitrageExecutor.json', import.meta.url)).json();
if (!Array.isArray(artifact.abi) || !artifact.abi.some((item: { name?: string }) => item.name === 'executeSplitArbitrage')) {
  throw new Error('Build NArb before syncing its ABI');
}
await Bun.write(new URL('../src/ABI/Arb.json', import.meta.url), JSON.stringify(artifact.abi, null, 2) + '\n');
