#! /usr/bin/env node
import '@endo/init';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import bundleSource from '@endo/bundle-source';
import { bundlePaths, hashPaths, entryPaths } from '../src/paths.js';

/** @param {Uint8Array} bytes */
const computeSha256 = bytes => {
  const hash = crypto.createHash('sha256');
  hash.update(bytes);
  return hash.digest().toString('hex');
};

const run = async () => {
  fs.mkdirSync(path.dirname(bundlePaths.supervisor), { recursive: true });
  const format = 'nestedEvaluate';
  const bundle = await bundleSource(entryPaths.supervisor, { format });
  const bundleString = JSON.stringify(bundle);
  const sha256 = computeSha256(bundleString);
  fs.writeFileSync(bundlePaths.supervisor, bundleString);
  fs.writeFileSync(hashPaths.supervisor, `${sha256}\n`);
  console.log(`wrote ${bundlePaths.supervisor}: ${bundleString.length} bytes`);
  console.log(`supervisor.bundle SHA256: ${sha256}`);
};

run().catch(err => console.log(err));
