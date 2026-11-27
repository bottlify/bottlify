/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a volume is copied with object spread (`{ ...volume }`).
 *
 * The win32 volume is built over the filesystem's with Object.create, so its
 * file calls - mkdir, rename, remove, list - are inherited, not its own. A
 * spread copies own properties alone: shell32 was handed such a copy, found
 * no mkdir on it, and every SHCreateDirectoryEx and SHFileOperation failed as
 * access denied in a real run while its unit tests, over plain objects,
 * passed. A volume with something added is `Object.assign(Object.create(v), {...})`.
 *
 *     node tools/checks/check-volume-spread.mjs [src]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'modules', 'core', 'src');
const SPREAD = /\{\s*\.\.\.(?:host\.)?(?:volume|files)\s*[,}]/;

/** @param {string} directory @returns {string[]} */
const sources = directory=>readdirSync(directory).flatMap(name=>{
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path)
        : name.endsWith('.js') && !name.endsWith('.test.js') && !name.endsWith('.itest.js')
            ? [path] : [];
});

const offenders = sources(SRC).filter(path=>SPREAD.test(readFileSync(path, 'utf8')));
if (offenders.length > 0)
{
    console.error('a volume copied by spread, which drops its inherited file calls:');
    offenders.forEach(path=>console.error(`  ${relative(ROOT, path)}`));
    process.exit(1);
}
console.log('check-volume-spread: no volume is copied by spread');
