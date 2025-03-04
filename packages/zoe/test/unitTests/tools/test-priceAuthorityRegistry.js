// eslint-disable-next-line import/no-extraneous-dependencies
import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { makeScalarBigMapStore } from '@agoric/vat-data';
import { AmountMath, makeIssuerKit } from '@agoric/ertp';
import { buildManualTimer } from '@agoric/swingset-vat/tools/manual-timer.js';
import { E } from '@endo/eventual-send';
import { providePriceAuthorityRegistry } from '../../../tools/priceAuthorityRegistry.js';
import { makeFakePriceAuthority } from '../../../tools/fakePriceAuthority.js';

test('price authority confused stores', async t => {
  const baggage = makeScalarBigMapStore('test baggage');
  const facets = providePriceAuthorityRegistry(baggage);

  const timer = buildManualTimer();
  const USD = makeIssuerKit('USD');
  const EUR = makeIssuerKit('EUR');
  const JPY = makeIssuerKit('JPY');

  const USDtoEUR = makeFakePriceAuthority({
    actualBrandIn: USD.brand,
    actualBrandOut: EUR.brand,
    timer,
    priceList: [2],
  });
  const JPYtoEUR = makeFakePriceAuthority({
    actualBrandIn: JPY.brand,
    actualBrandOut: EUR.brand,
    timer,
    priceList: [10],
  });

  await E(facets.adminFacet).registerPriceAuthority(
    USDtoEUR,
    USD.brand,
    EUR.brand,
  );
  // clobbers?
  await E(facets.adminFacet).registerPriceAuthority(
    JPYtoEUR,
    JPY.brand,
    EUR.brand,
  );

  const { priceAuthority } = facets;
  {
    const amtIn = AmountMath.make(USD.brand, 100n);
    const { quoteAmount } = await E(priceAuthority).quoteGiven(
      amtIn,
      EUR.brand,
    );
    const expected = AmountMath.make(EUR.brand, 100n * 2n);
    t.deepEqual(quoteAmount.value[0].amountOut, expected);
  }
  {
    const amtIn = AmountMath.make(JPY.brand, 100n);
    const { quoteAmount } = await E(priceAuthority).quoteGiven(
      amtIn,
      EUR.brand,
    );
    const expected = AmountMath.make(EUR.brand, 100n * 10n);
    t.deepEqual(quoteAmount.value[0].amountOut, expected);
  }
});
