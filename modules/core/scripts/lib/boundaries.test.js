/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { enginePackageIssue, findBoundaryIssues } from './boundaries.mjs';

test('an import of an engine package from the core is a boundary issue', ()=>{
    assert.equal(enginePackageIssue('@bottlify/cork'),
        'imports @bottlify/cork: core must not depend on an engine package');
    assert.equal(enginePackageIssue('@bottlify/cork/runtime'),
        'imports @bottlify/cork: core must not depend on an engine package');
});

test('anything else passes, including a name that merely starts alike', ()=>{
    assert.equal(enginePackageIssue('./internal/v86-host.js'), null);
    assert.equal(enginePackageIssue('node:fs'), null);
    assert.equal(enginePackageIssue('@bottlify/corkscrew'), null);
});

/**
 * A tree of two layers, a and cpu, where a requires nothing, with `extra`
 * written into it; the issues the checker finds there.
 *
 * @param {Record<string, string>} extra  path under src → contents
 */
function issuesWith(extra){
    const root = mkdtempSync(join(tmpdir(), 'boundaries-'));
    const src = join(root, 'src');
    const vendor = join(root, 'vendor');
    /** @type {Record<string, string>} */
    const files = {
        'layers/a/module.js': 'export const aModule = { requires: [] };\n',
        'layers/b/module.js': 'export const bModule = { requires: [] };\n',
        'layers/cpu/module.js': 'export const cpuModule = { requires: [] };\n',
        'system/contract.js': 'export {};\n',
        ...extra,
    };
    for (const [path, contents] of Object.entries(files))
    {
        mkdirSync(dirname(join(src, path)), { recursive: true });
        writeFileSync(join(src, path), contents);
    }
    mkdirSync(join(vendor, 'v86'), { recursive: true });
    const requires = new Map([['a', new Set()], ['b', new Set()], ['cpu', new Set()]]);
    try
    {
        return findBoundaryIssues({ src, vendor, requires }).issues;
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

test('a clean tree has no issues', ()=>{
    assert.deepEqual(issuesWith({}), []);
});

test('the rules that were always checked still catch what they name', ()=>{
    assert.equal(issuesWith({ 'layers/a/x.js': 'import { bModule } from \'../b/module.js\';' })
        .length, 1, 'an undeclared layer');
    assert.equal(issuesWith({ 'system/x.js': 'import { bModule } from \'../layers/b/module.js\';' })
        .length, 1, 'system importing a layer');
    assert.equal(issuesWith({ 'layers/a/x.js': 'import v from \'../../../vendor/v86/libv86.js\';' })
        .length, 1, 'vendor outside cpu');
});

test('every form of import is seen, not only a string after `from`', ()=>{
    // Each of these reached a layer, a package or vendor past the rules.
    const forms = {
        'a template import()': 'export const m = await import(`../b/module.js`);',
        'a computed import()': 'const p = \'../b/module.js\'; export const m = await import(p);',
        'a workspace package': 'import x from \'@bottlify/networking\'; export default x;',
        'an npm package': 'import x from \'left-pad\'; export default x;',
        'vendor by URL': 'export const u = new URL(\'../../../vendor/v86/libv86.js\', import.meta.url);',
    };
    for (const [form, code] of Object.entries(forms))
    {
        assert.equal(issuesWith({ 'layers/a/x.js': code }).length, 1, form);
    }
    assert.equal(issuesWith({ 'layers/a/x.mjs': 'import { bModule } from \'../b/module.js\';' })
        .length, 1, 'an .mjs file');
});

test('what the design allows stays allowed', ()=>{
    assert.deepEqual(issuesWith({
        // The cpu layer and the root load an engine by a URL chosen at launch.
        'layers/cpu/load.js': 'export const load = url=>import(url);',
        'app.js': 'export const load = url=>import(/* webpackIgnore: true */ url);',
        // The platform's own modules are not a dependency.
        'layers/a/fs.js': 'import { readFileSync } from \'node:fs\'; export { readFileSync };',
        // Prose is not an import.
        'layers/a/prose.js': '// a value from \'somewhere\', and an import() in passing\n'
            + 'export const text = `read from \'there\'`;\n',
        // A JSDoc type import is a dependency, of a layer this one may reach.
        'layers/a/types.js': '/** @type {import(\'./module.js\').aModule} */\nexport let t;\n',
    }), []);
});
