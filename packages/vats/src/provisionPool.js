// @jessie-check
// @ts-check

import {
  handleParamGovernance,
  ParamTypes,
  publicMixinAPI,
} from '@agoric/governance';
import { InvitationShape } from '@agoric/governance/src/typeGuards.js';
import { M } from '@agoric/store';
import { prepareExo } from '@agoric/vat-data';
import { provideSingleton } from '@agoric/zoe/src/contractSupport/durability.js';
import { prepareRecorderKitMakers } from '@agoric/zoe/src/contractSupport/recorder.js';
import { TopicsRecordShape } from '@agoric/zoe/src/contractSupport/topics.js';
import { prepareProvisionPoolKit } from './provisionPoolKit.js';

export const privateArgsShape = M.splitRecord(
  harden({
    poolBank: M.eref(M.remotable('bank')),
    storageNode: M.eref(M.remotable('storageNode')),
    marshaller: M.eref(M.remotable('marshaller')),
  }),
  harden({
    // only necessary on first invocation, not subsequent
    initialPoserInvitation: InvitationShape,
    metricsOverride: M.recordOf(M.string()),
  }),
);

/**
 * @typedef {StandardTerms & GovernanceTerms<{
 *    PerAccountInitialAmount: 'amount',
 *   }>} ProvisionTerms
 *
 * TODO: ERef<GovernedCreatorFacet<ProvisionCreator>>
 *
 * @param {ZCF<ProvisionTerms>} zcf
 * @param {{
 *   poolBank: import('@endo/far').ERef<import('./vat-bank.js').Bank>,
 *   initialPoserInvitation: Invitation,
 *   storageNode: StorageNode,
 *   marshaller: Marshaller,
 *   metricsOverride?: import('./provisionPoolKit').MetricsNotification,
 * }} privateArgs
 * @param {import('@agoric/vat-data').Baggage} baggage
 */
export const prepare = async (zcf, privateArgs, baggage) => {
  const { poolBank, metricsOverride } = privateArgs;

  const { makeRecorderKit } = prepareRecorderKitMakers(
    baggage,
    privateArgs.marshaller,
  );

  // Governance
  const { publicMixin, makeDurableGovernorFacet, params } =
    await handleParamGovernance(
      zcf,
      privateArgs.initialPoserInvitation,
      {
        PerAccountInitialAmount: ParamTypes.AMOUNT,
      },
      privateArgs.storageNode,
      privateArgs.marshaller,
    );

  const makeProvisionPoolKit = prepareProvisionPoolKit(baggage, {
    makeRecorderKit,
    params,
    poolBank,
    zcf,
  });

  const provisionPoolKit = await provideSingleton(
    baggage,
    'provisionPoolKit',
    () =>
      makeProvisionPoolKit({
        // XXX governance can change the brand of the amount but should only be able to change the value
        // NB: changing the brand will break this pool
        poolBrand: params.getPerAccountInitialAmount().brand,
        storageNode: privateArgs.storageNode,
      }),
    kit => kit.helper.start({ metrics: metricsOverride }),
  );

  const publicFacet = prepareExo(
    baggage,
    'Provisioning Pool public',
    M.interface('ProvisionPool', {
      getMetrics: M.call().returns(M.remotable('MetricsSubscriber')),
      getPublicTopics: M.call().returns(TopicsRecordShape),
      ...publicMixinAPI,
    }),
    {
      getMetrics() {
        return provisionPoolKit.public.getPublicTopics().metrics.subscriber;
      },
      getPublicTopics() {
        return provisionPoolKit.public.getPublicTopics();
      },
      ...publicMixin,
    },
  );

  return harden({
    creatorFacet: makeDurableGovernorFacet(baggage, provisionPoolKit.machine)
      .governorFacet,
    publicFacet,
  });
};

harden(prepare);
