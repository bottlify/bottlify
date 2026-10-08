/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A nested installation custom action: which package it names -- a storage
 * of this one (type 7), a file from this one's source (23), an installed
 * product (39) -- the properties it hands over, and how its answer counts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machine, run } from './install.fixture.js';

/**
 * A package whose execute sequence is one nested installation per row given.
 *
 * @param {[string, number, string, string | null][]} actions
 * @returns {import('./install.fixture.js').Tables}
 */
const nesting = actions=>({
    Property: [['Property', 'Value'], [['ProductCode', '{6D7A2B10-1111-4222-8333-944455556666}'],
        ['CHILDDIR', 'C:\\Child']]],
    CustomAction: [['Action', 'Type', 'Source', 'Target'], actions],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'],
        actions.map(([action], index)=>[action, null, 100 + index])],
});

test('each kind of nested installation names its package and hands over its properties',
    async()=>{
        const host = await machine();
        /** @type {[string, string, string][]} */
        const asked = [];
        /** @type {(kind: string, source: string, commandLine: string) => Promise<number>} */
        const installNested = async(kind, source, commandLine)=>{
            asked.push([kind, source, commandLine]);
            return kind === 'path' ? 3010 : 0;
        };
        const { code } = await run(host, nesting([
            ['Stored', 7, 'child', 'INSTALLDIR=[CHILDDIR]'],
            ['Beside', 23, 'redist\\runtime.msi', 'REBOOT=ReallySuppress'],
            ['Again', 39, '{7E8B3C21-1111-4222-8333-944455556666}', 'REMOVE=ALL'],
        ]), '', { installNested });
        assert.equal(code, 0, 'a reboot asked for by the nested one is not a failure');
        assert.deepEqual(asked, [
            ['storage', 'child', 'INSTALLDIR=C:\\Child'],
            ['path', 'redist\\runtime.msi', 'REBOOT=ReallySuppress'],
            ['product', '{7E8B3C21-1111-4222-8333-944455556666}', 'REMOVE=ALL'],
        ]);
    });

test('a nested installation that fails fails this one, unless its answer is ignored',
    async()=>{
        const host = await machine();
        const failing = { installNested: async()=>1603 };
        assert.equal((await run(host, nesting([['Child', 23, 'a.msi', null]]), '', failing))
            .code, 1603);
        assert.equal((await run(host, nesting([['Child', 23 | 0x40, 'a.msi', null]]), '',
            failing)).code, 0, 'msidbCustomActionTypeContinue');
    });
