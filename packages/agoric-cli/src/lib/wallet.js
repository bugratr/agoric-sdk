// @ts-check
/* global process */

import { iterateReverse } from '@agoric/casting';
import { makeWalletStateCoalescer } from '@agoric/smart-wallet/src/utils.js';
import { execSwingsetTransaction, pollBlocks, pollTx } from './chain.js';
import { boardSlottingMarshaller, makeRpcUtils } from './rpc.js';

/** @typedef {import('@agoric/smart-wallet/src/smartWallet.js').CurrentWalletRecord} CurrentWalletRecord  */
/** @typedef {import('@agoric/vats/tools/board-utils.js').AgoricNamesRemotes} AgoricNamesRemotes  */

const { values } = Object;
const { Fail } = assert;
const marshaller = boardSlottingMarshaller();

/** @type {CurrentWalletRecord} */
const emptyCurrentRecord = {
  purses: [],
  offerToUsedInvitation: [],
  offerToPublicSubscriberPaths: [],
  liveOffers: [],
};

/**
 * @param {string} addr
 * @param {Pick<import('./rpc.js').RpcUtils, 'readLatestHead'>} io
 * @returns {Promise<import('@agoric/smart-wallet/src/smartWallet').CurrentWalletRecord>}
 */
export const getCurrent = async (addr, { readLatestHead }) => {
  // Partial because older writes may not have had all properties
  // NB: assumes changes are only additions
  let current =
    /** @type {Partial<import('@agoric/smart-wallet/src/smartWallet').CurrentWalletRecord> | undefined} */ (
      await readLatestHead(`published.wallet.${addr}.current`)
    );
  if (current === undefined) {
    throw new Error(`undefined current node for ${addr}`);
  }

  // Repair a type misunderstanding seen in the wild.
  // See https://github.com/Agoric/agoric-sdk/pull/7139
  let offerToUsedInvitation = current.offerToUsedInvitation;
  if (
    offerToUsedInvitation &&
    typeof offerToUsedInvitation === 'object' &&
    !Array.isArray(offerToUsedInvitation)
  ) {
    offerToUsedInvitation = Object.entries(offerToUsedInvitation);
    current = harden({
      ...current,
      offerToUsedInvitation,
    });
  }

  // override full empty record with defined values from published one
  return { ...emptyCurrentRecord, ...current };
};

/**
 * @param {string} addr
 * @param {Pick<import('./rpc.js').RpcUtils, 'readLatestHead'>} io
 * @returns {Promise<import('@agoric/smart-wallet/src/smartWallet').UpdateRecord>}
 */
export const getLastUpdate = (addr, { readLatestHead }) => {
  // @ts-expect-error cast
  return readLatestHead(`published.wallet.${addr}`);
};

/**
 * @param {import('@agoric/smart-wallet/src/smartWallet').BridgeAction} bridgeAction
 * @param {Pick<import('stream').Writable,'write'>} [stdout]
 */
export const outputAction = (bridgeAction, stdout = process.stdout) => {
  const capData = marshaller.toCapData(harden(bridgeAction));
  stdout.write(JSON.stringify(capData));
  stdout.write('\n');
};

const sendHint =
  'Now use `agoric wallet send ...` to sign and broadcast the offer.\n';

/**
 * @param {import('@agoric/smart-wallet/src/smartWallet').BridgeAction} bridgeAction
 * @param {{
 *   stdout: Pick<import('stream').Writable,'write'>,
 *   stderr: Pick<import('stream').Writable,'write'>,
 * }} io
 */
export const outputActionAndHint = (bridgeAction, { stdout, stderr }) => {
  outputAction(bridgeAction, stdout);
  stderr.write(sendHint);
};

/**
 * @param {import('@agoric/smart-wallet/src/offers.js').OfferSpec} offer
 * @param {Pick<import('stream').Writable,'write'>} [stdout]
 */
export const outputExecuteOfferAction = (offer, stdout = process.stdout) => {
  /** @type {import('@agoric/smart-wallet/src/smartWallet').BridgeAction} */
  const spendAction = {
    method: 'executeOffer',
    offer,
  };
  outputAction(spendAction, stdout);
};

/**
 * @deprecated use `.current` node for current state
 * @param {import('@agoric/casting').Follower<import('@agoric/casting').ValueFollowerElement<import('@agoric/smart-wallet/src/smartWallet').UpdateRecord>>} follower
 * @param {Brand<'set'>} [invitationBrand]
 */
export const coalesceWalletState = async (follower, invitationBrand) => {
  // values with oldest last
  const history = [];
  for await (const followerElement of iterateReverse(follower)) {
    history.push(followerElement.value);
  }

  const coalescer = makeWalletStateCoalescer(invitationBrand);
  // update with oldest first
  for (const record of history.reverse()) {
    coalescer.update(record);
  }

  return coalescer.state;
};

/**
 * Sign and broadcast a wallet-action.
 *
 * @throws { Error & { code: number } } if transaction fails
 * @param {import('@agoric/smart-wallet/src/smartWallet').BridgeAction} bridgeAction
 * @param {import('./rpc').MinimalNetworkConfig & {
 *   from: string,
 *   verbose?: boolean,
 *   keyring?: {home?: string, backend: string},
 *   stdout: Pick<import('stream').Writable, 'write'>,
 *   execFileSync: typeof import('child_process').execFileSync,
 *   delay: (ms: number) => Promise<void>,
 *   dryRun?: boolean,
 * }} opts
 */
