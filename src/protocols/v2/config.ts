import { type Address } from 'viem';
import { tokenAmount } from '../../values';

export type DexFactoryConfig = {
  name: string;
  address: Address;
  fee: number;
  kind: 'uniswap-v2' | 'solidly';
};

export const V2_DISCOVERY_POLICY = {
  batchSize: 200,
  solidlyReserveBatchSize: 5,
  maxPairAgeSeconds: 700 * 24 * 60 * 60,
  minOtherTokenLiquidity: tokenAmount('500'),
} as const;

export const V2_LIVE_POLICY = {
  recoveryLogsPerPool: 2_048,
  // Requires the updated NArb and FlashQuery deployments. No probe RPCs during search.
  transferFees: true,
  transferRefreshMs: 4 *60 * 60 * 1000,
  transferBatchSize: 8,
  transferConcurrency: 4,
  transferProbeGas: 600_000,
  // Probe 0.000001%, 0.001%, 0.1%, and 25% of each reserve, without committing swaps.
  transferSampleDivisors: [100_000_000n, 100_000n, 1_000n, 4n],
} as const;

export const V2_FACTORIES: readonly DexFactoryConfig[] = [
  { name: 'VVS Finance', address: '0x3B44B2a187a7b3824131F8db5a74194D0a42Fc15', fee: 30, kind: 'uniswap-v2' },
  { name: 'CyborgSwap', address: '0x6C50Ee65CFcfC59B09C570e55D76daa7c67D6da5', fee: 20, kind: 'uniswap-v2' },
  { name: 'Obsidian', address: '0xCd2E5cC83681d62BEb066Ad0a2ec94Bf301570C9', fee: 30, kind: 'uniswap-v2' },
  { name: 'Meerkat', address: '0xd590cC180601AEcD6eeADD9B7f2B7611519544f4', fee: 17, kind: 'uniswap-v2' },
  { name: 'Cronoswap', address: '0x73A48f8f521EB31c55c0e1274dB0898dE599Cb11', fee: 25, kind: 'uniswap-v2' },
  { name: 'Candy', address: '0x84343b84EEd78228CCFB65EAdEe7659F246023bf', fee: 15, kind: 'uniswap-v2' },
  { name: 'DuckyDefi', address: '0x796E38Bb00f39a3D39ab75297D8d6202505f52e2', fee: 25, kind: 'uniswap-v2' },
  { name: 'ProtonSwap', address: '0x462C98Cae5AffEED576c98A55dAA922604e2D875', fee: 30, kind: 'uniswap-v2' },
  { name: 'CroDex', address: '0xe9c29cB475C0ADe80bE0319B74AD112F1e80058F', fee: 30, kind: 'uniswap-v2' },
  { name: 'AnneDex', address: '0xfb6fe7d66e55831b7e108b77d11b8e4d479c2986', fee: 20, kind: 'uniswap-v2' },
  { name: 'EmpireDex', address: '0x06530550a48f990360dfd642d2132354a144f31d', fee: 30, kind: 'uniswap-v2' },
  { name: 'SmolSwap', address: '0x7Aa2149fF9EF4A09D4ace72C49C26AaE8C89Fb48', fee: 30, kind: 'uniswap-v2' },
  // { name: 'CroSwap', address: '0x4aE2bD26e60741890Edb9e5C7e984BB396eC26e3', fee: 20, kind: 'uniswap-v2' },
  { name: 'Swapp', address: '0xEe4fa96b695De795071d40EEad0e8Fd42cdB9951', fee: 25, kind: 'uniswap-v2' },
  { name: 'Agile', address: '0xb89E86701C4Fe4a22a16914e3b0Df53eA4BE771b', fee: 20, kind: 'uniswap-v2' },
  { name: 'ElkProtocol', address: '0xEEa0e2830D09D8786Cb9F484cA20898b61819ef1', fee: 30, kind: 'uniswap-v2' },
  { name: 'KyptoDex', address: '0x33c04bD4Ae93336BbD1024D709f4A313cC858EBe', fee: 25, kind: 'uniswap-v2' },
];
