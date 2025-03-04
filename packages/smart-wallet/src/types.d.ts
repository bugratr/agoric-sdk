/**
 * @file Some types for smart-wallet contract
 *
 * Similar to types.js but in TypeScript syntax because some types here need it.
 * Downside is it can't reference any ambient types, which most of agoric-sdk type are presently.
 */

import { ERef, FarRef } from '@endo/far';
import type { CapData } from '@endo/marshal';
import type { MsgWalletSpendAction } from '@agoric/cosmic-proto/swingset/msgs';

declare const CapDataShape: unique symbol;

/**
 * A petname can either be a plain string or a path for which the first element
 * is a petname for the origin, and the rest of the elements are a snapshot of
 * the names that were first given by that origin.  We are migrating away from
 * using plain strings, for consistency.
 */
export type Petname = string | string[];

export type RemotePurse<T = unknown> = FarRef<Purse<T>>;

export type RemoteInvitationMakers = FarRef<
  Record<string, (...args: any[]) => Promise<Invitation>>
>;

export type PublicSubscribers = Record<string, ERef<StoredFacet>>;

export type Cell<T> = {
  get: () => T;
  set(val: T): void;
};

export type BridgeActionCapData = WalletCapData<
  import('./smartWallet.js').BridgeAction
>;

/**
 * Defined by walletAction struct in msg_server.go
 *
 * @see {MsgWalletSpendAction} and walletSpendAction in msg_server.go
 */
export type WalletActionMsg = {
  type: 'WALLET_ACTION';
  /** base64 of Uint8Array of bech32 data  */
  owner: string;
  /** JSON of BridgeActionCapData */
  action: string;
  blockHeight: unknown; // int64
  blockTime: unknown; // int64
};

/**
 * Defined by walletSpendAction struct in msg_server.go
 *
 * @see {MsgWalletSpendAction} and walletSpendAction in msg_server.go
 */
export type WalletSpendActionMsg = {
  type: 'WALLET_SPEND_ACTION';
  /** base64 of Uint8Array of bech32 data  */
  owner: string;
  /** JSON of BridgeActionCapData */
  spendAction: string;
  blockHeight: unknown; // int64
  blockTime: unknown; // int64
};

/**
 * Messages transmitted over Cosmos chain, cryptographically verifying that the
 * message came from the 'owner'.
 *
 * The two wallet actions are distinguished by whether the user had to confirm
 * the sending of the message (as is the case for WALLET_SPEND_ACTION).
 */
export type WalletBridgeMsg = WalletActionMsg | WalletSpendActionMsg;
