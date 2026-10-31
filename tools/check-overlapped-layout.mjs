/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when an OVERLAPPED field's offset is written down anywhere but
 * `layers/win32/common/overlapped.js`.
 *
 * Its Internal and InternalHigh are pointer-sized, so Offset, OffsetHigh and
 * hEvent move with the process's width. Five files each kept the 32-bit
 * offsets as constants of their own, and a 64-bit program's overlapped reads
 * all came from the start of the file -- its OVERLAPPED's Offset read where
 * InternalHigh's zero is. `overlappedLayout(pointerSize)` is the one place.
 *
 *     node tools/check-overlapped-layout.mjs [src]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'modules', 'core', 'src');
const OWNER = join('layers', 'win32', 'common', 'overlapped.js');
const DEFINED = /^\s*const OVERLAPPED_[A-Z_]+\s*=/m;

/** @param {string} directory @returns {string[]} */
const sources = directory=>readdirSync(directory).flatMap(name=>{
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path)
        : name.endsWith('.js') && !name.endsWith('.test.js') && !name.endsWith('.itest.js')
            ? [path] : [];
});

const offenders = sources(SRC).filter(path=>relative(SRC, path) !== OWNER
    && DEFINED.test(readFileSync(path, 'utf8')));
if (offenders.length > 0)
{
    console.error(`OVERLAPPED offsets kept outside ${OWNER} (use overlappedLayout):`);
    offenders.forEach(path=>console.error(`  ${relative(ROOT, path)}`));
    process.exit(1);
}
console.log('check-overlapped-layout: every OVERLAPPED field is overlappedLayout\'s');
