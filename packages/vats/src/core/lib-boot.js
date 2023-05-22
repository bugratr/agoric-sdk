// @ts-check
import { E, Far } from '@endo/far';
import { makePassableEncoding } from '@agoric/swingset-vat/tools/passableEncoding.js';
import { heapZone } from '@agoric/zone';
import {
  makeVatSpace,
  makeWellKnownSpaces,
  runModuleBehaviors,
} from './utils.js';
import { makePromiseSpace } from './promise-space.js';

const { Fail, quote: q } = assert;

/**
 * @typedef {true | string | { [key: string]: BootstrapManifestPermit | undefined }} BootstrapManifestPermit
 */

/**
 * A manifest is an object in which each key is the name of a function to run
 * at bootstrap and the corresponding value is a "permit" describing an
 * attenuation of allPowers that should be provided as its first argument
 * (cf. packages/vats/src/core/boot.js).
 *
 * A permit is either
 * - `true` or a string (both meaning no attenuation, with a string serving
 *   as a grouping label for convenience and diagram generation), or
 * - an object whose keys identify properties to preserve and whose values
 *   are themselves (recursive) permits.
 *
 * @typedef {Record<string, BootstrapManifestPermit>} BootstrapManifest
 *
 */

/**
 * @typedef {(powers: *, config?: *) => Promise<void>} BootBehavior
 * @typedef {Record<string, unknown>} ModuleNamespace
 * @typedef {{ utils: typeof import('./utils.js') } & Record<string, Record<string, any>>} BootModules
 */

/** @type {<X>(a: X[], b: X[]) => X[]} */
const setDiff = (a, b) => a.filter(x => !b.includes(x));

/**
 * @param {VatPowers & {
 *   D: DProxy,
 *   logger: (msg) => void,
 * }} vatPowers
 * @param {Record<string, unknown>} vatParameters
 * @param {BootstrapManifest} bootManifest
 * @param {Record<string, BootBehavior>} behaviors
 * @param {BootModules} modules
 * @param {import('@agoric/zone').Zone} [zone]
 */
export const makeBootstrap = (
  vatPowers,
  vatParameters,
  bootManifest,
  behaviors,
  modules,
  zone = heapZone,
) => {
  const { keys } = Object;
  const extra = setDiff(keys(bootManifest), keys(behaviors));
  extra.length === 0 || Fail`missing behavior for manifest keys: ${extra}`;

  const log = vatPowers.logger || console.info;
  const powerStore = zone.mapStore('Bootstrap Powers');
  const { produce, consume } = makePromiseSpace({ log, store: powerStore });
  produce.powerStore.resolve(powerStore);

  /**
   * Bootstrap vats and devices.
   *
   * @param {SwingsetVats} vats
   * @param {SoloDevices | ChainDevices} devices
   */
  const rawBootstrap = async (vats, devices) => {
    // Complete SwingSet wiring.
    const { D } = vatPowers;
    if (!devices.mailbox) {
      console.warn('No mailbox device. Not registering with vattp');
    }
    await (devices.mailbox &&
      (D(devices.mailbox).registerInboundHandler(vats.vattp),
      E(vats.vattp).registerMailboxDevice(devices.mailbox)));

    const svc = E(vats.vatAdmin).createVatAdminService(devices.vatAdmin);
    const criticalVatKey = await E(vats.vatAdmin).getCriticalVatKey();
    const { space: namedVat, durableStore: vatStore } = makeVatSpace(
      svc,
      criticalVatKey,
      console.info,
    );

    const namesVat = namedVat.consume.agoricNames;
    const { nameHub: agoricNames, nameAdmin: agoricNamesAdmin } = await E(
      namesVat,
    ).getNameHubKit();
    const spaces = await makeWellKnownSpaces(agoricNamesAdmin, log);
    produce.agoricNames.resolve(agoricNames);
    produce.agoricNamesAdmin.resolve(agoricNamesAdmin);
    produce.vatStore.resolve(vatStore);

    const runBehaviors = manifest => {
      return runModuleBehaviors({
        // eslint-disable-next-line no-use-before-define
        allPowers,
        behaviors,
        manifest,
        makeConfig: (name, permit) => {
          log(`bootstrap: ${name}(${q(permit)}`);
          return vatParameters[name];
        },
      });
    };

    // TODO: Aspires to be BootstrapPowers, but it's too specific.
    const allPowers = harden({
      vatPowers,
      vatParameters,
      vats,
      devices,
      zone,
      produce,
      consume,
      namedVat,
      ...spaces,
      runBehaviors,
      // These module namespaces might be useful for core eval governance.
      modules,
    });

    await runBehaviors(bootManifest);

    const { coreProposalCode } = vatParameters;
    if (!coreProposalCode) {
      return;
    }

    // Start the governance from the core proposals.
    const coreEvalMessage = {
      type: 'CORE_EVAL',
      evals: [
        {
          json_permits: 'true',
          js_code: coreProposalCode,
        },
      ],
    };
    /** @type {{coreEvalBridgeHandler: Promise<import('../types.js').BridgeHandler>}} */
    // @ts-expect-error cast
    const { coreEvalBridgeHandler } = consume;
    await E(coreEvalBridgeHandler).fromBridge(coreEvalMessage);
  };

  // For testing supports
  const vatData = new Map();
  const { encodePassable, decodePassable } = makePassableEncoding();

  return Far('bootstrap', {
    /**
     * Bootstrap vats and devices.
     *
     * @param {SwingsetVats} vats
     * @param {SoloDevices | ChainDevices} devices
     */
    bootstrap: (vats, devices) => {
      for (const [name, root] of Object.entries(vats)) {
        if (name !== 'vatAdmin') {
          vatData.set(name, { root });
        }
      }
      return rawBootstrap(vats, devices).catch(e => {
        // Terminate because the vat is in an irrecoverable state.
        vatPowers.exitVatWithFailure(e);
        // Throw the error to reject this promise but it will be unhandled because rawBoostrap() isn't returned.
        throw e;
      });
    },
    consumeItem: name => {
      assert.typeof(name, 'string');
      return consume[name];
    },
    produceItem: (name, resolution) => {
      assert.typeof(name, 'string');
      produce[name].resolve(resolution);
    },
    resetItem: name => {
      assert.typeof(name, 'string');
      produce[name].reset();
    },

    //#region testing supports
    messageVat: async ({ name, methodName, args = [] }) => {
      const vat = vatData.get(name) || Fail`unknown vat name: ${q(name)}`;
      const { root } = vat;
      const decodedArgs = args.map(decodePassable);
      const result = await E(root)[methodName](...decodedArgs);
      return encodePassable(result);
    },
    messageVatObject: async ({ presence, methodName, args = [] }) => {
      const object = decodePassable(presence);
      const decodedArgs = args.map(decodePassable);
      const result = await E(object)[methodName](...decodedArgs);
      return encodePassable(result);
    },
    /* Like `messageVatObject` but does not await return value */
    messageVatObjectSendOnly: ({ presence, methodName, args = [] }) => {
      const object = decodePassable(presence);
      const decodedArgs = args.map(decodePassable);
      void E(object)[methodName](...decodedArgs);
    },
    awaitVatObject: async ({ presence, path = [], rawOutput = false }) => {
      let value = await decodePassable(presence);
      for (const key of path) {
        // eslint-disable-next-line no-await-in-loop
        value = await value[key];
      }
      return rawOutput ? value : encodePassable(value);
    },
    /**
     * @template K, V
     * @param {MapStore<K, V>} store
     */
    snapshotStore: store => harden([...store.entries()]),
    //#endregion
  });
};
