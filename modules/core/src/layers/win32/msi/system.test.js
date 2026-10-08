/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Registration with the rest of the system: a font in the font list under
 * its own name, a service with the service manager, a qualified component
 * under its category; files moved; a reboot asked for at the end; and a
 * subsystem this machine lacks said once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HKEY_LOCAL_MACHINE } from '../advapi32/registry.js';
import { EXECUTE_SEQUENCE, machine, registryText, run, text } from './install.fixture.js';
import { descriptor, fontFullName, packGuid } from './system.js';
import { squashGuid } from './registration.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';
const CATEGORY = '{CCCCCCCC-1234-1234-1234-1234567890AB}';

/**
 * A TrueType file with nothing but a `name` table holding the full name,
 * once for Windows in UTF-16 and once for the Macintosh in its own page.
 *
 * @param {string} name
 */
function trueType(name){
    const utf16 = Uint8Array.from([...name].flatMap(char=>[0, char.charCodeAt(0)]));
    const mac = Uint8Array.from([...`${name} Mac`].map(char=>char.charCodeAt(0)));
    const tableAt = 12 + 16;
    const recordsLength = 6 + 2 * 12;
    const table = new Uint8Array(recordsLength + utf16.length + mac.length);
    const view = new DataView(table.buffer);
    view.setUint16(2, 2);
    view.setUint16(4, recordsLength);
    /** @type {[number, number, number, number, number][]} */
    const records = [[1, 0, 0, mac.length, utf16.length], [3, 1, 0x409, utf16.length, 0]];
    records.forEach(([platform, encoding, language, length, offset], index)=>{
        const at = 6 + index * 12;
        view.setUint16(at, platform);
        view.setUint16(at + 2, encoding);
        view.setUint16(at + 4, language);
        view.setUint16(at + 6, 4);
        view.setUint16(at + 8, length);
        view.setUint16(at + 10, offset);
    });
    table.set(utf16, recordsLength);
    table.set(mac, recordsLength + utf16.length);
    const file = new Uint8Array(tableAt + table.length);
    const header = new DataView(file.buffer);
    header.setUint32(0, 0x00010000);
    header.setUint16(4, 1);
    file.set([...'name'].map(char=>char.charCodeAt(0)), 12);
    header.setUint32(12 + 8, tableAt);
    header.setUint32(12 + 12, table.length);
    file.set(table, tableAt);
    return file;
}

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Tools'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Tools'], ['FontsFolder', 'TARGETDIR', '.']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [
        ['Service', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null, 'svc'],
        ['Font', '{22222222-2222-2222-2222-222222222222}', 'FontsFolder', 0, null, 'font'],
    ]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Service'], ['Main', 'Font']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [
        ['svc', 'Service', 'toolsvc.exe', 4, null, null, 0, 1],
        ['font', 'Font', 'tools.ttf', 0, null, null, 0, 2],
    ]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 2, null, null, null, null]]],
    Font: [['File_', 'FontTitle'], [['font', null]]],
    ServiceInstall: [['ServiceInstall', 'Name', 'DisplayName', 'ServiceType', 'StartType',
        'ErrorControl', 'LoadOrderGroup', 'Dependencies', 'StartName', 'Password', 'Arguments',
        'Component_', 'Description'], [
        ['svc', 'ToolSvc', 'Tool Service', 0x10, 2, 1, null, 'RpcSs[~]', null, null, '-run',
            'Service', 'Runs the tools'],
    ]],
    ServiceControl: [['ServiceControl', 'Name', 'Event', 'Arguments', 'Wait', 'Component_'], [
        ['svc', 'ToolSvc', 0x1 | 0x20 | 0x80, null, 1, 'Service'],
    ]],
    PublishComponent: [['ComponentId', 'Qualifier', 'Component_', 'AppData', 'Feature_'], [
        [CATEGORY, '1033', 'Service', 'extra', 'Main'],
    ]],
    MoveFile: [['FileKey', 'Component_', 'SourceName', 'DestName', 'SourceFolder', 'DestFolder',
        'Options'], [['old', 'Service', '*.cfg', null, 'OLDDIR', 'INSTALLDIR', 1]]],
    ODBCDataSource: [['DataSource', 'Component_', 'Description', 'DriverDescription',
        'Registration'], [['dsn', 'Service', 'Tools', 'SQL Server', 0]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'],
        [...EXECUTE_SEQUENCE, ['ScheduleReboot', null, 6500]]],
};

