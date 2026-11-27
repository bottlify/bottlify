/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes package.json's version into src/version.js. `npm version` runs it
 * (the package's `version` script) after it raises the version, so the module
 * says the new one in the same change.
 *
 *   node scripts/stamp-version.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../src/version.js', import.meta.url);
const text = readFileSync(file, 'utf8');
const stamped = text.replace(/^export const VERSION = '[^']*';$/m,
    `export const VERSION = '${manifest.version}';`);
if (stamped === text && !text.includes(`'${manifest.version}'`))
{
    throw new Error('src/version.js has no `export const VERSION` line to stamp');
}
writeFileSync(file, stamped);
console.log(`src/version.js: ${manifest.version}`);
