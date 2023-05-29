// @ts-check

import { Fail } from '@agoric/assert';
import { AmountMath } from '@agoric/ertp';
import { assertAllDefined } from '@agoric/internal';
import { parseRatio } from '@agoric/zoe/src/contractSupport/ratio.js';

// XXX support other decimal places
const COSMOS_UNIT = 1_000_000n;
const scaleDecimals = num => BigInt(num * Number(COSMOS_UNIT));

// NB: not really a Proposal because the brands are not remotes
// Instead they're copyRecord like  "{"boardId":"board0257","iface":"Alleged: IST brand"}" to pass through the boardId
// mustMatch(harden(proposal), ProposalShape);
/**
 * Give/want
 *
 * @param {Record<string, Brand>} brands
 * @param {{ giveMinted?: number, wantMinted?: number } | { collateralBrandKey: string, giveCollateral?: number, wantCollateral?: number }} opts
 * @returns {Proposal}
 */
const makeVaultProposal = (brands, opts) => {
  const proposal = { give: {}, want: {} };

  if ('giveCollateral' in opts && opts.giveCollateral) {
    const { collateralBrandKey } = opts;
    proposal.give.Collateral = {
      brand: brands[collateralBrandKey],
      value: scaleDecimals(opts.giveCollateral),
    };
  }
  if ('giveMinted' in opts && opts.giveMinted) {
    proposal.give.Minted = {
      brand: brands.IST,
      value: scaleDecimals(opts.giveMinted),
    };
  }

  if ('wantCollateral' in opts && opts.wantCollateral) {
    const { collateralBrandKey } = opts;
    proposal.want.Collateral = {
      brand: brands[collateralBrandKey],
      value: scaleDecimals(opts.wantCollateral),
    };
  }
  if ('wantMinted' in opts && opts.wantMinted) {
    proposal.want.Minted = {
      brand: brands.IST,
      value: scaleDecimals(opts.wantMinted),
    };
  }

  return harden(proposal);
};

/**
 * @param {Record<string, Brand>} brands
 * @param {{ offerId: string, wantMinted: number, giveCollateral: number, collateralBrandKey: string }} opts
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makeOpenOffer = (brands, opts) => {
  const proposal = makeVaultProposal(brands, opts);

  // NB: not really a Proposal because the brands are not remotes
  // Instead they're copyRecord like  "{"boardId":"board0257","iface":"Alleged: IST brand"}" to pass through the boardId
  // mustMatch(harden(proposal), ProposalShape);

  const collateralBrand = brands[opts.collateralBrandKey];

  return {
    id: opts.offerId,
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['VaultFactory'],
      callPipe: [
        ['getCollateralManager', [collateralBrand]],
        ['makeVaultInvitation'],
      ],
    },
    proposal,
  };
};

/**
 * @param {Record<string, Brand>} brands
 * @param {{ offerId: string, collateralBrandKey?: string, giveCollateral?: number, wantCollateral?: number, giveMinted?: number, wantMinted?: number }} opts
 * @param {string} previousOffer
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makeAdjustOffer = (brands, opts, previousOffer) => {
  // NB: not really a Proposal because the brands are not remotes
  // Instead they're copyRecord like  "{"boardId":"board0257","iface":"Alleged: IST brand"}" to pass through the boardId
  // mustMatch(harden(proposal), ProposalShape);
  const proposal = makeVaultProposal(brands, opts);

  return {
    id: opts.offerId,
    invitationSpec: {
      source: 'continuing',
      previousOffer,
      invitationMakerName: 'AdjustBalances',
    },
    proposal,
  };
};

/**
 * @param {Record<string, Brand>} brands
 * @param {{ offerId: string, collateralBrandKey?: string, giveMinted: number }} opts
 * @param {string} previousOffer
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makeCloseOffer = (brands, opts, previousOffer) => {
  const proposal = makeVaultProposal(brands, opts);

  return {
    id: opts.offerId,
    invitationSpec: {
      source: 'continuing',
      previousOffer,
      invitationMakerName: 'CloseVault',
    },
    proposal,
  };
};

/**
 * @param {string} vaultId
 * @param {Promise<import('@agoric/smart-wallet/src/smartWallet').CurrentWalletRecord>} currentP
 * @returns {Promise<string>} offer id in which the vault was made
 */
export const lookupOfferIdForVault = async (vaultId, currentP) => {
  const { offerToPublicSubscriberPaths } = await currentP;

  for (const [offerId, publicSubscribers] of offerToPublicSubscriberPaths) {
    if (publicSubscribers.vault?.endsWith(vaultId)) {
      return offerId;
    }
  }
  throw Fail`vault ${vaultId} not found`;
};

/**
 * @param {Record<string, Brand>} brands
 * @param {({ wantMinted: number, giveMinted?: undefined } | { giveMinted: number, wantMinted?: undefined })} opts
 * @param {number} [fee=0]
 * @param {string} [anchor]
 * @returns {Proposal} XXX not a real proposal, uses BoardRemote
 */
const makePsmProposal = (brands, opts, fee = 0, anchor = 'AUSD') => {
  const giving = 'giveMinted' in opts ? 'minted' : 'anchor';
  const brand =
    giving === 'anchor'
      ? { in: brands[anchor], out: brands.IST }
      : { in: brands.IST, out: brands[anchor] };
  const value =
    Number(giving === 'anchor' ? opts.wantMinted : opts.giveMinted) *
    Number(COSMOS_UNIT);
  const adjusted = {
    in: BigInt(Math.ceil(giving === 'anchor' ? value / (1 - fee) : value)),
    out: BigInt(Math.ceil(giving === 'minted' ? value * (1 - fee) : value)),
  };
  return {
    give: {
      In: { brand: brand.in, value: adjusted.in },
    },
    want: {
      Out: { brand: brand.out, value: adjusted.out },
    },
  };
};

