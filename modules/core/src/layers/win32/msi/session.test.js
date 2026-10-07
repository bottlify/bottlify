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
