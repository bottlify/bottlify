/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { findBoundaryIssues } from './lib/boundaries.mjs';

/**
 * Boundary checker for the core package.
 *
 * Rules that fail the build:
 *  - anything in src/system must not import src/layers;
 *  - a layer may import another layer only if it declared it in `requires`;
 *  - nothing imports vendor/: it holds binaries, which the root of src
 *    reaches by URL;
 *  - no file may import an engine package (`lib/boundaries.mjs`): the cpu layer
 *    loads one by URL when a launch selects it;
 *  - layers must not import core.js (the facade is a consumer, not a dependency);
 *  - no file may import from outside src/, whether by a relative path, a
 *    package name or a module-relative URL, and only the root of src may name
 *    a URL outside it; the platform's own `node:` modules are not outside it;
 *  - only the cpu layer and the files at the root of src/ may import a module
 *    by a computed argument -- the one form nothing here can check;
 *  - the import graph over src/ must be acyclic.
 *
 * `.js` and `.mjs` alike. Test files (`.test.*`, `.itest.*`) are skipped: they
 * are bundled separately in CI.
 */

const SRC = resolve(fileURLToPath(new URL('..', import.meta.url)), 'src');
const VENDOR = resolve(SRC, '..', 'vendor');

/**
 * Loads each layer's declared `requires` straight from its module definition.
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function layerRequires(){
    const layersDir = join(SRC, 'layers');
    const map = new Map();
    for (const name of readdirSync(layersDir).filter(n=>statSync(join(layersDir, n)).isDirectory()))
    {
        const mod = await import(pathToFileURL(join(layersDir, name, 'module.js')).href);
        const exportName = `${name}Module`;
        if (!(exportName in mod))
        {
            throw new Error(`Missing export "${exportName}" in layers/${name}/module.js`);
        }
        map.set(name, new Set(mod[exportName].requires));
    }
    return map;
}

const { files, issues } = findBoundaryIssues({ src: SRC, vendor: VENDOR,
    requires: await layerRequires() });

if (issues.length > 0)
{
    console.error(`Boundary violations:\n  - ${issues.join('\n  - ')}`);
    process.exit(1);
}
console.log(`Boundaries OK (${files.length} files checked).`);
