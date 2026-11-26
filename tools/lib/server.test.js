/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from './server.mjs';

test('a source that imports a library core depends on by its name is served with a path the '
    + 'server answers, and that path serves the library', async()=>{
    const root = mkdtempSync(join(tmpdir(), 'server-'));
    writeFileSync(join(root, 'a.js'), 'import { openRing } from \'@bottlify/cellar\';\n'
        + 'export const m = await import("@bottlify/cellar");\nexport { openRing };\n');
    const server = await serveStatic({ sandboxDir: root, srcDir: root });
    try
    {
        const base = `http://127.0.0.1:${server.port}`;
        const text = await (await fetch(`${base}/src/a.js`)).text();
        assert.doesNotMatch(text, /['"]@bottlify\/cellar['"]/, 'no bare name left');
        const paths = [...text.matchAll(/['"](\/[^'"]+)['"]/g)].map(match=>match[1]);
        assert.equal(paths.length, 2, 'both imports point at a path');
        const library = await fetch(`${base}${paths[0]}`);
        assert.equal(library.status, 200);
        assert.match(library.headers.get('content-type') ?? '', /javascript/);
        assert.match(await library.text(), /export/, 'the library\'s entry');
        // A file the library imports relatively is served from beside it.
        const ring = await fetch(new URL('./ring.js', `${base}${paths[0]}`));
        assert.equal(ring.status, 200);
    }
    finally
    {
        await server.close();
        rmSync(root, { recursive: true, force: true });
    }
});