test('a font, a service, a published component, moved files, a reboot and an absent subsystem',
    async()=>{
        const host = await machine(['C:\\src', 'C:\\src\\Tools', 'C:\\old'], {
            'C:\\src\\Tools\\toolsvc.exe': 'MZ..', 'C:\\src\\tools.ttf': trueType('Tool Sans'),
            'C:\\old\\a.cfg': 'a', 'C:\\old\\b.cfg': 'b', 'C:\\old\\keep.txt': 'k',
        });
        const { code, session, divergences } = await run(host, TABLES,
            'FontsFolder=C:\\WINDOWS\\Fonts\\ OLDDIR=C:\\old\\');
        assert.equal(code, 0);
        const { hive, files } = host;
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE,
            'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'Tool Sans (TrueType)'),
        'tools.ttf', 'the font\'s own name, and the file by name in the fonts folder');
        const service = 'SYSTEM\\CurrentControlSet\\Services\\ToolSvc';
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, service, 'ImagePath'),
            '"C:\\Program Files\\Tools\\toolsvc.exe" -run');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, service, 'Start'), '2');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, service, 'DisplayName'),
            'Tool Service');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE, service, 'DependOnService'), 'RpcSs');
        assert.ok(divergences.some(entry=>entry.api === 'StartServices'), 'not started, and said');
        assert.ok(divergences.some(entry=>entry.api === 'InstallODBC'));
        const category = `Software\\Classes\\Installer\\Components\\${squashGuid(CATEGORY)}`;
        const value = hive.getValue(hive.open(hive.root(HKEY_LOCAL_MACHINE), category), '1033');
        assert.ok(value, 'under the category\'s squashed GUID');
        assert.equal(new TextDecoder('latin1').decode(value.data).split('\0')[0],
            `${descriptor(PRODUCT, 'Main', '{11111111-1111-1111-1111-111111111111}', false)}extra`);
        assert.equal(await text(files, 'C:\\Program Files\\Tools\\a.cfg'), 'a');
        assert.equal(await text(files, 'C:\\Program Files\\Tools\\b.cfg'), 'b');
        assert.equal(await text(files, 'C:\\old\\a.cfg'), null, 'moved, not copied');
        assert.equal(await text(files, 'C:\\old\\keep.txt'), 'k');
        assert.equal(session.mode.rebootAtEnd, true);

        await run(host, TABLES, 'REMOVE=ALL FontsFolder=C:\\WINDOWS\\Fonts\\ OLDDIR=C:\\old\\');
        assert.equal(hive.open(hive.root(HKEY_LOCAL_MACHINE), service), null,
            'deleted on removal, as its ServiceControl row asks');
        assert.equal(registryText(hive, HKEY_LOCAL_MACHINE,
            'Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'Tool Sans (TrueType)'),
        null);
        assert.equal(hive.open(hive.root(HKEY_LOCAL_MACHINE), category), null);
    });

test('a font\'s name is its Windows record, and a GUID packs into twenty characters', ()=>{
    assert.equal(fontFullName(trueType('Serif Bold')), 'Serif Bold');
    assert.equal(fontFullName(new Uint8Array(8)), null);
    assert.equal(packGuid('{00000000-0000-0000-0000-000000000000}'), '!'.repeat(20));
    const packed = packGuid(PRODUCT);
    assert.equal(packed?.length, 20);
    assert.equal(packGuid('not a guid'), null);
    assert.equal(descriptor(PRODUCT, 'Main', '{11111111-1111-1111-1111-111111111111}', true),
        `${packed}Main<`, 'a feature\'s only component is not named');
});
