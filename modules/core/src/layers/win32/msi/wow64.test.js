/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A package's components on a 64-bit Windows, as the installer service, a
 * 64-bit process, puts them: a 32-bit component's HKLM\SOFTWARE keys under
 * Wow6432Node, a 64-bit one's (msidbComponentAttributes64bit) where they are
 * named; on a 32-bit Windows each where it is named.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HKEY_LOCAL_MACHINE } from '../advapi32/registry.js';
import { EXECUTE_SEQUENCE, MACHINE, machine, registryText, run } from './install.fixture.js';

/** Two components of one feature, each writing HKLM\SOFTWARE\Vendor\<its width>. */
const TABLES = /** @type {import('./install.fixture.js').Tables} */ ({
    Property: [['Property', 'Value'], [['ProductCode', '{1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D}'],
        ['ProductName', 'Both'], ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'],
        ['ProductLanguage', '1033'], ['ALLUSERS', '1']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'],
        [['TARGETDIR', null, 'SourceDir']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'TARGETDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition', 'KeyPath'], [
        ['Narrow', '{2B3C4D5E-6F7A-4B8C-9D0E-1F2A3B4C5D6E}', 'TARGETDIR', 4, null, 'narrow'],
        ['Wide', '{3C4D5E6F-7A8B-4C9D-8E1F-2A3B4C5D6E7F}', 'TARGETDIR', 4 | 0x100, null, 'wide']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Narrow'], ['Main', 'Wide']]],
    Registry: [['Registry', 'Root', 'Key', 'Name', 'Value', 'Component_'], [
        ['narrow', 2, 'SOFTWARE\\Vendor\\Narrow', 'Width', '32', 'Narrow'],
        ['wide', 2, 'SOFTWARE\\Vendor\\Wide', 'Width', '64', 'Wide']]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 0, null, null, null, null]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
});

/** @param {boolean} amd64 */
const installed = async amd64=>{
    const host = await machine();
    const { code } = await run(host, TABLES, '', {}, {}, { ...MACHINE, amd64 });
    assert.equal(code, 0);
    return (/** @type {string} */ path)=>registryText(host.hive, HKEY_LOCAL_MACHINE, path,
        'Width');
};

test('on a 64-bit Windows a 32-bit component\'s keys are under Wow6432Node, a 64-bit one\'s'
    + ' where they are named', async()=>{
    const width = await installed(true);
    assert.equal(width('SOFTWARE\\Wow6432Node\\Vendor\\Narrow'), '32');
    assert.equal(width('SOFTWARE\\Vendor\\Narrow'), null);
    assert.equal(width('SOFTWARE\\Vendor\\Wide'), '64');
    assert.equal(width('SOFTWARE\\Wow6432Node\\Vendor\\Wide'), null);
});

test('on a 32-bit Windows every component\'s keys are where they are named', async()=>{
    const width = await installed(false);
    assert.equal(width('SOFTWARE\\Vendor\\Narrow'), '32');
    assert.equal(width('SOFTWARE\\Vendor\\Wide'), '64');
});
