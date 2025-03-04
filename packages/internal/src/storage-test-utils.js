// @ts-check
import { Far } from '@endo/far';
import { makeMarshal, Remotable } from '@endo/marshal';
import { makeTracer } from './debug.js';
import {
  isStreamCell,
  makeChainStorageRoot,
  unmarshalFromVstorage,
} from './lib-chainStorage.js';
import { bindAllMethods } from './method-tools.js';

const { Fail } = assert;

const trace = makeTracer('StorTU', false);

/**
 * A map corresponding with a total function such that `get(key)`
 * is assumed to always succeed.
 *
 * @template K, V
 * @typedef {{[k in Exclude<keyof Map<K, V>, 'get'>]: Map<K, V>[k]} & {get: (key: K) => V}} TotalMap
 */
/**
 * @template T
 * @typedef {T extends Map<infer K, infer V> ? TotalMap<K, V> : never} TotalMapFrom
 */

/**
 * A convertSlotToVal function that produces basic Remotables. Assumes
 * that all slots are Remotables (i.e. none are Promises).
 *
 * @param {string} _slotId
 * @param {string} iface
 */
export const slotToRemotable = (_slotId, iface = 'Remotable') =>
  Remotable(iface);

/**
 * A basic marshaller whose unserializer produces Remotables. It can
 * only serialize plain data, not Remotables.
 */
export const defaultMarshaller = makeMarshal(undefined, slotToRemotable, {
  serializeBodyFormat: 'smallcaps',
});

/**
 * A deserializer which produces slot strings instead of Remotables,
 * so if `a = Far('iface')`, and serializing `{ a }` into `capData`
 * assigned it slot `board123`, then `slotStringUnserialize(capData)`
 * would produce `{ a: 'board123' }`.
 *
 * This may be useful for display purposes.
 *
 * Limitations:
 *  * it cannot handle Symbols (registered or well-known)
 *  * it can handle BigInts, but serialized data that contains a
 *     particular unusual string will be unserialized into a BigInt by
 *     mistake
 *  * it cannot handle Promises, NaN, +/- Infinity, undefined, or
 *    other non-JSONable JavaScript values
 */
const makeSlotStringUnserialize = () => {
  /** @type { (slot: string, iface: string) => any } */
  const identitySlotToValFn = (slot, _) => Far('unk', { toJSON: () => slot });
  const { fromCapData } = makeMarshal(undefined, identitySlotToValFn);
  /** @type { (capData: any) => any } */
  const unserialize = capData =>
    JSON.parse(
      JSON.stringify(fromCapData(capData), (_, val) => {
        if (typeof val === 'bigint') {
          // JSON cannot accept BigInts. This unusual string is a
          // cheap alternative to a proper Hilbert Hotel.
          return `@encromulate:${val}`;
        } else {
          return val;
        }
      }),
      (_key, val) => {
        if (typeof val === 'string' && val.startsWith('@encromulate')) {
          return BigInt(val.split(':')[1]);
        } else {
          return val;
        }
      },
    );
  return harden(unserialize);
};
export const slotStringUnserialize = makeSlotStringUnserialize();

/**
 * For testing, creates a chainStorage root node over an in-memory map
 * and exposes both the map and the sequence of received messages.
 * The `sequence` option defaults to true.
 *
 * @param {string} rootPath
 * @param {Parameters<typeof makeChainStorageRoot>[2]} [rootOptions]
 */
