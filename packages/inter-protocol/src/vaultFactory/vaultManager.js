/* eslint-disable consistent-return */
/**
 * @file Vault Manager object manages vault-based debts for a collateral type.
 *
 * The responsibilities include:
 * - opening a new vault backed by the collateral
 * - publishing metrics on the vault economy for that collateral
 * - charging interest on all active vaults
 * - liquidating active vaults that have exceeded the debt ratio
 *
 * Once a vault is settled (liquidated or closed) it can still be used, traded,
 * etc. but is no longer the concern of the manager. It can't be liquidated,
 * have interest charged, or be counted in the metrics.
 *
 * Undercollateralized vaults can have their assets sent to the auctioneer to be
 * liquidated. If the auction is unsuccessful, the liquidation may be reverted.
 */
import '@agoric/zoe/exported.js';

import {
  AmountMath,
  AmountShape,
  BrandShape,
  NotifierShape,
  RatioShape,
} from '@agoric/ertp';
import { makeTracer } from '@agoric/internal';
import { makeStoredNotifier, observeNotifier } from '@agoric/notifier';
import { appendToStoredArray } from '@agoric/store/src/stores/store-utils.js';
import {
  M,
  makeScalarBigMapStore,
  makeScalarBigSetStore,
  prepareExoClassKit,
  provide,
} from '@agoric/vat-data';
import { TransferPartShape } from '@agoric/zoe/src/contractSupport/atomicTransfer.js';
import {
  atomicRearrange,
  ceilMultiplyBy,
  floorDivideBy,
  getAmountIn,
  getAmountOut,
  makeEphemeraProvider,
  makeRatio,
  makeRecorderTopic,
  offerTo,
  SubscriberShape,
  TopicsRecordShape,
} from '@agoric/zoe/src/contractSupport/index.js';
import { PriceQuoteShape, SeatShape } from '@agoric/zoe/src/typeGuards.js';
import { E } from '@endo/eventual-send';
import { AuctionPFShape } from '../auction/auctioneer.js';
import {
  checkDebtLimit,
  makeNatAmountShape,
  quoteAsRatio,
} from '../contractSupport.js';
import { chargeInterest } from '../interest.js';
import { getLiquidatableVaults } from './liquidation.js';
import { calculateMinimumCollateralization, minimumPrice } from './math.js';
import { makePrioritizedVaults } from './prioritizedVaults.js';
import { Phase, prepareVault } from './vault.js';
import { calculateDistributionPlan } from './proceeds.js';

const { details: X, Fail, quote: q } = assert;

const trace = makeTracer('VM');

/** @typedef {import('./storeUtils.js').NormalizedDebt} NormalizedDebt */
/** @typedef {import('@agoric/time/src/types').RelativeTime} RelativeTime */

// Metrics naming scheme: nouns are present values; past-participles are accumulative.
/**
 * @typedef {object} MetricsNotification
 *
 * @property {Ratio | null} lockedQuote      priceQuote that will be used for liquidation.
 *                                   Non-null from priceLock time until liquidation has taken place.
 * @property {number}         numActiveVaults          present count of vaults
 * @property {number}         numLiquidatingVaults  present count of liquidating vaults
 * @property {Amount<'nat'>}  totalCollateral    present sum of collateral across all vaults
 * @property {Amount<'nat'>}  totalDebt          present sum of debt across all vaults
 * @property {Amount<'nat'>}  retainedCollateral collateral held as a result of not returning excess refunds
 *                                                to owners of vaults liquidated with shortfalls
 * @property {Amount<'nat'>}  liquidatingCollateral  present sum of collateral in vaults sent for liquidation
 * @property {Amount<'nat'>}  liquidatingDebt        present sum of debt in vaults sent for liquidation
 *
 * @property {Amount<'nat'>}  totalCollateralSold       running sum of collateral sold in liquidation
 * @property {Amount<'nat'>}  totalOverageReceived      running sum of overages, central received greater than debt
 * @property {Amount<'nat'>}  totalProceedsReceived     running sum of minted received from liquidation
 * @property {Amount<'nat'>}  totalShortfallReceived    running sum of shortfalls, minted received less than debt
 * @property {number}         numLiquidationsCompleted  running count of liquidated vaults
 * @property {number}         numLiquidationsAborted    running count of vault liquidations that were reverted.
 */

/**
 * @typedef {{
 *  compoundedStabilityFee: Ratio,
 *  stabilityFee: Ratio,
 *  latestStabilityFeeUpdate: Timestamp,
 * }} AssetState
 *
 * @typedef {{
 *  getChargingPeriod: () => RelativeTime,
 *  getRecordingPeriod: () => RelativeTime,
 *  getDebtLimit: () => Amount<'nat'>,
 *  getStabilityFee: () => Ratio,
 *  getLiquidationPadding: () => Ratio,
 *  getLiquidationMargin: () => Ratio,
 *  getLiquidationPenalty: () => Ratio,
 *  getMintFee: () => Ratio,
 *  getMinInitialDebt: () => Amount<'nat'>,
 * }} GovernedParamGetters
 */

/**
 * @typedef {Readonly<{
 *   debtMint: ZCFMint<'nat'>,
 *   collateralBrand: Brand<'nat'>,
 *   collateralUnit: Amount<'nat'>,
 *   descriptionScope: string,
 *   startTimeStamp: Timestamp,
 *   storageNode: StorageNode,
 * }>} HeldParams
 */

