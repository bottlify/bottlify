/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isNeImage, launcherPlan } from './is5stub.js';
import { prefixOptions } from './prefix.js';

/** An MZ image whose new header, at 0x40, starts with `signature`. @param {string} signature */
function image(signature){
    const bytes = new Uint8Array(0x80);
    bytes.set([0x4d, 0x5a]);
    new DataView(bytes.buffer).setUint32(0x3c, 0x40, true);
    bytes.set(Buffer.from(signature, 'latin1'), 0x40);
    return bytes;
}

// "AIAIAIAIAIAIA", imploded.
const AIAI = Uint8Array.from([0x00, 0x04, 0x82, 0x24, 0x25, 0x8f, 0x80, 0x7f]);

/** An engine archive holding `INSTALL.EXE` and one library, both as AIAI. */
function engineArchive(){
    const members = [['INSTALL.EXE', '_INS5176._MP'], ['zdata.dll', 'ZDataI51.dll']];
    const table = 0x52 + members.reduce((sum, [a, b])=>sum + 24 + a.length + b.length, 0);
    const bytes = new Uint8Array(table + AIAI.length * members.length);
    const view = new DataView(bytes.buffer);
    bytes.set([0x2a, 0xab, 0x79, 0xd8, 0, 1, 0, 0]);
    view.setUint32(0x4e, members.length, true);
    let at = 0x52;
    members.forEach(([name, stored], n)=>{
        view.setUint32(at, table + n * AIAI.length, true);
        view.setUint32(at + 4, AIAI.length, true);
        view.setUint32(at + 8, 13, true);
        at += 20;
        for (const text of [name, stored])
        {
            view.setUint16(at, text.length, true);
            bytes.set(Buffer.from(text, 'latin1'), at + 2);
            at += 2 + text.length;
        }
        bytes.set(AIAI, table + n * AIAI.length);
    });
    return bytes;
}

const LID = Buffer.from('[Languages]\r\nkey0=0007\r\nDefault=0007\r\ncount=1\r\n', 'latin1');

test('isNeImage tells a 16-bit image from a PE one', ()=>{
    assert.equal(isNeImage(image('NE')), true);
    assert.equal(isNeImage(image('PE\0\0')), false);
    assert.equal(isNeImage(new Uint8Array(4)), false);
});

test('the launcher plan unpacks the engine, writes its command line and environment', ()=>{
    const plan = launcherPlan(image('NE'), 'D:\\', [
        { name: '_INST32I.EX_', bytes: engineArchive() },
        { name: 'setup.lid', bytes: LID },
    ], { TEMP: 'C:\\WINDOWS\\TEMP', windir: 'C:\\WINDOWS' });
    assert.ok(plan);
    assert.equal(plan.imagePath, 'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS5176._MP');
    assert.equal(Buffer.from(plan.executable).toString('latin1'), 'AIAIAIAIAIAIA');
    const files = Object.fromEntries(plan.files.map(file=>[file.path,
        Buffer.from(file.bytes).toString('latin1')]));
    assert.deepEqual(Object.keys(files), [
        'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS5176._MP',
        'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\ZDataI51.dll',
        'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS0432.INI',
        'C:\\WINDOWS\\_isenv31.ini',
    ]);
    assert.equal(files['C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS0432.INI'],
        '  -fD:\\SETUP.INS  -z1 -cx -xC:\\WINDOWS\\TEMP\\_ISTMP1.DIR  -x1"D:\\" -q10007');
    assert.equal(files['C:\\WINDOWS\\_isenv31.ini'],
        'TEMP=C:\\WINDOWS\\TEMP\0windir=C:\\WINDOWS\0\0');
});

test('the language falls back to English without setup.lid', ()=>{
    const plan = launcherPlan(image('NE'), 'C:\\Install',
        [{ name: '_inst32i.ex_', bytes: engineArchive() }]);
    const ini = plan?.files.find(file=>file.path.endsWith('_INS0432.INI'));
    assert.match(Buffer.from(ini?.bytes ?? []).toString('latin1'), /-fC:\\Install\\SETUP\.INS .* -q10009$/);
});

test('no plan for a 32-bit setup or one without the engine archive', ()=>{
    const archive = [{ name: '_inst32i.ex_', bytes: engineArchive() }];
    assert.equal(launcherPlan(image('PE\0\0'), 'D:\\', archive), null);
    assert.equal(launcherPlan(image('NE'), 'D:\\', []), null);
});

test('prefixOptions starts the engine in place of a 16-bit launcher', async()=>{
    const options = prefixOptions({ name: 'SETUP.EXE', bytes: image('NE'),
        files: [{ name: '_INST32I.EX_', bytes: engineArchive() }] });
    assert.equal(options.imagePath, 'C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS5176._MP');
    const paths = (await options.storage.load()).map(file=>file.path);
    assert.ok(paths.includes('C:\\Install\\SETUP.EXE'));
    assert.ok(paths.includes('C:\\WINDOWS\\TEMP\\_ISTMP1.DIR\\_INS0432.INI'));
    assert.deepEqual(options.seeded, paths);
});
