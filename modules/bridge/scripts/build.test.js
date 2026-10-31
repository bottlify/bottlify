/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { build } from './build.mjs';

/** @param {string} a @param {string} b */
const posixJoin = (a, b)=>posix.normalize(posix.join(a, b));

/** @param {string} dir @returns {string[]} */
const filesIn = dir=>readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath, entry.name));

test('each build is whole: its imports resolve, and what the page loads it may', async()=>{
    const out = mkdtempSync(join(tmpdir(), 'bridge-build-'));
    try
    {
        const built = await build(out);
        assert.deepEqual(Object.keys(built).sort(), ['dev', 'public']);
        for (const dir of Object.values(built))
        {
            const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
            const loadable = manifest.web_accessible_resources[0].resources;
            /** @type {Set<string>} What the content script loads, and what that imports. */
            const theirs = new Set();
            for (const file of filesIn(dir).filter(name=>name.endsWith('.js')))
            {
                const text = readFileSync(file, 'utf8');
                const from = relative(dir, file).replace(/\\/g, '/');
                // Static imports, and the content script's import(getURL('...')).
                for (const [, call, path] of text.matchAll(/(from |getURL\()'([^']+\.js)'/g))
                {
                    const target = path.startsWith('.')
                        ? join(dirname(file), path) : join(dir, path);
                    assert.ok(existsSync(target), `${from} imports ${path}`);
                    if (call === 'getURL(')
                    {
                        theirs.add(relative(dir, target).replace(/\\/g, '/'));
                    }
                }
            }
            assert.ok(theirs.size > 0, 'the content script loads GameHub in the tab');
            for (const path of theirs)
            {
                assert.ok(loadable.includes(path), `${path} is not web-accessible`);
                for (const [, imported] of readFileSync(join(dir, path), 'utf8')
                    .matchAll(/from '(\.[^']+\.js)'/g))
                {
                    const name = posixJoin(dirname(path), imported);
                    assert.ok(loadable.includes(name),
                        `${name}, which ${path} imports, is not web-accessible`);
                }
            }
            assert.ok(!loadable.some((/** @type {string} */ path)=>
                /worker|vault|serve|auth|webapi/.test(path)),
            'nothing of the worker is the page\'s to load');
            assert.ok(existsSync(join(dir, manifest.background.service_worker)));
            assert.ok(existsSync(join(dir, manifest.content_scripts[0].js[0])));
            for (const ruleset of manifest.declarative_net_request.rule_resources)
            {
                assert.ok(existsSync(join(dir, ruleset.path)), ruleset.path);
            }
        }
    }
    finally
    {
        rmSync(out, { recursive: true, force: true });
    }
});
