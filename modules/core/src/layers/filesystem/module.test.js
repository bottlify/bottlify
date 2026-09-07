/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from './module.js';
import { createMemoryStore } from './internal/memory-store.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

/** An installation on C:, plus an empty D: for the per-drive rules. */
function volume(){
    return filesystemModule.create({
        drives: {
            C: {
                source: createMemoryStore({
                    'Game\\Setup.EXE': 'binary',
                    'Game\\Data\\Config.WTF': 'source',
                    'Readme.TXT': 'read me',
                }),
                writable: createMemoryStore(),
            },
            D: {},
        },
    });
}

test('a module with no configuration still comes up as a volume', async()=>{
    const fs = await filesystemModule.create(undefined);

    assert.deepEqual(fs.drives(), ['C']);
    assert.equal(fs.currentDirectory(), 'C:\\');
    fs.createDirectory('C:\\Save');
    const handle = fs.open('C:\\Save\\slot.dat',
        { write: true, disposition: fs.Disposition.CREATE_NEW });
    fs.write(handle, bytes('slot'));
    fs.close(handle);

    assert.equal(fs.stat('c:/save/SLOT.DAT')?.size, 4);
    await filesystemModule.dispose();
});

test('a file written in one case is found in another and listed in its own', async()=>{
    const fs = await volume();

    const handle = fs.open('C:\\Game\\Config.WTF',
        { write: true, disposition: fs.Disposition.CREATE_NEW });
    fs.write(handle, bytes('written'));
    fs.close(handle);

    const reopened = fs.open('c:\\game\\config.wtf');
    assert.equal(text(fs.read(reopened, 32)), 'written');
    fs.close(reopened);

    assert.deepEqual(fs.list('C:\\GAME').map((/** @type {any} */ e)=>e.name).sort(),
        ['Config.WTF', 'Data', 'Setup.EXE']);
    await filesystemModule.dispose();
});

test('a relative path follows the current directory of its drive', async()=>{
    const fs = await volume();

    fs.setCurrentDirectory('C:\\Game\\Data');
    assert.equal(fs.currentDirectory(), 'C:\\Game\\Data');
    assert.equal(fs.stat('Config.WTF')?.size, 6);
    assert.equal(fs.stat('..\\Setup.EXE')?.size, 6);
    assert.equal(fs.stat('..\\..\\..\\..\\Readme.TXT')?.size, 7,
        'and cannot be walked off the top of the drive');

    // Changing to D: leaves C:'s directory where it was.
    fs.setCurrentDirectory('D:\\');
    assert.equal(fs.currentDirectory(), 'D:\\');
    assert.equal(fs.stat('C:Config.WTF')?.size, 6);

    assert.throws(()=>fs.setCurrentDirectory('C:\\Nowhere'), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>fs.setCurrentDirectory('C:\\Readme.TXT'), { code: 'NOT_A_DIRECTORY' });
    await filesystemModule.dispose();
});

test('drives do not see each other', async()=>{
    const fs = await volume();

    assert.deepEqual(fs.drives(), ['C', 'D']);
    assert.equal(fs.stat('D:\\Readme.TXT'), null);
    assert.throws(()=>fs.stat('Z:\\x'), { code: 'NO_SUCH_DRIVE' });
    await filesystemModule.dispose();
});

test('a search path enumerates with its own pattern', async()=>{
    const fs = await volume();

    assert.deepEqual(fs.list('C:\\Game\\*.exe').map((/** @type {any} */ e)=>e.name),
        ['Setup.EXE']);
    assert.deepEqual(fs.list('C:\\Game\\*.').map((/** @type {any} */ e)=>e.name), ['Data']);
    assert.deepEqual(fs.list('C:\\', '*.txt').map((/** @type {any} */ e)=>e.path),
        ['C:\\Readme.TXT']);
    await filesystemModule.dispose();
});

test('a wildcard is refused everywhere except enumeration', async()=>{
    const fs = await volume();

    assert.equal(fs.resolve('C:\\Game\\*.exe').wildcard, true);
    assert.throws(()=>fs.open('C:\\Game\\*.exe'), { code: 'INVALID_PATH' });
    assert.throws(()=>fs.stat('C:\\Game\\*.exe'), { code: 'INVALID_PATH' });
    assert.throws(()=>fs.deleteFile('C:\\Game\\*'), { code: 'INVALID_PATH' });
    await filesystemModule.dispose();
});

test('a device is reported rather than opened as a file', async()=>{
    const fs = await volume();

    assert.equal(fs.resolve('NUL').device, 'NUL');
    assert.equal(fs.resolve('C:\\Game\\lpt1').device, 'LPT1');
    // The caller routes on resolve; anything that would touch the volume says
    // plainly that there is no file here to touch.
    assert.throws(()=>fs.open('NUL', { write: true }),
        (/** @type {any} */ error)=>error.code === 'IS_DEVICE' && error.device === 'NUL');
    assert.equal(fs.stat('C:\\Game\\Setup.EXE')?.size, 6, 'and no file called NUL was created');
    await filesystemModule.dispose();
});

test('the source survives everything the program does to it', async()=>{
    const source = createMemoryStore({ 'Game\\Setup.EXE': 'binary' });
    const fs = await filesystemModule.create({ drives: { C: { source } } });

    const handle = fs.open('C:\\Game\\Setup.EXE', { write: true });
    fs.seek(handle, 6, fs.SeekFrom.BEGIN);
    fs.write(handle, bytes('!'));
    fs.close(handle);
    fs.deleteFile('C:\\Game\\Setup.EXE');

    assert.equal(fs.stat('C:\\Game\\Setup.EXE'), null);
    assert.deepEqual(fs.list('C:\\Game'), [], 'the deletion outlives the source');
    assert.equal(source.stat('Game\\Setup.EXE')?.size, 6, 'and the source is untouched');
    await filesystemModule.dispose();
});

test('diagnostics answer before and after the volume exists', async()=>{
    await filesystemModule.dispose();
    assert.deepEqual(filesystemModule.diagnostics(),
        { name: 'filesystem', version: '0.1.0', status: 'created', metrics: {} });

    const fs = await volume();
    fs.setCurrentDirectory('C:\\Game');
    const handle = fs.open('C:\\Readme.TXT');

    const report = /** @type {any} */ (filesystemModule.diagnostics());
    assert.equal(report.status, 'ready');
    assert.equal(report.metrics.current, 'C:\\Game');
    assert.equal(report.metrics.handles.open, 1);
    assert.equal(report.metrics.volumes['C:'].files, 3);
    assert.equal(report.metrics.volumes['D:'].layered, false);

    fs.close(handle);
    await filesystemModule.dispose();
});
