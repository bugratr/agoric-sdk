/* global process setTimeout clearTimeout */
import path from 'path';
import fs from 'fs';
import {
  importMailbox,
  exportMailbox,
} from '@agoric/swingset-vat/src/devices/mailbox/mailbox.js';

import anylogger from 'anylogger';

import { makeSlogSender } from '@agoric/telemetry';

import { resolve as importMetaResolve } from 'import-meta-resolve';
import { Fail } from '@agoric/assert';
import { makeWithQueue } from '@agoric/internal/src/queue.js';
import { makeBatchedDeliver } from '@agoric/internal/src/batched-deliver.js';
import stringify from './helpers/json-stable-stringify.js';
import { launch } from './launch-chain.js';
import { getTelemetryProviders } from './kernel-stats.js';
import { DEFAULT_SIM_SWINGSET_PARAMS, QueueInbound } from './sim-params.js';
import { parseQueueSizes } from './params.js';
import { makeQueue, makeQueueStorageMock } from './helpers/make-queue.js';

const console = anylogger('fake-chain');

const TELEMETRY_SERVICE_NAME = 'sim-cosmos';

const PRETEND_BLOCK_DELAY = 5;
const scaleBlockTime = ms => Math.floor(ms / 1000);

async function makeMapStorage(file) {
  let content;
  const map = new Map();
  map.commit = async () => {
    const obj = {};
    [...map.entries()].forEach(([k, v]) => (obj[k] = exportMailbox(v)));
    const json = stringify(obj);
    await fs.promises.writeFile(file, json);
  };

  await (async () => {
    content = await fs.promises.readFile(file);
    return JSON.parse(content);
  })().then(
    obj =>
      Object.entries(obj).forEach(([k, v]) => map.set(k, importMailbox(v))),
    () => {},
  );

  return map;
}

export async function connectToFakeChain(basedir, GCI, delay, inbound) {
  const initialHeight = 0;
  const mailboxFile = path.join(basedir, `fake-chain-${GCI}-mailbox.json`);
  const bootAddress = `${GCI}-client`;

  const mailboxStorage = await makeMapStorage(mailboxFile);

  const argv = {
    giveMeAllTheAgoricPowers: true,
    hardcodedClientAddresses: [bootAddress],
    bootMsg: {
      supplyCoins: [
        { denom: 'ubld', amount: `${50_000n * 10n ** 6n}` },
        { denom: 'uist', amount: `${1_000_000n * 10n ** 6n}` },
      ],
      params: DEFAULT_SIM_SWINGSET_PARAMS,
    },
  };

  const url = await importMetaResolve(
    process.env.CHAIN_BOOTSTRAP_VAT_CONFIG ||
      argv.bootMsg.params.bootstrap_vat_config,
    import.meta.url,
  );
  const vatconfig = new URL(url).pathname;
  const stateDBdir = path.join(basedir, `fake-chain-${GCI}-state`);
  function replayChainSends() {
    Fail`Replay not implemented`;
  }
  async function clearChainSends() {
    return [];
  }

  const env = process.env;
  const { metricsProvider } = getTelemetryProviders({
    console,
    env,
    serviceName: TELEMETRY_SERVICE_NAME,
  });

  const slogSender = await makeSlogSender({
    stateDir: stateDBdir,
    serviceName: TELEMETRY_SERVICE_NAME,
    env,
  });

  const actionQueueStorage = makeQueueStorageMock().storage;
  const highPriorityQueueStorage = makeQueueStorageMock().storage;
  const actionQueue = makeQueue(actionQueueStorage);

  const s = await launch({
    actionQueueStorage,
    highPriorityQueueStorage,
    kernelStateDBDir: stateDBdir,
    mailboxStorage,
    clearChainSends,
    replayChainSends,
    vatconfig,
    argv,
    debugName: GCI,
    metricsProvider,
    slogSender,
  });

  const { blockingSend, savedHeight } = s;

  let blockHeight = savedHeight;
  const intoChain = [];
  let nextBlockTimeout = 0;

  const maximumDelay = (delay || PRETEND_BLOCK_DELAY) * 1000;

  const withBlockQueue = makeWithQueue();
  const unhandledSimulateBlock = withBlockQueue(
    async function unqueuedSimulateBlock() {
      const blockTime = scaleBlockTime(Date.now());
      blockHeight += 1;

      const params = DEFAULT_SIM_SWINGSET_PARAMS;
      const beginAction = {
        type: 'BEGIN_BLOCK',
        blockHeight,
        blockTime,
        params,
      };
      await blockingSend(beginAction);
      const inboundQueueMax = parseQueueSizes(params.queue_max)[QueueInbound];
      const inboundQueueAllowed = Math.max(
        0,
        inboundQueueMax - actionQueue.size(),
      );

      // Gather up the new messages into the latest block.
      const thisBlock = intoChain.splice(0, inboundQueueAllowed);

      for (const [i, [newMessages, acknum]] of thisBlock.entries()) {
        actionQueue.push({
          action: {
            type: 'DELIVER_INBOUND',
            peer: bootAddress,
            messages: newMessages,
            ack: acknum,
            blockHeight,
            blockTime,
          },
          context: { blockHeight, txHash: 'simTx', msgIdx: i },
        });
      }
      const endAction = { type: 'END_BLOCK', blockHeight, blockTime };
      await blockingSend(endAction);

      // Done processing, "commit the block".
      await blockingSend({ type: 'COMMIT_BLOCK', blockHeight, blockTime });

      clearTimeout(nextBlockTimeout);
      // eslint-disable-next-line no-use-before-define
      nextBlockTimeout = setTimeout(simulateBlock, maximumDelay);

      // TODO: maybe add latency to the inbound messages.
      const mailbox = mailboxStorage.get(`${bootAddress}`);
      const { outbox = [], ack = 0 } = mailbox ? exportMailbox(mailbox) : {};
      inbound(GCI, outbox, ack);
    },
  );

  const simulateBlock = () =>
    unhandledSimulateBlock().catch(e => {
      console.error(e);
      process.exit(1);
    });

  let totalDeliveries = 0;
  async function deliver(newMessages, acknum) {
    totalDeliveries += 1;
    console.log(`delivering to ${GCI} (trips=${totalDeliveries})`);

    intoChain.push([newMessages, acknum]);
    // Only actually simulate a block if we're not in bootstrap.
    let p;
    if (blockHeight && !delay) {
      clearTimeout(nextBlockTimeout);
      p = simulateBlock();
    }
    await p;
  }

  const bootSimChain = async () => {
    if (blockHeight) {
      return;
    }
    // The before-first-block is special... do it now.
    // This emulates what x/swingset does to run a BOOTSTRAP_BLOCK
    // before continuing with the real initialHeight.
    await blockingSend({
      type: 'BOOTSTRAP_BLOCK',
      blockTime: scaleBlockTime(Date.now()),
    });
    blockHeight = initialHeight;
  };

  const enableDeliveries = () => {
    // Start the first pretend block.
    nextBlockTimeout = setTimeout(simulateBlock, maximumDelay);
  };

  bootSimChain().then(enableDeliveries, e => {
    console.error(`Cannot boot sim chain:`, e);
    process.exit(1);
  });

  const batchDelayMs = delay ? delay * 1000 : undefined;
  return makeBatchedDeliver(
    deliver,
    { clearTimeout, setTimeout },
    batchDelayMs,
  );
}
