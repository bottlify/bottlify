/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shortcuts a package makes: real links the shell reads back -- a plain one
 * to a formatted path, an advertised one to its component's key file -- and
 * gone again when their component is removed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeShellLink } from '../common/shell-link.js';
import { EXECUTE_SEQUENCE, machine, run } from './install.fixture.js';
import { readFile } from './actions.js';

const PRODUCT = '{6D7A2B10-1111-4222-8333-944455556666}';

/** @type {import('./install.fixture.js').Tables} */
const TABLES = {
    Property: [['Property', 'Value'], [['ProductCode', PRODUCT], ['ProductName', 'Game'],
        ['ProductVersion', '1.0'], ['Manufacturer', 'Maker'], ['ProductLanguage', '1033']]],
    Directory: [['Directory', 'Directory_Parent', 'DefaultDir'], [
        ['TARGETDIR', null, 'SourceDir'], ['ProgramFilesFolder', 'TARGETDIR', '.'],
        ['INSTALLDIR', 'ProgramFilesFolder', 'Game'], ['ProgramMenuFolder', 'TARGETDIR', '.'],
        ['MENU', 'ProgramMenuFolder', 'Game']]],
    Feature: [['Feature', 'Feature_Parent', 'Title', 'Description', 'Display', 'Level',
        'Directory_', 'Attributes'], [['Main', null, 'Main', null, 1, 1, 'INSTALLDIR', 0]]],
    Component: [['Component', 'ComponentId', 'Directory_', 'Attributes', 'Condition',
        'KeyPath'], [['Core', '{11111111-1111-1111-1111-111111111111}', 'INSTALLDIR', 0, null,
        'exe']]],
    FeatureComponents: [['Feature_', 'Component_'], [['Main', 'Core']]],
    File: [['File', 'Component_', 'FileName', 'FileSize', 'Version', 'Language', 'Attributes',
        'Sequence'], [['exe', 'Core', 'game.exe', 4, null, null, 0, 1]]],
    Media: [['DiskId', 'LastSequence', 'DiskPrompt', 'Cabinet', 'VolumeLabel', 'Source'],
        [[1, 1, null, null, null, null]]],
    Shortcut: [['Shortcut', 'Directory_', 'Name', 'Component_', 'Target', 'Arguments',
        'Description', 'Hotkey', 'Icon_', 'IconIndex', 'ShowCmd', 'WkDir'], [
        ['play', 'MENU', 'PLAY~1|Play Game', 'Core', 'Main', '-window', 'Plays the game', null,
            'game.ico', 0, 3, 'INSTALLDIR'],
        ['readme', 'MENU', 'Readme', 'Core', '[INSTALLDIR]readme.txt', null, null, null, null,
            null, null, null],
    ]],
    // A menu folder is no component's, so the package names it for removal,
    // as packages must (ICE64).
    RemoveFile: [['FileKey', 'Component_', 'FileName', 'DirProperty', 'InstallMode'],
        [['menu', 'Core', null, 'MENU', 2]]],
    InstallExecuteSequence: [['Action', 'Condition', 'Sequence'],
        [...EXECUTE_SEQUENCE, ['CreateShortcuts', null, 4500], ['RemoveShortcuts', null, 3200]]],
};


test('shortcuts are links to the installed program, and go with their component', async()=>{
    const host = await machine(['C:\\src', 'C:\\src\\Game'],
        { 'C:\\src\\Game\\game.exe': 'MZ..' });
    const options = 'ProgramMenuFolder="C:\\WINDOWS\\Start Menu\\Programs\\"';
    assert.equal((await run(host, TABLES, options)).code, 0);
    const menu = 'C:\\WINDOWS\\Start Menu\\Programs\\Game\\';
    const play = decodeShellLink(/** @type {Uint8Array} */ (
        await readFile(host.files, `${menu}Play Game.lnk`)));
    assert.ok(play, 'a link the shell reads, under its long name');
    assert.equal(play?.target, 'C:\\Program Files\\Game\\game.exe',
        'advertised: the feature\'s component\'s key file');
    assert.equal(play?.arguments, '-window');
    assert.equal(play?.description, 'Plays the game');
    assert.equal(play?.workingDirectory, 'C:\\Program Files\\Game\\');
    assert.equal(play?.showCommand, 3);
    assert.equal(play?.iconLocation, `C:\\WINDOWS\\Installer\\${PRODUCT}\\game.ico`);
    const readme = decodeShellLink(/** @type {Uint8Array} */ (
        await readFile(host.files, `${menu}Readme.lnk`)));
    assert.equal(readme?.target, 'C:\\Program Files\\Game\\readme.txt', 'a formatted path');

    await run(host, TABLES, `REMOVE=ALL ${options}`);
    assert.equal(await readFile(host.files, `${menu}Play Game.lnk`), null);
    assert.equal(host.files.stat(menu.slice(0, -1))?.isDirectory ?? false, false,
        'and the menu folder its RemoveFile row names');
});
