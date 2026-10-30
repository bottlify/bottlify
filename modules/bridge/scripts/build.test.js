/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { build } from './build.mjs';

/** @param {string} dir @returns {string[]} */
const filesIn = dir=>readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath, entry.name));

test('each build is whole: every import resolves inside it, and the page may load each', async()=>{
    const out = mkdtempSync(join(tmpdir(), 'bridge-build-'));
    try
    {
        const built = await build(out);
        assert.deepEqual(Object.keys(built).sort(), ['dev', 'public']);
        for (const dir of Object.values(built))
        {
            const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
            const loadable = manifest.web_accessible_resources[0].resources.map(
                (/** @type {string} */ glob)=>new RegExp(
                    `^${glob.replace('.', '\\.').replace('*', '[^/]+')}$`));
            for (const file of filesIn(dir).filter(name=>name.endsWith('.js')))
            {
                const text = readFileSync(file, 'utf8');
                // Static imports, and the content script's import(url('...')).
                for (const [, path] of text.matchAll(/(?:from |url\()'([^']+\.js)'/g))
                {
                    const target = path.startsWith('.')
                        ? join(dirname(file), path) : join(dir, path);
                    assert.ok(existsSync(target), `${relative(dir, file)} imports ${path}`);
                    const name = relative(dir, target).replace(/\\/g, '/');
                    assert.ok(loadable.some((/** @type {RegExp} */ re)=>re.test(name)),
                        `${name} is not web-accessible`);
                }
            }
            assert.ok(existsSync(join(dir, manifest.background.service_worker)));
            assert.ok(existsSync(join(dir, manifest.content_scripts[0].js[0])));
        }
    }
    finally
    {
        rmSync(out, { recursive: true, force: true });
    }
});
