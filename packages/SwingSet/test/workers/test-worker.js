import { test } from '../../tools/prepare-test-env-ava.js';

import { loadBasedir, buildVatController } from '../../src/index.js';
import { kunser } from '../../src/lib/kmarshal.js';

function canBlock(managerType) {
  // nodeworker cannot block: the thread-to-thread port it uses provides a
  // strictly async API. The subprocess-node worker *should* be able to
  // block, but we didn't bother implementing the return pathway, so treat it
  // as non-blocking.
  return managerType === 'local';
}
const expected = [
  ['B good', 'C good', 'F good', 'three good', 'exit good', 'exitWF good'],
  'rp3 good',
];

async function makeController(managerType) {
  const config = await loadBasedir(new URL('./', import.meta.url).pathname);
  config.vats.target.creationOptions = {
    managerType,
    enableDisavow: true,
  };
  const canCallNow = canBlock(managerType);
  config.vats.target.parameters = { canCallNow };
  config.devices = {
    add: {
      sourceSpec: new URL('device-add.js', import.meta.url).pathname,
      creationOptions: {
        unendowed: true,
      },
    },
  };
  const c = await buildVatController(config, []);
  return c;
}

test('local vat manager', async t => {
  const c = await makeController('local');
  t.teardown(c.shutdown);

  await c.run();
  t.is(c.kpStatus(c.bootstrapResult), 'fulfilled');
  t.deepEqual(c.dump().log, ['testLog works']);
  t.deepEqual(kunser(c.kpResolution(c.bootstrapResult)), expected);
});

test('xsnap vat manager', async t => {
  const c = await makeController('xsnap');
  t.teardown(c.shutdown);

  await c.run();
  t.is(c.kpStatus(c.bootstrapResult), 'fulfilled');
  t.deepEqual(c.dump().log, ['testLog works']);
  t.deepEqual(kunser(c.kpResolution(c.bootstrapResult)), expected);
});

test('xs vat manager alias', async t => {
  const c = await makeController('xs-worker');
  t.teardown(c.shutdown);

  await c.run();
  t.is(c.kpStatus(c.bootstrapResult), 'fulfilled');
  t.deepEqual(c.dump().log, ['testLog works']);
  t.deepEqual(kunser(c.kpResolution(c.bootstrapResult)), expected);
});
