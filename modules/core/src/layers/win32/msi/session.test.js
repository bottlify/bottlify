/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDatabase } from './database.js';
import { openView } from './query.js';
import { createSession } from './session.js';
import { windowsVersion } from '../kernel32/versions.js';

/** @type {import('./session.js').Machine} */
const MACHINE = {
    windows: windowsVersion(), computerName: 'PC', userName: 'User', userSid: 'S-1-5-21-1',
    language: 0x409, screenWidth: 1024, screenHeight: 768, colorBits: 32,
    memoryMegabytes: 512, tempFolder: 'C:\\WINDOWS\\TEMP\\', environment: ()=>null,
    now: ()=>new Date(2026, 0, 1),
};

/**
 * The rows a query of the session's active database answers.
 *
 * @param {ReturnType<typeof createSession>} session @param {string} text
 */
const rowsOf = (session, text)=>{
    const opened = openView(session.active, text);
    assert.ok('view' in opened, `${text} opens`);
    opened.view.execute(null);
    /** @type {any[][]} */
    const rows = [];
    for (let fetched = opened.view.fetch(); fetched; fetched = opened.view.fetch())
    {
        rows.push(fetched.fields.slice(1));
    }
    return rows;
};

test('the active database holds the session\'s properties as _Property, as they stand when read',
    ()=>{
        // A script that chose the folder in a session of its own reads them
        // there to hand them to the installation it starts; with no such
        // table the query failed and the choice stayed behind.
        const session = createSession({ db: createEmptyDatabase(), packagePath: 'C:\\a.msi',
            machine: MACHINE });
        session.setProperty('INSTALLDIR', 'C:\\Program Files\\Product\\');
        session.setProperty('EMPTY', '');
        const rows = rowsOf(session, 'SELECT * FROM _Property');
        assert.ok(rows.some(([name, value])=>name === 'INSTALLDIR'
            && value === 'C:\\Program Files\\Product\\'));
        assert.ok(!rows.some(([name])=>name === 'EMPTY'), 'a property with no value has no row');
        assert.ok(rows.some(([name])=>name === 'ComputerName'), 'the machine\'s too');

        session.setProperty('INSTALLDIR', 'D:\\Elsewhere\\');
        assert.deepEqual(rowsOf(session, 'SELECT `Value` FROM `_Property` WHERE `Property` = '
            + '\'INSTALLDIR\''), [['D:\\Elsewhere\\']], 'read again, it is read anew');
        assert.equal(session.db.table('_Property'), null,
            'the package\'s own database is unchanged');
    });

test('ALLUSERS 2 becomes 1 for the administrator, nothing for a per-user install on Windows 7',
    ()=>{
        // The VC++ 2005 runtime's merge module refuses to install unless
        // ALLUSERS reads 1; its package asks for 2, which the installer turns
        // into what it decided.
        /** @param {string} commandLine @param {any} [windows] */
        const allUsers = (commandLine, windows)=>createSession({ db: createEmptyDatabase(),
            packagePath: 'C:\\a.msi', machine: { ...MACHINE, ...windows ? { windows } : {} },
            commandLine }).getProperty('ALLUSERS');
        assert.equal(allUsers('ALLUSERS=2'), '1');
        assert.equal(allUsers('ALLUSERS=2 MSIINSTALLPERUSER=1', windowsVersion('win7')), '');
        assert.equal(allUsers('ALLUSERS=2 MSIINSTALLPERUSER=1', windowsVersion('winxp')), '1',
            'before Windows Installer 5 there is no per-user choice');
        assert.equal(allUsers('ALLUSERS=1'), '1');
        assert.equal(allUsers(''), '', 'unset stays unset');
    });

test('a 64-bit Windows names both widths\' folders: SystemFolder is SysWOW64, System64Folder the'
    + ' system folder, and VersionNT64 and Msix64 are set', ()=>{
    /** @param {boolean} amd64 */
    const session = amd64=>createSession({ db: createEmptyDatabase(), packagePath: 'C:\\a.msi',
        machine: { ...MACHINE, windows: windowsVersion('win7'), amd64 } });
    const wide = session(true);
    const windows = wide.getProperty('WindowsFolder');
    assert.equal(wide.getProperty('SystemFolder'), `${windows}SysWOW64\\`);
    assert.equal(wide.getProperty('System64Folder'), `${windows}system32\\`);
    assert.equal(wide.getProperty('VersionNT64'), '601');
    assert.equal(wide.getProperty('Msix64'), '6');
    assert.equal(wide.getProperty('Intel'), '6', 'Intel is set on either');
    assert.equal(wide.getProperty('ProgramFilesFolder'), 'C:\\Program Files (x86)\\');
    assert.equal(wide.getProperty('ProgramFiles64Folder'), 'C:\\Program Files\\');
    assert.equal(wide.getProperty('CommonFilesFolder'), 'C:\\Program Files (x86)\\Common Files\\');
    const narrow = session(false);
    assert.equal(narrow.getProperty('SystemFolder'), `${windows}system32\\`);
    for (const name of ['System64Folder', 'VersionNT64', 'Msix64', 'ProgramFiles64Folder',
        'CommonFiles64Folder'])
    {
        assert.equal(narrow.getProperty(name), '', `${name}: none on a 32-bit Windows`);
    }
});
