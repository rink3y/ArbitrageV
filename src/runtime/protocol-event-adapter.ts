import { type Address, type PublicClient } from 'viem';

export interface ProtocolEventAdapter {
  readonly id: string;
  readonly managesOwnCursors?: boolean;
  addresses(): readonly Address[];
  owns(address: Address): boolean;
  watch(
    client: PublicClient,
    onLogs: (logs: any[]) => void | Promise<void>,
    onError: (error: any) => void | Promise<void>
  ): Promise<Array<() => void | Promise<void>>>;
  bufferKey(log: any): string | null;
  reconcile(logs: readonly any[]): Promise<void>;
  reconcileAddresses(addresses: readonly Address[]): Promise<void>;
  apply(logs: any[]): Promise<void>;
  clear?(): void | Promise<void>;
  suspend?(): void;
}
