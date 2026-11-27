/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wow64View } from './wow64-files.js';

test('a 32-bit process\'s system folder is SysWOW64, Sysnative the 64-bit one, and the shared'
    + ' folders stay', ()=>{
    const view = wow64View('C:\\WINDOWS');
    /** @param {string} path */
    const seen = path=>{
        const [drive, ...components] = path.split('\\');
        const rewritten = view(drive.slice(0, 1), components);
        return rewritten === null ? null : `${drive}\\${rewritten.join('\\')}`;
    };
    assert.equal(seen('C:\\WINDOWS\\system32\\kernel32.dll'),
        'C:\\WINDOWS\\SysWOW64\\kernel32.dll');
    assert.equal(seen('C:\\windows\\SYSTEM32'), 'C:\\windows\\SysWOW64', 'the folder itself');
    assert.equal(seen('C:\\Windows\\System32\\wbem\\x.dll'), 'C:\\Windows\\SysWOW64\\wbem\\x.dll');
    assert.equal(seen('C:\\WINDOWS\\Sysnative\\msiexec.exe'), 'C:\\WINDOWS\\system32\\msiexec.exe');
    for (const shared of ['catroot\\a.cat', 'catroot2\\x', 'DriverStore\\FileRepository',
        'drivers\\etc\\hosts', 'LogFiles\\x.log', 'spool\\drivers'])
    {
        assert.equal(seen(`C:\\WINDOWS\\system32\\${shared}`), null, `${shared} is shared`);
    }
    assert.equal(seen('C:\\WINDOWS\\system32\\drivers\\x.sys'),
        'C:\\WINDOWS\\SysWOW64\\drivers\\x.sys',
        'drivers outside etc is not');
    assert.equal(seen('C:\\WINDOWS\\SysWOW64\\a.dll'), null);
    assert.equal(seen('C:\\WINDOWS\\notepad.exe'), null);
    assert.equal(seen('C:\\Program Files\\system32\\a.dll'), null);
    assert.equal(seen('D:\\WINDOWS\\system32\\a.dll'), null, 'another drive\'s');
});