/**
 * @typedef {{
 *   assetTopicKit: import('@agoric/zoe/src/contractSupport/recorder.js').RecorderKit<AssetState>,
 *   debtBrand: Brand<'nat'>,
 *   liquidatingVaults: SetStore<Vault>,
 *   metricsTopicKit: import('@agoric/zoe/src/contractSupport/recorder.js').RecorderKit<MetricsNotification>,
 *   poolIncrementSeat: ZCFSeat,
 *   retainedCollateralSeat: ZCFSeat,
 *   unsettledVaults: MapStore<string, Vault>,
 * }} ImmutableState
 */

/**
 * @typedef {{
 *   compoundedStabilityFee: Ratio,
 *   latestStabilityFeeUpdate: Timestamp,
 *   numLiquidationsCompleted: number,
 *   numLiquidationsAborted: number,
 *   totalCollateral: Amount<'nat'>,
 *   totalCollateralSold: Amount<'nat'>,
 *   totalDebt: Amount<'nat'>,
 *   liquidatingCollateral: Amount<'nat'>,
 *   liquidatingDebt: Amount<'nat'>,
 *   totalOverageReceived: Amount<'nat'>,
 *   totalProceedsReceived: Amount<'nat'>,
 *   totalShortfallReceived: Amount<'nat'>,
 *   vaultCounter: number,
 *   lockedQuote: PriceQuote | undefined,
 * }} MutableState
 */

/**
 * @type {(brand: Brand) => {
 * prioritizedVaults: ReturnType<typeof makePrioritizedVaults>,
 * storedQuotesNotifier: import('@agoric/notifier').StoredNotifier<PriceQuote>,
 * storedCollateralQuote: PriceQuote,
 * }}
 */
// any b/c will be filled after start()
const collateralEphemera = makeEphemeraProvider(() => /** @type {any} */ ({}));

/**
 * @param {import('@agoric/ertp').Baggage} baggage
 * @param {{
 *   zcf: import('./vaultFactory.js').VaultFactoryZCF,
 *   marshaller: ERef<Marshaller>,
 *   makeRecorderKit: import('@agoric/zoe/src/contractSupport/recorder.js').MakeRecorderKit,
 *   makeERecorderKit: import('@agoric/zoe/src/contractSupport/recorder.js').MakeERecorderKit,
 *   factoryPowers: import('./vaultDirector.js').FactoryPowersFacet,
 * }} powers
 */
