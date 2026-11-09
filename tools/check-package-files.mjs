/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every source file @bottlify/core's package ships imports only files it ships.
 *
 * The package lists its source files one by one (`files` in its package.json),
 * and a file a listed one starts importing is not shipped unless someone adds
 * it: installed from the tarball, the package's entries then fail to import.
 * Twice a merge brought such an import (user32/display.js, programs/reg.js) and
 * only the packing integration test, minutes in, said so. This walks the
 * static imports of every listed file and fails on one that is not listed.
 *
 *   node tools/check-package-files.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'core');
const manifest = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
const listed = new Set(manifest.files.filter((/** @type {string} */ file)=>file.endsWith('.js')));
/** @type {Map<string, string>} */
const missing = new Map();
const seen = new Set();
/** A static import or re-export of a relative path, at the start of a line. */
const IMPORT = /^\s*(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]/gm;

/** @param {string} file */
const walk = file=>{
    if (seen.has(file) || !existsSync(join(CORE, file)))
    {
        return;
    }
    seen.add(file);
    for (const [, target] of readFileSync(join(CORE, file), 'utf8').matchAll(IMPORT))
    {
        const resolved = posix.normalize(posix.join(posix.dirname(file), target));
        if (!listed.has(resolved) && !missing.has(resolved))
        {
            missing.set(resolved, file);
        }
        walk(resolved);
    }
};
for (const file of listed)
{
    walk(file);
}
if (missing.size > 0)
{
    for (const [file, by] of missing)
    {
        console.error(`check-package-files: ${file} is imported by ${by} and not in`
            + ' modules/core/package.json "files"');
    }
    process.exit(1);
}
console.log(`check-package-files: the ${listed.size} files the package lists`
    + ' import only each other');
