// @jessie-check

import '@agoric/governance/exported.js';
import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';

// The vaultFactory owns a number of VaultManagers and a mint for Minted.
//
// addVaultType is a closely held method that adds a brand new collateral type.
// It specifies the initial exchange rate for that type. It depends on a
// separately specified mechanism to liquidate vaults that are
// in arrears.

// This contract wants to be managed by a contractGovernor, but it isn't
// compatible with contractGovernor, since it has a separate paramManager for
// each VaultManager. This requires it to manually replicate the API of
// contractHelper to satisfy contractGovernor. It needs to return a creatorFacet
// with { getParamMgrRetriever, getInvitation, getLimitedCreatorFacet }.

import { CONTRACT_ELECTORATE } from '@agoric/governance';
import { makeParamManagerFromTerms } from '@agoric/governance/src/contractGovernance/typedParamManager.js';
import { validateElectorate } from '@agoric/governance/src/contractHelper.js';
import { makeTracer, StorageNodeShape } from '@agoric/internal';
import { makeStoredSubscription, makeSubscriptionKit } from '@agoric/notifier';
import { M } from '@agoric/store';
import { provideAll } from '@agoric/zoe/src/contractSupport/durability.js';
import { prepareRecorderKitMakers } from '@agoric/zoe/src/contractSupport/recorder.js';
import { E } from '@endo/eventual-send';
import { FeeMintAccessShape } from '@agoric/zoe/src/typeGuards.js';
import { InvitationShape } from '../auction/params.js';
import { SHORTFALL_INVITATION_KEY, vaultDirectorParamTypes } from './params.js';
import { provideDirector } from './vaultDirector.js';

const trace = makeTracer('VF', true);

/**
 * @typedef {ZCF<GovernanceTerms<import('./params').VaultDirectorParams> & {
 *   auctioneerPublicFacet: import('../auction/auctioneer.js').AuctioneerPublicFacet,
 *   priceAuthority: ERef<PriceAuthority>,
 *   reservePublicFacet: AssetReservePublicFacet,
 *   timerService: import('@agoric/time/src/types').TimerService,
 * }>} VaultFactoryZCF
 */

export const privateArgsShape = M.splitRecord(
  harden({
    marshaller: M.remotable('Marshaller'),
    storageNode: StorageNodeShape,
  }),
  harden({
    // only necessary on first invocation, not subsequent
    feeMintAccess: FeeMintAccessShape,
    initialPoserInvitation: InvitationShape,
    initialShortfallInvitation: InvitationShape,
  }),
);
harden(privateArgsShape);

/**
 * @param {VaultFactoryZCF} zcf
 * @param {{
 *   feeMintAccess: FeeMintAccess,
 *   initialPoserInvitation: Invitation,
 *   initialShortfallInvitation: Invitation,
 *   storageNode: ERef<StorageNode>,
 *   marshaller: ERef<Marshaller>,
 * }} privateArgs
 * @param {import('@agoric/ertp').Baggage} baggage
 */
export const prepare = async (zcf, privateArgs, baggage) => {
  trace('prepare start', privateArgs, [...baggage.keys()]);
  const {
    initialPoserInvitation,
    initialShortfallInvitation,
    marshaller,
    storageNode,
  } = privateArgs;

  trace('awaiting debtMint');
  const { debtMint } = await provideAll(baggage, {
    debtMint: () => zcf.registerFeeMint('Minted', privateArgs.feeMintAccess),
  });

  zcf.setTestJig(() => ({
    mintedIssuerRecord: debtMint.getIssuerRecord(),
  }));

  const { timerService, auctioneerPublicFacet } = zcf.getTerms();

  const { makeRecorderKit, makeERecorderKit } = prepareRecorderKitMakers(
    baggage,
    marshaller,
  );

  trace('making non-durable publishers');
  // XXX non-durable, will sever upon vat restart
  const governanceSubscriptionKit = makeSubscriptionKit();
  const governanceNode = E(storageNode).makeChildNode('governance');
  const governanceSubscriber = makeStoredSubscription(
    governanceSubscriptionKit.subscription,
    governanceNode,
    marshaller,
  );
  /** a powerful object; can modify the invitation */
  trace('awaiting makeParamManagerFromTerms');
  const vaultDirectorParamManager = await makeParamManagerFromTerms(
    {
      publisher: governanceSubscriptionKit.publication,
      subscriber: governanceSubscriber,
    },
    zcf,
    {
      [CONTRACT_ELECTORATE]: initialPoserInvitation,
      [SHORTFALL_INVITATION_KEY]: initialShortfallInvitation,
    },
    vaultDirectorParamTypes,
  );

  const director = provideDirector(
    baggage,
    zcf,
    vaultDirectorParamManager,
    debtMint,
    timerService,
    auctioneerPublicFacet,
    storageNode,
    // XXX remove Recorder makers; remove once we excise deprecated kits for governance
    marshaller,
    makeRecorderKit,
    makeERecorderKit,
  );

  // cannot await because it would make remote calls during vat restart
  director.helper.start().catch(err => {
    console.error('💀 vaultDirector failed to start:', err);
    zcf.shutdownWithFailure(err);
  });

  // validate async to wait for params to be finished
  // UNTIL https://github.com/Agoric/agoric-sdk/issues/4343
  void validateElectorate(zcf, vaultDirectorParamManager);

  return harden({
    creatorFacet: director.creator,
    publicFacet: director.public,
  });
};

/** @typedef {ContractOf<typeof prepare>} VaultFactoryContract */