export const prepareVaultManagerKit = (
  baggage,
  { zcf, marshaller, makeRecorderKit, factoryPowers },
) => {
  const { priceAuthority, timerService, reservePublicFacet } = zcf.getTerms();

  const makeVault = prepareVault(baggage, makeRecorderKit, zcf);

  /**
   * @param {HeldParams & { metricsStorageNode: StorageNode }} params
   * @returns {HeldParams & ImmutableState & MutableState}
   */
  const initState = params => {
    const {
      debtMint,
      collateralBrand,
      metricsStorageNode,
      startTimeStamp,
      storageNode,
    } = params;
    const debtBrand = debtMint.getIssuerRecord().brand;

    /** @type {ImmutableState} */
    const immutable = {
      debtBrand,
      poolIncrementSeat: zcf.makeEmptySeatKit().zcfSeat,

      /**
       * Vaults that have been sent for liquidation. When we get proceeds (or lack
       * thereof) back from the liquidator, we will allocate them among the vaults.
       *
       * @type {SetStore<Vault>}
       */
      liquidatingVaults: makeScalarBigSetStore('liquidatingVaults', {
        durable: true,
      }),

      assetTopicKit: makeRecorderKit(storageNode),

      metricsTopicKit: makeRecorderKit(metricsStorageNode),

      // TODO(#7074) not used while liquidation is disabled. Reinstate with #7074
      retainedCollateralSeat: zcf.makeEmptySeatKit().zcfSeat,

      unsettledVaults: makeScalarBigMapStore('orderedVaultStore', {
        durable: true,
      }),
    };

    const zeroCollateral = AmountMath.makeEmpty(collateralBrand, 'nat');
    const zeroDebt = AmountMath.makeEmpty(debtBrand, 'nat');

    return harden({
      ...params,
      ...immutable,
      compoundedStabilityFee: makeRatio(100n, debtBrand), // starts at 1.0, no interest
      latestStabilityFeeUpdate: startTimeStamp,
      numLiquidationsCompleted: 0,
      numLiquidationsAborted: 0,
      totalCollateral: zeroCollateral,
      totalCollateralSold: zeroCollateral,
      totalDebt: zeroDebt,
      liquidatingCollateral: zeroCollateral,
      liquidatingDebt: zeroDebt,
      totalOverageReceived: zeroDebt,
      totalProceedsReceived: zeroDebt,
      totalShortfallReceived: zeroDebt,
      vaultCounter: 0,
      lockedQuote: undefined,
    });
  };

  const makeVaultManagerKitInternal = prepareExoClassKit(
    baggage,
    'VaultManagerKit',
    {
      collateral: M.interface('collateral', {
        makeVaultInvitation: M.call().returns(M.promise()),
        getPublicTopics: M.call().returns(TopicsRecordShape),
        getQuotes: M.call().returns(NotifierShape),
        getCompoundedStabilityFee: M.call().returns(RatioShape),
      }),
      helper: M.interface(
        'helper',
        // not exposed so sloppy okay
        {},
        { sloppy: true },
      ),
      manager: M.interface('manager', {
        getGovernedParams: M.call().returns(M.remotable('governedParams')),
        maxDebtFor: M.call(AmountShape).returns(AmountShape),
        mintAndTransfer: M.call(
          SeatShape,
          AmountShape,
          AmountShape,
          M.arrayOf(TransferPartShape),
        ).returns(),
        burn: M.call(AmountShape, SeatShape).returns(),
        getAssetSubscriber: M.call().returns(SubscriberShape),
        getCollateralBrand: M.call().returns(BrandShape),
        getDebtBrand: M.call().returns(BrandShape),
        getCompoundedStabilityFee: M.call().returns(RatioShape),
        scopeDescription: M.call(M.string()).returns(M.string()),
        handleBalanceChange: M.call(
          AmountShape,
          AmountShape,
          M.string(),
          M.string(),
          M.remotable('vault'),
        ).returns(),
      }),
      self: M.interface('self', {
        getGovernedParams: M.call().returns(M.remotable('governedParams')),
        makeVaultKit: M.call(SeatShape).returns(M.promise()),
        getCollateralQuote: M.call().returns(PriceQuoteShape),
        getPublicFacet: M.call().returns(M.remotable('publicFacet')),
        lockOraclePrices: M.call().returns(PriceQuoteShape),
        liquidateVaults: M.call(AuctionPFShape).returns(M.promise()),
      }),
    },
    initState,
    {
      collateral: {
        makeVaultInvitation() {
          const { facets } = this;
          const { collateralBrand, debtBrand } = this.state;
          return zcf.makeInvitation(
            seat => this.facets.self.makeVaultKit(seat),
            facets.manager.scopeDescription('MakeVault'),
            undefined,
            M.splitRecord({
              give: {
                Collateral: makeNatAmountShape(collateralBrand),
              },
              want: {
                Minted: makeNatAmountShape(debtBrand),
              },
            }),
          );
        },
        getQuotes() {
          const ephemera = collateralEphemera(this.state.collateralBrand);
          return ephemera.storedQuotesNotifier;
        },
        getCompoundedStabilityFee() {
          return this.state.compoundedStabilityFee;
        },
        getPublicTopics() {
          const { assetTopicKit, metricsTopicKit } = this.state;
          return harden({
            asset: makeRecorderTopic(
              'State of the assets managed',
              assetTopicKit,
            ),
            metrics: makeRecorderTopic(
              'Vault Factory metrics',
              metricsTopicKit,
            ),
          });
        },
      },

      // Some of these could go in closures but are kept on a facet anticipating future durability options.
      helper: {
        /**
         * Start non-durable processes (or restart if needed after vat restart)
         */
        start() {
          const { state, facets } = this;
          trace(state.collateralBrand, 'helper.start()', state.vaultCounter);
          const {
            collateralBrand,
            collateralUnit,
            debtBrand,
            storageNode,
            unsettledVaults,
          } = state;

          const ephemera = collateralEphemera(collateralBrand);
          ephemera.prioritizedVaults = makePrioritizedVaults(unsettledVaults);

          trace('helper.start() making periodNotifier');
          const periodNotifier = E(timerService).makeNotifier(
            0n,
            factoryPowers
              .getGovernedParams(collateralBrand)
              .getChargingPeriod(),
          );

          trace('helper.start() starting observe periodNotifier');
          void observeNotifier(periodNotifier, {
            updateState: updateTime =>
              facets.helper
                .chargeAllVaults(updateTime)
                .catch(e =>
                  console.error('🚨 vaultManager failed to charge interest', e),
                ),
            fail: reason => {
              zcf.shutdownWithFailure(
                assert.error(X`Unable to continue without a timer: ${reason}`),
              );
            },
            finish: done => {
              zcf.shutdownWithFailure(
                assert.error(X`Unable to continue without a timer: ${done}`),
              );
            },
          });

          trace('helper.start() making quoteNotifier from', priceAuthority);
          const quoteNotifier = E(priceAuthority).makeQuoteNotifier(
            collateralUnit,
            debtBrand,
          );
          ephemera.storedQuotesNotifier = makeStoredNotifier(
            quoteNotifier,
            E(storageNode).makeChildNode('quotes'),
            marshaller,
          );
          trace('helper.start() awaiting observe storedQuotesNotifier');
          // NB: upon restart, there may not be a price for a while. If manager
          // operations are permitted, ones the depend on price information will
          // throw. See https://github.com/Agoric/agoric-sdk/issues/4317
          void observeNotifier(quoteNotifier, {
            updateState(value) {
              trace('storing new quote', value.quoteAmount.value);
              ephemera.storedCollateralQuote = value;
            },
            fail(reason) {
              console.error('quoteNotifier failed to iterate', reason);
            },
          });
          trace('helper.start() done');
        },
        /**
         * @param {Timestamp} updateTime
         */
        async chargeAllVaults(updateTime) {
          const { state, facets } = this;
          const { collateralBrand, debtMint, poolIncrementSeat } = state;
          trace(collateralBrand, 'chargeAllVaults', {
            updateTime,
          });

          const stabilityFee = factoryPowers
            .getGovernedParams(collateralBrand)
            .getStabilityFee();

          // Update state with the results of charging interest

          const changes = chargeInterest(
            {
              mint: debtMint,
              mintAndTransferWithFee: factoryPowers.mintAndTransfer,
              poolIncrementSeat,
              seatAllocationKeyword: 'Minted',
            },
            {
              stabilityFee,
              chargingPeriod: factoryPowers
                .getGovernedParams(collateralBrand)
                .getChargingPeriod(),
              recordingPeriod: factoryPowers
                .getGovernedParams(collateralBrand)
                .getRecordingPeriod(),
            },
            {
              latestStabilityFeeUpdate: state.latestStabilityFeeUpdate,
              compoundedStabilityFee: state.compoundedStabilityFee,
              totalDebt: state.totalDebt,
            },
            updateTime,
          );

          state.compoundedStabilityFee = changes.compoundedStabilityFee;
          state.latestStabilityFeeUpdate = changes.latestStabilityFeeUpdate;
          state.totalDebt = changes.totalDebt;

          return facets.helper.assetNotify();
        },
        assetNotify() {
          const { state } = this;
          const { collateralBrand, assetTopicKit } = state;
          const stabilityFee = factoryPowers
            .getGovernedParams(collateralBrand)
            .getStabilityFee();
          /** @type {AssetState} */
          const payload = harden({
            compoundedStabilityFee: state.compoundedStabilityFee,
            stabilityFee,
            latestStabilityFeeUpdate: state.latestStabilityFeeUpdate,
          });
          return assetTopicKit.recorder.write(payload);
        },
        burnToCoverDebt(debt, proceeds, seat) {
          const { state } = this;

          if (AmountMath.isGTE(proceeds, debt)) {
            factoryPowers.burnDebt(debt, seat);
            state.totalDebt = AmountMath.subtract(state.totalDebt, debt);
          } else {
            factoryPowers.burnDebt(proceeds, seat);
            state.totalDebt = AmountMath.subtract(state.totalDebt, proceeds);
          }

          state.totalProceedsReceived = AmountMath.add(
            state.totalProceedsReceived,
            proceeds,
          );
        },
        sendToReserve(penalty, seat, seatKeyword = 'Collateral') {
          const invitation =
            E(reservePublicFacet).makeAddCollateralInvitation();
          trace('Sending to reserve: ', penalty);

          // don't wait for response
          void E.when(invitation, invite => {
            const proposal = { give: { Collateral: penalty } };
            return offerTo(
              zcf,
              invite,
              { [seatKeyword]: 'Collateral' },
              proposal,
              seat,
            );
          }).catch(reason => {
            console.error('sendToReserve failed', reason);
          });
        },
        markLiquidating(debt, collateral) {
          const { state } = this;

          state.liquidatingCollateral = AmountMath.add(
            state.liquidatingCollateral,
            collateral,
          );

          state.liquidatingDebt = AmountMath.add(state.liquidatingDebt, debt);
        },
        /**
         *
         * @param {Amount<'nat'>} debt
         * @param {Amount<'nat'>} collateral
         * @param {Amount<'nat'>} overage
         * @param {Amount<'nat'>} shortfall
         */
        markDoneLiquidating(debt, collateral, overage, shortfall) {
          const { state } = this;

          // update liquidation state

          state.liquidatingCollateral = AmountMath.subtract(
            state.liquidatingCollateral,
            collateral,
          );
          state.liquidatingDebt = AmountMath.subtract(
            state.liquidatingDebt,
            debt,
          );

          // record shortfall and proceeds

          // cumulative values
          state.totalOverageReceived = AmountMath.add(
            state.totalOverageReceived,
            overage,
          );
          state.totalShortfallReceived = AmountMath.add(
            state.totalShortfallReceived,
            shortfall,
          );
          state.totalDebt = AmountMath.subtract(state.totalDebt, shortfall);

          E.when(
            factoryPowers.getShortfallReporter(),
            reporter => E(reporter).increaseLiquidationShortfall(shortfall),
            err =>
              console.error(
                '🛠️ getShortfallReporter() failed during liquidation; repair by updating governance',
                err,
              ),
          ).catch(err => {
            console.error('🚨 failed to report liquidation shortfall', err);
          });
        },
        writeMetrics() {
          const { state } = this;
          const { collateralBrand, retainedCollateralSeat, metricsTopicKit } =
            state;
          const { prioritizedVaults } = collateralEphemera(collateralBrand);

          const retainedCollateral =
            retainedCollateralSeat.getCurrentAllocation()?.Collateral ??
            AmountMath.makeEmpty(collateralBrand, 'nat');

          const quote = state.lockedQuote;
          const lockedQuoteRatio = quote
            ? quoteAsRatio(quote.quoteAmount.value[0])
            : null;

          /** @type {MetricsNotification} */
          const payload = harden({
            numActiveVaults: prioritizedVaults.getCount(),
            numLiquidatingVaults: state.liquidatingVaults.getSize(),
            totalCollateral: state.totalCollateral,
            totalDebt: state.totalDebt,
            retainedCollateral,

            numLiquidationsCompleted: state.numLiquidationsCompleted,
            numLiquidationsAborted: state.numLiquidationsAborted,
            totalCollateralSold: state.totalCollateralSold,
            liquidatingCollateral: state.liquidatingCollateral,
            liquidatingDebt: state.liquidatingDebt,
            totalOverageReceived: state.totalOverageReceived,
            totalProceedsReceived: state.totalProceedsReceived,
            totalShortfallReceived: state.totalShortfallReceived,
            lockedQuote: lockedQuoteRatio,
          });

          return E(metricsTopicKit.recorder).write(payload);
        },

        /**
         * This is designed to tolerate an incomplete plan, in case calculateDistributionPlan encounters
         * an error during its calculation. We don't have a way to induce such errors in CI so we've
         * done so manually in dev and verified this function recovers as expected.
         *
         * @param {AmountKeywordRecord} proceeds
         * @param {Amount<'nat'>} totalDebt
         * @param {Pick<PriceQuote, 'quoteAmount'>} oraclePriceAtStart
         * @param {MapStore<Vault, { collateralAmount: Amount<'nat'>, debtAmount:  Amount<'nat'>}>} vaultData
         * @param {Amount<'nat'>} totalCollateral
         */
        planProceedsDistribution(
          proceeds,
          totalDebt,
          oraclePriceAtStart,
          vaultData,
          totalCollateral,
        ) {
          const { state, facets } = this;

          const { Collateral: collateralProceeds } = proceeds;
          /** @type {Amount<'nat'>} */
          const collateralSold = AmountMath.subtract(
            totalCollateral,
            collateralProceeds,
          );
          state.totalCollateralSold = AmountMath.add(
            state.totalCollateralSold,
            collateralSold,
          );

          const penaltyRate = facets.self
            .getGovernedParams()
            .getLiquidationPenalty();
          const bestToWorst = [...vaultData.entries()].reverse();

          // unzip the entry tuples
          const vaultsInPlan = /** @type {Vault[]} */ ([]);
          const vaultsBalances =
            /** @type {import('./proceeds.js').VaultBalances[]} */ ([]);
          for (const [vault, balances] of bestToWorst) {
            vaultsInPlan.push(vault);
            vaultsBalances.push({
              collateral: balances.collateralAmount,
              // if interest accrued during sale, the current debt will be higher
              presaleDebt: balances.debtAmount,
              currentDebt: vault.getCurrentDebt(),
            });
          }
          harden(vaultsInPlan);
          harden(vaultsBalances);

          const plan = calculateDistributionPlan({
            proceeds,
            totalDebt,
            totalCollateral,
            oraclePriceAtStart: oraclePriceAtStart.quoteAmount.value[0],
            vaultsBalances,
            penaltyRate,
          });
          return { plan, vaultsInPlan };
        },

        /**
         * This is designed to tolerate an incomplete plan, in case calculateDistributionPlan encounters
         * an error during its calculation. We don't have a way to induce such errors in CI so we've
         * done so manually in dev and verified this function recovers as expected.
         *
         * @param {object} obj
         * @param {import('./proceeds.js').DistributionPlan} obj.plan
         * @param {Array<Vault>} obj.vaultsInPlan
         * @param {ZCFSeat} obj.liqSeat
         * @param {Amount<'nat'>} obj.totalCollateral
         * @param {Amount<'nat'>} obj.totalDebt
         * @returns {void}
         */
        distributeProceeds({
          plan,
          vaultsInPlan,
          liqSeat,
          totalCollateral,
          totalDebt,
        }) {
          const { state, facets } = this;
          // Putting all the rearrangements after the loop ensures that errors
          // in the calculations don't result in paying back some vaults and
          // leaving others hanging.
          if (plan.transfersToVault.length > 0) {
            const transfers = plan.transfersToVault.map(
              ([vaultIndex, amounts]) =>
                /** @type {import('@agoric/zoe/src/contractSupport/atomicTransfer.js').TransferPart} */ ([
                  liqSeat,
                  vaultsInPlan[vaultIndex].getVaultSeat(),
                  amounts,
                ]),
            );
            atomicRearrange(zcf, harden(transfers));
          }

          const { prioritizedVaults } = collateralEphemera(
            totalCollateral.brand,
          );
          state.numLiquidationsAborted += plan.vaultsToReinstate.length;
          for (const vaultIndex of plan.vaultsToReinstate) {
            const vault = vaultsInPlan[vaultIndex];
            const vaultId = vault.abortLiquidation();
            prioritizedVaults.addVault(vaultId, vault);
            state.liquidatingVaults.delete(vault);
          }

          if (!AmountMath.isEmpty(plan.phantomDebt)) {
            state.totalDebt = AmountMath.subtract(
              state.totalDebt,
              plan.phantomDebt,
            );
          }

          facets.helper.burnToCoverDebt(
            plan.debtToBurn,
            plan.mintedProceeds,
            liqSeat,
          );
          if (!AmountMath.isEmpty(plan.mintedForReserve)) {
            facets.helper.sendToReserve(
              plan.mintedForReserve,
              liqSeat,
              'Minted',
            );
          }

          // send all that's left in the seat
          const collateralInLiqSeat = liqSeat.getCurrentAllocation().Collateral;
          if (!AmountMath.isEmpty(collateralInLiqSeat)) {
            facets.helper.sendToReserve(collateralInLiqSeat, liqSeat);
          }
          // if it didn't match what was expected, report
          if (!AmountMath.isEqual(collateralInLiqSeat, plan.collatRemaining)) {
            console.error(
              `⚠️ Excess collateral remaining sent to reserve. Expected ${q(
                plan.collatRemaining,
              )}, sent ${q(collateralInLiqSeat)}`,
            );
          }

          // 'totalCollateralSold' is only for this liquidation event
          // 'state.totalCollateralSold' represents all active vaults
          const actualCollateralSold = plan.actualCollateralSold;
          state.totalCollateral = AmountMath.isEmpty(actualCollateralSold)
            ? AmountMath.subtract(state.totalCollateral, totalCollateral)
            : AmountMath.subtract(state.totalCollateral, actualCollateralSold);

          facets.helper.markDoneLiquidating(
            totalDebt,
            totalCollateral,
            plan.overage,
            plan.shortfallToReserve,
          );

          // liqSeat should be empty at this point, except that funds are sent
          // asynchronously to the reserve.
        },
      },

      manager: {
        getGovernedParams() {
          const { collateralBrand } = this.state;
          return factoryPowers.getGovernedParams(collateralBrand);
        },

        /**
         * Look up the most recent price authority price to determine the max
         * debt this manager config will allow for the collateral.
         *
         * @param {Amount<'nat'>} collateralAmount
         */
        maxDebtFor(collateralAmount) {
          const { collateralBrand } = this.state;
          const { storedCollateralQuote } = collateralEphemera(collateralBrand);
          if (!storedCollateralQuote)
            throw Fail`maxDebtFor called before a collateral quote was available`;
          // use the lower price to prevent vault adjustments that put them imminently underwater
          const collateralPrice = minimumPrice(
            storedCollateralQuote,
            this.state.lockedQuote,
          );
          const collatlVal = ceilMultiplyBy(collateralAmount, collateralPrice);
          const minimumCollateralization = calculateMinimumCollateralization(
            factoryPowers
              .getGovernedParams(collateralBrand)
              .getLiquidationMargin(),
            factoryPowers
              .getGovernedParams(collateralBrand)
              .getLiquidationPadding(),
          );
          // floorDivide because we want the debt ceiling lower
          return floorDivideBy(collatlVal, minimumCollateralization);
        },
        /** @type {MintAndTransfer} */
        mintAndTransfer(mintReceiver, toMint, fee, transfers) {
          const { state } = this;
          const { collateralBrand, totalDebt } = state;

          checkDebtLimit(
            factoryPowers.getGovernedParams(collateralBrand).getDebtLimit(),
            totalDebt,
            toMint,
          );
          factoryPowers.mintAndTransfer(mintReceiver, toMint, fee, transfers);
        },
        /**
         * @param {Amount<'nat'>} toBurn
         * @param {ZCFSeat} seat
         */
        burn(toBurn, seat) {
          const { state } = this;
          const { collateralBrand } = this.state;

          trace(collateralBrand, 'burn', {
            toBurn,
            totalDebt: state.totalDebt,
          });
          factoryPowers.burnDebt(toBurn, seat);
        },
        getAssetSubscriber() {
          return this.state.assetTopicKit.subscriber;
        },
        getCollateralBrand() {
          const { collateralBrand } = this.state;
          return collateralBrand;
        },
        getDebtBrand() {
          const { debtBrand } = this.state;
          return debtBrand;
        },
        /**
         * Prepend with an identifier of this vault manager
         *
         * @param {string} base
         */
        scopeDescription(base) {
          const { descriptionScope } = this.state;
          return `${descriptionScope}: ${base}`;
        },
        /**
         * coefficient on existing debt to calculate new debt
         */
        getCompoundedStabilityFee() {
          return this.state.compoundedStabilityFee;
        },
        /**
         * Called by a vault when its balances change.
         *
         * @param {NormalizedDebt} oldDebtNormalized
         * @param {Amount<'nat'>} oldCollateral
         * @param {VaultId} vaultId
         * @param {import('./vault.js').VaultPhase} vaultPhase at the end of whatever change updated balances
         * @param {Vault} vault
         * @returns {void}
         */
        handleBalanceChange(
          oldDebtNormalized,
          oldCollateral,
          vaultId,
          vaultPhase,
          vault,
        ) {
          const { state, facets } = this;

          // the manager holds only vaults that can accrue interest or be liquidated;
          // i.e. vaults that have debt. The one exception is at the outset when
          // a vault has been added to the manager but not yet accounted for.
          const settled =
            AmountMath.isEmpty(oldDebtNormalized) &&
            vaultPhase !== Phase.ACTIVE;

          trace('handleBalanceChange', {
            oldDebtNormalized,
            oldCollateral,
            vaultId,
            vaultPhase,
            vault,
            settled,
          });

          const { prioritizedVaults } = collateralEphemera(
            state.collateralBrand,
          );
          if (settled) {
            assert(
              !prioritizedVaults.hasVaultByAttributes(
                oldDebtNormalized,
                oldCollateral,
                vaultId,
              ),
              'Settled vaults must not be retained in storage',
            );
            return;
          }

          const isNew = AmountMath.isEmpty(oldDebtNormalized);
          trace(state.collateralBrand, { isNew });
          if (!isNew) {
            // its position in the queue is no longer valid

            const vaultInStore = prioritizedVaults.removeVaultByAttributes(
              oldDebtNormalized,
              oldCollateral,
              vaultId,
            );
            assert(
              vault === vaultInStore,
              'handleBalanceChange for two different vaults',
            );
            trace('removed', vault, vaultId);
          }

          // replace in queue, but only if it can accrue interest or be liquidated (i.e. has debt).
          // getCurrentDebt() would also work (0x = 0) but require more computation.
          if (!AmountMath.isEmpty(vault.getNormalizedDebt())) {
            prioritizedVaults.addVault(vaultId, vault);
          }

          // total += vault's delta (post — pre)
          state.totalCollateral = AmountMath.subtract(
            AmountMath.add(state.totalCollateral, vault.getCollateralAmount()),
            oldCollateral,
          );
          state.totalDebt = AmountMath.subtract(
            AmountMath.add(state.totalDebt, vault.getCurrentDebt()),
            oldDebtNormalized,
          );
          void facets.helper.writeMetrics();
        },
      },
      self: {
        getGovernedParams() {
          const { collateralBrand } = this.state;
          return factoryPowers.getGovernedParams(collateralBrand);
        },

        /**
         * @param {ZCFSeat} seat
         */
        async makeVaultKit(seat) {
          const {
            state,
            facets: { manager },
          } = this;
          trace(state.collateralBrand, 'makeVaultKit');
          const { storageNode } = this.state;
          assert(marshaller, 'makeVaultKit missing marshaller');
          assert(storageNode, 'makeVaultKit missing storageNode');
          assert(zcf, 'makeVaultKit missing zcf');

          const vaultId = String(state.vaultCounter);

          // must be a presence to be stored in vault state
          const vaultStorageNode = await E(
            E(storageNode).makeChildNode(`vaults`),
          ).makeChildNode(`vault${vaultId}`);

          const { self: vault } = makeVault(manager, vaultId, vaultStorageNode);
          trace(state.collateralBrand, 'makeVaultKit made vault', vault);

          try {
            // TODO `await` is allowed until the above ordering is fixed
            const vaultKit = await vault.initVaultKit(seat, vaultStorageNode);
            // initVaultKit calls back to handleBalanceChange() which will add the
            // vault to prioritizedVaults

            // initVaultKit doesn't write to the storage node until it's returning
            // so if it returned then we know the node key was consumed
            state.vaultCounter += 1;

            return vaultKit;
          } catch (err) {
            console.error(
              'attempting recovery after initVaultKit failure',
              err,
            );
            // ??? do we still need this cleanup? it won't get into the store unless it has collateral,
            // which should qualify it to be in the store. If we drop this catch then the nested await
            // for `vault.initVaultKit()` goes away.

            // remove it from the store if it got in
            /** @type {NormalizedDebt} */
            // @ts-expect-error cast
            const normalizedDebt = AmountMath.makeEmpty(state.debtBrand);
            const collateralPre = seat.getCurrentAllocation().Collateral;
            const { prioritizedVaults } = collateralEphemera(
              state.collateralBrand,
            );
            try {
              prioritizedVaults.removeVaultByAttributes(
                normalizedDebt,
                collateralPre,
                vaultId,
              );
              console.warn(
                'removed vault',
                vaultId,
                'after initVaultKit failure',
              );
            } catch {
              console.info(
                'vault',
                vaultId,
                'never stored during initVaultKit failure',
              );
            }
            throw err;
          } finally {
            if (!seat.hasExited()) {
              seat.exit();
            }
          }
        },

        getCollateralQuote() {
          const { storedCollateralQuote } = collateralEphemera(
            this.state.collateralBrand,
          );
          if (!storedCollateralQuote)
            throw Fail`getCollateralQuote called before a collateral quote was available`;
          return storedCollateralQuote;
        },

        getPublicFacet() {
          return this.facets.collateral;
        },

        lockOraclePrices() {
          const { state, facets } = this;
          const { storedCollateralQuote } = collateralEphemera(
            state.collateralBrand,
          );
          if (!storedCollateralQuote)
            throw Fail`lockOraclePrices called before a collateral quote was available`;
          trace(
            `lockOraclePrices`,
            getAmountIn(storedCollateralQuote),
            getAmountOut(storedCollateralQuote),
          );

          state.lockedQuote = storedCollateralQuote;
          facets.helper.writeMetrics();
          return storedCollateralQuote;
        },
        /**
         * @param {ERef<AuctioneerPublicFacet>} auctionPF
         */
        async liquidateVaults(auctionPF) {
          const { state, facets } = this;
          const { self, helper } = facets;
          const {
            collateralBrand,
            compoundedStabilityFee,
            debtBrand,
            liquidatingVaults,
            lockedQuote,
          } = state;
          trace(collateralBrand, 'considering liquidation');

          if (!lockedQuote) {
            // By design, the first cycle of auction may call this before a quote is locked
            // because the schedule is global at the vaultDirector level, and if a manager
            // starts after the price lock time there's nothing to be done.
            // NB: this message should not log repeatedly.
            console.error(
              'Skipping liquidation because no quote is locked yet (may happen with new manager)',
            );
            return;
          }

          const { prioritizedVaults } = collateralEphemera(collateralBrand);
          prioritizedVaults || Fail`prioritizedVaults missing from ephemera`;

          const liqMargin = self.getGovernedParams().getLiquidationMargin();

          // totals *among* vaults being liquidated
          const { totalDebt, totalCollateral, vaultData, liqSeat } =
            getLiquidatableVaults(
              zcf,
              {
                quote: lockedQuote,
                interest: compoundedStabilityFee,
                margin: liqMargin,
              },
              prioritizedVaults,
              liquidatingVaults,
              debtBrand,
              collateralBrand,
            );
          // reset lockedQuote after we've used it for the liquidation decision
          state.lockedQuote = undefined;

          if (vaultData.getSize() === 0) {
            return;
          }
          trace(
            ' Found vaults to liquidate',
            liquidatingVaults.getSize(),
            totalCollateral,
          );

          helper.markLiquidating(totalDebt, totalCollateral);
          void helper.writeMetrics();

          const { userSeatPromise, deposited } = await E.when(
            E(auctionPF).makeDepositInvitation(),
            depositInvitation =>
              offerTo(
                zcf,
                depositInvitation,
                harden({ Minted: 'Bid' }),
                harden({ give: { Collateral: totalCollateral } }),
                liqSeat,
                liqSeat,
                { goal: totalDebt },
              ),
          );

          // This is expected to wait for the duration of the auction, which
          // is controlled by the auction parameters startFrequency, clockStep,
          // and the difference between startingRate and lowestRate.
          const [proceeds] = await Promise.all([deposited, userSeatPromise]);

          const { storedCollateralQuote } = collateralEphemera(
            this.state.collateralBrand,
          );

          trace(`LiqV after long wait`, proceeds);
          try {
            const { plan, vaultsInPlan } = helper.planProceedsDistribution(
              proceeds,
              totalDebt,
              storedCollateralQuote,
              vaultData,
              totalCollateral,
            );
            trace('PLAN', plan);
            // distributeProceeds may reconstitute vaults, removing them from liquidatingVaults
            helper.distributeProceeds({
              liqSeat,
              plan,
              totalCollateral,
              totalDebt,
              vaultsInPlan,
            });
          } catch (err) {
            console.error('🚨 Error distributing proceeds:', err);
          }

          // for all non-reconstituted vaults, transition to 'liquidated' state
          state.numLiquidationsCompleted += liquidatingVaults.getSize();
          for (const vault of liquidatingVaults.values()) {
            vault.liquidated();
            liquidatingVaults.delete(vault);
          }

          await facets.helper.writeMetrics();
        },
      },
    },

    {
      finish: ({ state, facets: { helper } }) => {
        helper.start();
        void state.assetTopicKit.recorder.write(
          harden({
            compoundedStabilityFee: state.compoundedStabilityFee,
            stabilityFee: factoryPowers
              .getGovernedParams(state.collateralBrand)
              .getStabilityFee(),
            latestStabilityFeeUpdate: state.latestStabilityFeeUpdate,
          }),
        );

        // push initial state of metrics
        void helper.writeMetrics();
      },
    },
  );

  /** @param {Omit<Parameters<typeof makeVaultManagerKitInternal>[0], 'metricsStorageNode'>} externalParams */
  const makeVaultManagerKit = async externalParams => {
    const metricsStorageNode = await E(
      externalParams.storageNode,
    ).makeChildNode('metrics');
    return makeVaultManagerKitInternal({
      ...externalParams,
      metricsStorageNode,
    });
  };
  return makeVaultManagerKit;
};

