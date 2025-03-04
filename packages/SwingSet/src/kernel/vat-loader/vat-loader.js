import { assert, Fail } from '@agoric/assert';
import { assertKnownOptions } from '../../lib/assertOptions.js';
import { makeVatSlot } from '../../lib/parseVatSlots.js';

export function makeVatRootObjectSlot() {
  return makeVatSlot('object', true, 0n);
}

export function makeVatLoader(stuff) {
  const {
    overrideVatManagerOptions = {},
    vatManagerFactory,
    kernelSlog,
    makeSourcedConsole,
    kernelKeeper,
  } = stuff;

  /** @typedef {import('../../types-internal.js').VatManager} VatManager */

  const allowedOptions = [
    'name',
    'workerOptions',
    'meterID',
    'enableDisavow',
    'enableSetup',
    'enablePipelining',
    'useTranscript',
    'critical',
    'reapInterval',
  ];

  /**
   * Instantiate a new vat.  The root object will be available soon, but we
   * immediately return the vatID so the ultimate requestor doesn't have to
   * wait.
   *
   * @param {string} vatID  The vatID for the new vat
   *
   * @param {object} details
   *
   * @param {boolean} details.isDynamic  If true, the vat being created is a
   *    dynamic vat; if false, it's a static vat (these have differences in
   *    their allowed options and some of their option defaults).
   *
   * @param {SourceOfBundle} details.source
   *    an object which either has a `bundle` (JSON-serializable
   *    data), a `bundleName` string, or a `bundleID` string. The bundle
   *    defines the vat, and should be generated by calling bundle-source on
   *    a module with an export named `makeRootObject()` (or possibly
   *    `setup()` if the 'enableSetup' option is true). If `bundleName` is
   *    used, it must identify a bundle already known to the kernel (via the
   *    `config.bundles` table) which satisfies these constraints.
   *
   * @param {import('../../types-internal.js').RecordedVatOptions} details.options
   *
   * @returns {Promise<VatManager>} A Promise which fires when the
   *    vat is ready for messages.
   */
  async function create(vatID, { isDynamic, source, options }) {
    assert(
      'bundle' in source || 'bundleName' in source || 'bundleID' in source,
      'broken source',
    );
    let vatSourceBundle;
    let sourceDesc;
    if ('bundle' in source) {
      vatSourceBundle = source.bundle;
      // TODO: maybe hash the bundle object somehow for the description
      sourceDesc = 'from source bundle';
    } else if ('bundleName' in source) {
      vatSourceBundle = kernelKeeper.getNamedBundle(source.bundleName);
      vatSourceBundle || Fail`unknown bundle name ${source.bundleName}`;
      sourceDesc = `from bundleName: ${source.bundleName}`;
    } else if ('bundleID' in source) {
      vatSourceBundle = kernelKeeper.getBundle(source.bundleID);
      vatSourceBundle || Fail`unknown bundleID ${source.bundleID}`;
      sourceDesc = `from bundleID: ${source.bundleID}`;
    } else {
      Fail`unknown vat source descriptor ${source}`;
    }
    assert.typeof(vatSourceBundle, 'object', 'vat creation requires bundle');

    assertKnownOptions(options, allowedOptions);
    const {
      meterID,
      workerOptions,
      enableSetup = false,
      enableDisavow = false,
      enablePipelining = false,
      useTranscript = true,
      critical = false,
      name,
    } = options;

    if (isDynamic && enableDisavow) {
      throw Error(`dynamic vat ${vatID} must not use option enableDisavow`);
    }
    if (!isDynamic && meterID !== undefined) {
      throw Error(`static vat ${vatID} must not use option meterID`);
    }
    const description = `${options.name || ''} (${sourceDesc})`.trim();

    const { starting } = kernelSlog.provideVatSlogger(
      vatID,
      isDynamic,
      description,
      name,
      vatSourceBundle,
      workerOptions.type,
    );

    const managerOptions = {
      workerOptions,
      bundle: vatSourceBundle,
      metered: !!meterID,
      enableSetup,
      enablePipelining,
      sourcedConsole: makeSourcedConsole(vatID),
      useTranscript,
      critical,
      name,
      ...overrideVatManagerOptions,
    };
    const liveSlotsOptions = {
      enableDisavow,
      relaxDurabilityRules: kernelKeeper.getRelaxDurabilityRules(),
    };

    const finish = starting && kernelSlog.startup(vatID);
    const manager = await vatManagerFactory(vatID, {
      managerOptions,
      liveSlotsOptions,
    });
    starting && finish();
    return manager;
  }

  async function loadTestVat(vatID, setup, options) {
    const { name, workerOptions, enablePipelining, critical } = options;
    const managerOptions = {
      workerOptions,
      setup,
      retainSyscall: true, // let unit test to drive syscall between deliveries
      metered: false,
      enableSetup: true,
      enablePipelining,
      useTranscript: true,
      critical,
      name,
      ...overrideVatManagerOptions,
    };
    const liveSlotsOptions = {};
    const manager = await vatManagerFactory(vatID, {
      managerOptions,
      liveSlotsOptions,
    });
    return manager;
  }

  return harden({ create, loadTestVat });
}
