// @ts-check
import '@endo/init';
import test from 'ava';

import { assertKeywordName } from '@agoric/zoe/src/cleanProposal.js';

import { AssetKind } from '@agoric/ertp';
import { Stable, Stake } from '../src/tokens.js';

test('token symbols are keywords', t => {
  t.notThrows(() => assertKeywordName(Stable.symbol));
  t.notThrows(() => assertKeywordName(Stake.symbol));
});

test('token assetKind matches ERTP', t => {
  t.is(Stable.assetKind, AssetKind.NAT);
  t.is(Stake.assetKind, AssetKind.NAT);
});