/**
 * @typedef {Awaited<ReturnType<ReturnType<typeof prepareVaultManagerKit>>>} VaultManagerKit
 */
/**
 * @typedef {VaultManagerKit['self']} VaultManager
 * Each VaultManager manages a single collateral type.
 *
 * It manages some number of outstanding debt positions, each called a Vault,
 * for which the collateral is provided in exchange for borrowed Minted.
 */
/** @typedef {VaultManagerKit['collateral']} CollateralManager */

/**
 * Support restarting kits from baggage and mutating the array holding them
 *
 * @param {import('@agoric/vat-data').Baggage} baggage
 */
export const provideAndStartVaultManagerKits = baggage => {
  trace('provideAndStartVaultManagerKits start');
  const key = 'vaultManagerKits';

  const noKits = /** @type {VaultManagerKit[]} */ (harden([]));

  for (const kit of provide(baggage, key, () => noKits)) {
    kit.helper.start();
  }

  trace('provideAndStartVaultManagerKits returning');
  return {
    /** @type {(kit: VaultManagerKit) => void} */
    add: kit => {
      appendToStoredArray(baggage, key, kit);
    },
    /** @type {(index: number) => VaultManagerKit} */
    get: index => {
      const kits = baggage.get(key);
      index < kits.length || Fail`no VaultManagerKit at index ${index}`;
      return kits[index];
    },
    length: () => baggage.get(key).length,
  };
};
harden(provideAndStartVaultManagerKits);
