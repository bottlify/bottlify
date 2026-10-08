/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A major upgrade: version 2 finds version 1 by their upgrade code, keeps the
 * features it had, and removes it -- leaving the machine with one product.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTALLSTATE } from './session.js';
import { EXECUTE_SEQUENCE, machine, run, text } from './install.fixture.js';
import { inRange, packedVersion } from './upgrade.js';

const UPGRADE_CODE = '{0AAAAAAA-1111-2222-3333-444444444444}';
const OLD = '{6D7A2B10-1111-4222-8333-944455556666}';
const NEW = '{7E8B3C21-1111-4222-8333-944455556666}';

/**
 * A product of the family: its code and version, both features installable
 * and the second off by default, and an Upgrade row on the newer one.
 *
 * @param {string} code @param {string} version @param {boolean} upgrades
 * @returns {import('./install.fixture.js').Tables}
 */
const product = (code, version, upgrades)=>({
    Property: [['Property', 'Value'], [['ProductCode', code], ['ProductName', 'Game'],
        ['ProductVersion', version], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033'],
        ['UpgradeCode', UPGRADE_CODE]]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [
        ['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0],
        ['Maps', null, 'Maps', null, 2, 100, 'INSTALLDIR', 0],
    ]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [
        // Each version's program is a component of its own; the maps are one
        // component both carry.
        ['Core', `{${version === '1.0' ? '1' : '3'}1111111-1111-1111-1111-111111111111}`,
            'INSTALLDIR', 0, null, 'exe'],
        ['MapFiles', '{22222222-2222-2222-2222-222222222222}', 'INSTALLDIR', 0, null, 'map'],
    ]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core'], ['Maps', 'MapFiles']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [
        ['exe', 'Core', `game${version}.exe`, 4, null, null, 0, 1],
        ['map', 'MapFiles', 'maps.dat', 4, null, null, 0, 2],
    ]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    Upgrade: [['UpgradeCode', 'VersionMin', 'VersionMax', 'Language', 'Attributes', 'Remove',
        'ActionProperty'], upgrades ? [
        [UPGRADE_CODE, '1.0', '2.0', null, 0x100 | 0x1, null, 'OLDERFOUND'],
        [UPGRADE_CODE, '2.0', null, null, 0x2, null, 'NEWERFOUND'],
    ] : []],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'], EXECUTE_SEQUENCE],
});

test('version 2 finds version 1, keeps its features, and removes it', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game'], {
        'C:\\src\\Game\\game1.0.exe': 'one', 'C:\\src\\Game\\game2.0.exe': 'two',
        'C:\\src\\Game\\maps.dat': 'maps',
    });
    const old = product(OLD, '1.0', false);
    assert.equal((await run(host, old, 'ADDLOCAL=ALL')).code, 0);
    assert.equal(host.registration.featureInstalled(OLD, 'Maps'), true, 'maps chosen by hand');

    /** @type {[string, string][]} */
    const removed = [];
    const { code, session } = await run(host, product(NEW, '2.0', true), '', {
        // The older product's own package, run again to remove it.
        removeProduct: async(/** @type {string} */ older, /** @type {string} */ features)=>{
            removed.push([older, features]);
            return (await run(host, old, `REMOVE=${features}`)).code;
        },
    });
    assert.equal(code, 0);
    assert.equal(session.getProperty('OLDERFOUND'), OLD);
    assert.equal(session.getProperty('NEWERFOUND'), '', 'nothing newer is installed');
    assert.equal(session.features.get('Maps')?.action, INSTALLSTATE.LOCAL,
        'the feature the older one had, though off by default');
    assert.deepEqual(removed, [[OLD, 'ALL']]);
    assert.equal(host.registration.productState(OLD), INSTALLSTATE.UNKNOWN);
    assert.equal(host.registration.productState(NEW), INSTALLSTATE.DEFAULT);
    assert.deepEqual(host.registration.relatedProducts(UPGRADE_CODE), [NEW]);
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\game1.0.exe'), null);
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\game2.0.exe'), 'two');
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\maps.dat'), 'maps',
        'a file both versions put down survives the older one\'s removal');
});

test('an Upgrade row\'s range: bounds inclusive only when it says so, languages in or out', ()=>{
    const v = (/** @type {string} */ version, language = 1033)=>
        ({ version: packedVersion(version), language });
    /** @type {(string | number | null)[]} */
    const row = ['{X}', '1.0', '2.0', null, 0, null, 'P'];
    assert.equal(inRange(row, v('1.0')), false, 'the minimum is exclusive by default');
    assert.equal(inRange(row, v('1.5.300')), true);
    assert.equal(inRange(row, v('2.0')), false);
    const inclusive = ['{X}', '1.0', '2.0', null, 0x100 | 0x200, null, 'P'];
    assert.equal(inRange(inclusive, v('1.0')), true);
    assert.equal(inRange(inclusive, v('2.0.0.99')), true, 'the fourth field is not counted');
    const languages = ['{X}', null, null, '1031,1036', 0, null, 'P'];
    assert.equal(inRange(languages, v('9.0', 1036)), true);
    assert.equal(inRange(languages, v('9.0', 1033)), false);
    const exclusive = ['{X}', null, null, '1031', 0x400, null, 'P'];
    assert.equal(inRange(exclusive, v('9.0', 1033)), true);
});

test('a component two products share stays until the last of them is removed', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game'], {
        'C:\\src\\Game\\game1.0.exe': 'one', 'C:\\src\\Game\\game2.0.exe': 'two',
        'C:\\src\\Game\\maps.dat': 'maps',
    });
    // Two products side by side -- no upgrade between them -- both with the
    // map component.
    const first = product(OLD, '1.0', false);
    const second = product(NEW, '2.0', false);
    await run(host, first, 'ADDLOCAL=ALL');
    await run(host, second, 'ADDLOCAL=ALL');
    assert.equal((await run(host, first, 'REMOVE=ALL')).code, 0);
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\game1.0.exe'), null);
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\maps.dat'), 'maps',
        'the other product still has it');
    assert.equal(host.registration.componentPath(NEW, '{22222222-2222-2222-2222-222222222222}'),
        'C:\\Program Files\\Game\\maps.dat');
    assert.equal(host.registration.componentPath(OLD, '{22222222-2222-2222-2222-222222222222}'),
        null, 'the removed one no longer does');
    assert.equal((await run(host, second, 'REMOVE=ALL')).code, 0);
    assert.equal(await text(host.files, 'C:\\Program Files\\Game\\maps.dat'), null);
});