export const makeFakeStorageKit = (rootPath, rootOptions) => {
  const resolvedOptions = { sequence: true, ...rootOptions };
  /** @type {TotalMap<string, string>} */
  const data = new Map();
  /** @param {string} prefix */
  const getChildEntries = prefix => {
    assert(prefix.endsWith('.'));
    const childEntries = new Map();
    for (const [path, value] of data.entries()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const [segment, ...suffix] = path.slice(prefix.length).split('.');
      if (suffix.length === 0) {
        childEntries.set(segment, value);
      } else if (!childEntries.has(segment)) {
        childEntries.set(segment, null);
      }
    }
    return childEntries;
  };
  /** @type {import('../src/lib-chainStorage.js').StorageMessage[]} */
  const messages = [];
  /** @param {import('../src/lib-chainStorage.js').StorageMessage} message */
  // eslint-disable-next-line consistent-return
  const toStorage = message => {
    messages.push(message);
    switch (message.method) {
      case 'getStoreKey': {
        const [key] = message.args;
        return { storeName: 'swingset', storeSubkey: `fake:${key}` };
      }
      case 'get': {
        const [key] = message.args;
        return data.has(key) ? data.get(key) : null;
      }
      case 'children': {
        const [key] = message.args;
        const childEntries = getChildEntries(`${key}.`);
        return [...childEntries.keys()];
      }
      case 'entries': {
        const [key] = message.args;
        const childEntries = getChildEntries(`${key}.`);
        return [...childEntries.entries()].map(entry =>
          entry[1] != null ? entry : [entry[0]],
        );
      }
      case 'set':
      case 'setWithoutNotify': {
        trace('toStorage set', message);
        /** @type {import('../src/lib-chainStorage.js').StorageEntry[]} */
        const newEntries = message.args;
        for (const [key, value] of newEntries) {
          if (value != null) {
            data.set(key, value);
          } else {
            data.delete(key);
          }
        }
        break;
      }
      case 'append': {
        trace('toStorage append', message);
        /** @type {import('../src/lib-chainStorage.js').StorageEntry[]} */
        const newEntries = message.args;
        for (const [key, value] of newEntries) {
          value != null || Fail`attempt to append with no value`;
          // In the absence of block boundaries, everything goes in a single StreamCell.
          const oldVal = data.get(key);
          let streamCell;
          if (oldVal != null) {
            try {
              streamCell = JSON.parse(oldVal);
              assert(isStreamCell(streamCell));
            } catch (_err) {
              streamCell = undefined;
            }
          }
          if (streamCell === undefined) {
            streamCell = {
              blockHeight: '0',
              values: oldVal != null ? [oldVal] : [],
            };
          }
          streamCell.values.push(value);
          data.set(key, JSON.stringify(streamCell));
        }
        break;
      }
      case 'size':
        // Intentionally incorrect because it counts non-child descendants,
        // but nevertheless supports a "has children" test.
        return [...data.keys()].filter(k => k.startsWith(`${message.args[0]}.`))
          .length;
      default:
        throw Error(`unsupported method: ${message.method}`);
    }
  };
  const rootNode = makeChainStorageRoot(toStorage, rootPath, resolvedOptions);
  return {
    rootNode,
    // eslint-disable-next-line object-shorthand
    data: /** @type {Map<string, string>} */ (data),
    messages,
    toStorage,
  };
};
harden(makeFakeStorageKit);
/** @typedef {ReturnType< typeof makeFakeStorageKit>} FakeStorageKit */

export const makeMockChainStorageRoot = () => {
  const { rootNode, data } = makeFakeStorageKit('mockChainStorageRoot');
  return Far('mockChainStorage', {
    ...bindAllMethods(rootNode),
    /**
     * Defaults to deserializing slot references into plain Remotable
     * objects having the specified interface name (as from `Far(iface)`),
     * but can accept a different marshaller for producing Remotables
     * that e.g. embed the slot string in their iface name.
     *
     * @param {string} path
     * @param {import('./lib-chainStorage.js').Marshaller} marshaller
     * @returns {unknown}
     */
    getBody: (path, marshaller = defaultMarshaller) => {
      data.size || Fail`no data in storage`;
      /** @type {ReturnType<typeof import('@endo/marshal').makeMarshal>['fromCapData']} */
      const fromCapData = (...args) =>
        Reflect.apply(marshaller.fromCapData, marshaller, args);
      return unmarshalFromVstorage(data, path, fromCapData);
    },
    keys: () => [...data.keys()],
  });
};
/** @typedef {ReturnType<typeof makeMockChainStorageRoot>} MockChainStorageRoot */