export const sendAction = async (bridgeAction, opts) => {
  const offerBody = JSON.stringify(marshaller.toCapData(harden(bridgeAction)));

  // tryExit should not require --allow-spend
  // https://github.com/Agoric/agoric-sdk/issues/7291
  const spendMethods = ['executeOffer', 'tryExitOffer'];
  const spendArg = spendMethods.includes(bridgeAction.method)
    ? ['--allow-spend']
    : [];

  const act = ['wallet-action', ...spendArg, offerBody];
  const out = execSwingsetTransaction([...act, '--output', 'json'], opts);
  if (opts.dryRun) {
    return;
  }

  assert(out); // not dry run
  const tx = JSON.parse(out);
  if (tx.code !== 0) {
    const err = Error(`failed to send action. code: ${tx.code}`);
    // @ts-expect-error XXX how to add properties to an error?
    err.code = tx.code;
    throw err;
  }

  return pollTx(tx.txhash, opts);
};

/**
 * @param {CurrentWalletRecord} current
 * @param {AgoricNamesRemotes} agoricNames
 */
export const findContinuingIds = (current, agoricNames) => {
  // XXX should runtime type-check
  /** @type {{ offerToUsedInvitation: [string, Amount<'set'>][]}} */
  const { offerToUsedInvitation: entries } = /** @type {any} */ (current);

  Array.isArray(entries) || Fail`entries must be an array: ${entries}`;

  const keyOf = (obj, val) => {
    const found = Object.entries(obj).find(e => e[1] === val);
    return found && found[0];
  };

  const found = [];
  for (const [offerId, { value }] of entries) {
    /** @type {{ description: string, instance: unknown }[]} */
    const [{ description, instance }] = value;
    if (
      description === 'charter member invitation' ||
      /Voter\d+/.test(description)
    ) {
      const instanceName = keyOf(agoricNames.instance, instance);
      found.push({ instance, instanceName, description, offerId });
    }
  }
  return found;
};

export const makeWalletUtils = async (
  { fetch, execFileSync, delay },
  networkConfig,
) => {
  const { agoricNames, fromBoard, readLatestHead, vstorage } =
    await makeRpcUtils({ fetch }, networkConfig);
  /**
   * @param {string} from
   * @param {number|string} [minHeight]
   */
  const storedWalletState = async (from, minHeight = undefined) => {
    const m = boardSlottingMarshaller(fromBoard.convertSlotToVal);

    const history = await vstorage.readFully(
      `published.wallet.${from}`,
      minHeight,
    );

    /** @type {{ Invitation: Brand<'set'> }} */
    // @ts-expect-error XXX how to narrow AssetKind to set?
    const { Invitation } = agoricNames.brand;
    const coalescer = makeWalletStateCoalescer(Invitation);
    // update with oldest first
    for (const txt of history.reverse()) {
      const { body, slots } = JSON.parse(txt);
      const record = m.fromCapData({ body, slots });
      coalescer.update(record);
    }
    const coalesced = coalescer.state;
    harden(coalesced);
    return coalesced;
  };

  /**
   * Get OfferStatus by id, polling until available.
   *
   * @param {string} from
   * @param {string|number} id
   * @param {number|string} minHeight
   * @param {boolean} [untilNumWantsSatisfied]
   */
  const pollOffer = async (
    from,
    id,
    minHeight,
    untilNumWantsSatisfied = false,
  ) => {
    const lookup = async () => {
      const { offerStatuses } = await storedWalletState(from, minHeight);
      const offerStatus = [...offerStatuses.values()].find(s => s.id === id);
      if (!offerStatus) throw Error('retry');
      harden(offerStatus);
      if (untilNumWantsSatisfied && !('numWantsSatisfied' in offerStatus)) {
        throw Error('retry (no numWantsSatisfied yet)');
      }
      return offerStatus;
    };
    const retryMessage = 'offer not in wallet at block';
    const opts = { ...networkConfig, execFileSync, delay, retryMessage };
    return pollBlocks(opts)(lookup);
  };

  return {
    networkConfig,
    agoricNames,
    fromBoard,
    vstorage,
    readLatestHead,
    storedWalletState,
    pollOffer,
  };
};

/**
 * @param {{
 *   brand: Record<string, Brand>,
 *   vbankAsset: Record<string, { brand: Brand, displayInfo: DisplayInfo }>,
 * }} agoricNames
 * @param {(msg: string) => Error} makeError error constructor
 * @returns {(a: string) => Amount<'nat'>}
 */
export const makeParseAmount =
  (agoricNames, makeError = msg => RangeError(msg)) =>
  opt => {
    assert.typeof(opt, 'string', 'parseAmount expected string');
    const m = opt.match(/^(?<value>[\d_]+(\.[\d_]+)?)(?<brand>[A-Z]\w*?)$/);
    if (!m || !m.groups) {
      throw makeError(`invalid amount: ${opt}`);
    }
    const anyBrand = agoricNames.brand[m.groups.brand];
    if (!anyBrand) {
      throw makeError(`unknown brand: ${m.groups.brand}`);
    }
    const assetDesc = values(agoricNames.vbankAsset).find(
      d => d.brand === anyBrand,
    );
    if (!assetDesc) {
      throw makeError(`unknown brand: ${m.groups.brand}`);
    }
    const { displayInfo } = assetDesc;
    if (!displayInfo.decimalPlaces || displayInfo.assetKind !== 'nat') {
      throw makeError(`bad brand: ${displayInfo}`);
    }
    const value = BigInt(
      Number(m.groups.value.replace(/_/g, '')) *
        10 ** displayInfo.decimalPlaces,
    );
    /** @type {Brand<'nat'>} */
    // @ts-expect-error dynamic cast
    const natBrand = anyBrand;
    const amt = { value, brand: natBrand };
    return amt;
  };