/**
 * @param {Instance} instance
 * @param {Record<string, Brand>} brands
 * @param {{ offerId: string, feePct?: number, pair: [string, string] } &
 *         ({ wantMinted: number } | { giveMinted: number })} opts
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makePsmSwapOffer = (instance, brands, opts) => {
  const method =
    'wantMinted' in opts
      ? 'makeWantMintedInvitation'
      : 'makeGiveMintedInvitation'; // ref psm.js
  const proposal = makePsmProposal(
    brands,
    opts,
    opts.feePct ? opts.feePct / 100 : undefined,
    opts.pair[1],
  );

  // NB: not really a Proposal because the brands are not remotes
  // Instead they're copyRecord like  "{"boardId":"board0257","iface":"Alleged: IST brand"}" to pass through the boardId
  // mustMatch(harden(proposal), ProposalShape);

  return {
    id: opts.offerId,
    invitationSpec: {
      source: 'contract',
      instance,
      publicInvitationMaker: method,
    },
    proposal,
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
    const assetDesc = Object.values(agoricNames.vbankAsset).find(
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

/**
 * @param {Record<string, Brand>} _brands
 * @param {{
 *   offerId: string,
 *   give: string,
 *   maxBuy: string,
 *   wantMinimum?: string,
 *   parseAmount: (x: string) => Amount<'nat'>,
 * } & ({
 *   price: number,
 * } | {
 *   discount: number,  // -1 to 1. e.g. 0.10 for 10% discount, -0.05 for 5% markup
 * })} opts
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makeBidOffer = (_brands, opts) => {
  assert.typeof(opts.parseAmount, 'function');
  assertAllDefined({
    offerId: opts.offerId,
    give: opts.give,
    maxBuy: opts.maxBuy,
  });
  const { parseAmount } = opts;
  const proposal = {
    give: { Bid: parseAmount(opts.give) },
    ...(opts.wantMinimum
      ? { want: { Collateral: parseAmount(opts.wantMinimum) } }
      : {}),
  };
  const istBrand = proposal.give.Bid.brand;
  const maxBuy = parseAmount(opts.maxBuy);

  const bounds = (x, lo, hi) => {
    assert(x >= lo && x <= hi);
    return x;
  };

  assert(
    'price' in opts || 'discount' in opts,
    'must specify price or discount',
  );
  /** @type {import('./auction/auctionBook.js').OfferSpec} */
  const offerArgs =
    'price' in opts
      ? {
          maxBuy: parseAmount(opts.maxBuy),
          offerPrice: parseRatio(opts.price, istBrand, maxBuy.brand),
        }
      : {
          maxBuy,
          offerBidScaling: parseRatio(
            (1 - bounds(opts.discount, -1, 1)).toFixed(2),
            istBrand,
            istBrand,
          ),
        };

  /** @type {import('@agoric/smart-wallet/src/offers.js').OfferSpec} */
  const offerSpec = {
    id: opts.offerId,
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['auctioneer'],
      callPipe: [['makeBidInvitation', [maxBuy.brand]]],
    },
    proposal,
    offerArgs,
  };
  return offerSpec;
};

/**
 * @param {Record<string, Brand>} brands
 * @param {{
 *   offerId: string,
 *   give: number,
 *   collateralBrandKey: string,
 * }} opts
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makeAddCollateralOffer = (brands, opts) => {
  /** @type {AmountKeywordRecord} */
  const give = {
    Collateral: AmountMath.make(
      brands[opts.collateralBrandKey],
      scaleDecimals(opts.give),
    ),
  };

  /** @type {import('@agoric/smart-wallet/src/offers.js').OfferSpec} */
  const offerSpec = {
    id: opts.offerId,
    invitationSpec: {
      source: 'agoricContract',
      instancePath: ['reserve'],
      callPipe: [['makeAddCollateralInvitation', []]],
    },
    proposal: { give },
  };
  return offerSpec;
};

/**
 *
 * @param {Record<string, Brand>} _brands
 * @param {{
 *   offerId: string,
 *   roundId?: bigint,
 *   unitPrice: bigint,
 * }} opts
 * @param {string} previousOffer
 * @returns {import('@agoric/smart-wallet/src/offers.js').OfferSpec}
 */
const makePushPriceOffer = (_brands, opts, previousOffer) => {
  return {
    id: opts.offerId,
    invitationSpec: {
      source: 'continuing',
      previousOffer,
      invitationMakerName: 'PushPrice',
      invitationArgs: harden([
        { unitPrice: opts.unitPrice, roundId: opts.roundId },
      ]),
    },
    proposal: {},
  };
};

export const Offers = {
  auction: {
    Bid: makeBidOffer,
  },
  fluxAggregator: {
    PushPrice: makePushPriceOffer,
  },
  psm: {
    // lowercase because it's not an invitation name. Instead it's an abstraction over two invitation makers.
    swap: makePsmSwapOffer,
  },
  vaults: {
    OpenVault: makeOpenOffer,
    AdjustBalances: makeAdjustOffer,
    CloseVault: makeCloseOffer,
  },
  reserve: {
    AddCollateral: makeAddCollateralOffer,
  },
};
