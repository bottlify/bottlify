/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from './module.js';
import { createMemoryStore } from './internal/memory-store.js';
import { buildIso } from './internal/iso/build.js';
import { openIso } from './internal/iso/iso9660.js';
import { createIsoSource } from './internal/iso/source.js';

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

test('a bundle mounted on a drive goes under what is already written there', async()=>{
    const fs = await filesystemModule.create(undefined);
    fs.createDirectory('C:\\WINDOWS');
    fs.mount('C', { source: createMemoryStore({ 'App\\Game.exe': 'binary' }) });

    assert.equal(fs.stat('C:\\WINDOWS')?.directory, true, 'the machine directory is still there');
    assert.equal(fs.stat('C:\\App\\Game.exe')?.size, 6, 'and the bundle beside it');
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

test('a read asks the source for what was asked of it, once, and nothing more', async()=>{
    // The cost of a read is whatever the source charges for the bytes: for a
    // bundle that is a block fetched and decompressed, and a program streaming
    // its art is waiting inside the call. So the layer above it must not add a
    // second read, a wider read, or a read of the whole file to slice from --
    // each of which is invisible against a fast source and multiplies a slow
    // one by the size of the file.
    const held = createMemoryStore({ 'Game\\Art.mpq': 'abcdefghijklmnopqrstuvwxyz' });
    /** @type {{ offset: number, length: number }[]} */
    const asked = [];
    const source = {
        list: ()=>held.list(),
        /** @param {string} path */
        stat: path=>held.stat(path),
        /** @param {string} path @param {number} offset @param {number} length */
        read(path, offset, length){
            asked.push({ offset, length });
            return held.read(path, offset, length);
        },
    };
    const fs = await filesystemModule.create({ drives: { C: { source } } });

    const handle = fs.open('C:\\Game\\Art.mpq');
    fs.seek(handle, 4, fs.SeekFrom.BEGIN);
    assert.equal(text(fs.read(handle, 6)), 'efghij');
    assert.deepEqual(asked, [{ offset: 4, length: 6 }], 'one read, exactly the range wanted');

    // Reading off the end is shortened before the source sees it, not after:
    // a source asked for more than the file holds may pay for the whole tail.
    fs.seek(handle, 24, fs.SeekFrom.BEGIN);
    assert.equal(text(fs.read(handle, 1000)), 'yz');
    assert.deepEqual(asked[1], { offset: 24, length: 2 });
    // And a read that lands past the end asks for nothing at all.
    assert.equal(fs.read(handle, 16).length, 0);
    assert.equal(asked.length, 2, 'end of file is not a read');

    fs.close(handle);
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

test('a second instance in one realm does not take the first one\'s volume', async()=>{
    // A process replacement runs `create()` again in the same realm, and the
    // plan for two machines in one worker needs two volumes at once. The
    // drives, the open files and the current directory belong to the
    // instance, so the first one's api keeps acting on the first one's
    // volume however many times create() runs after.
    const first = await volume();
    first.setCurrentDirectory('C:\\Game');
    first.createDirectory('C:\\FirstOnly');

    const second = await filesystemModule.create(undefined);

    assert.equal(first.currentDirectory(), 'C:\\Game');
    assert.equal(first.stat('C:\\FirstOnly')?.directory, true);
    assert.equal(second.currentDirectory(), 'C:\\');
    assert.equal(second.stat('C:\\FirstOnly'), null, 'the second volume never saw it');

    await filesystemModule.dispose();
});

test('a disposed volume answers not found rather than throwing', async()=>{
    // A host call that was in flight when the machine was disposed retires
    // afterwards and touches the volume. Every method has to answer the way
    // it would for a file that is not there -- never dereferencing what
    // disposal took away.
    const fs = await volume();
    const handle = fs.open('C:\\Readme.TXT');

    await filesystemModule.dispose();

    assert.deepEqual(fs.drives(), []);
    assert.equal(fs.currentDirectory(), '');
    assert.equal(fs.stat('C:\\Readme.TXT'), null);
    assert.deepEqual(fs.list('C:\\'), []);
    assert.equal(fs.open('C:\\Readme.TXT'), null);
    assert.deepEqual(fs.openFiles(), []);
    assert.equal(fs.read(handle, 8).length, 0);
    assert.equal(fs.write(handle, bytes('x')), 0);
    assert.equal(fs.position(handle), 0);
    assert.equal(fs.size(handle), 0);
    assert.equal(fs.createDirectory('C:\\X'), false);
    assert.deepEqual(fs.export(), []);
    assert.equal(fs.apply([]), 0);
    assert.deepEqual(fs.resolve('C:\\Readme.TXT'),
        { drive: '', components: [], device: null, wildcard: false, path: '' });

    assert.doesNotThrow(()=>fs.setCurrentDirectory('C:\\Game'));
    assert.doesNotThrow(()=>fs.setModified('C:\\Readme.TXT', 0));
    assert.doesNotThrow(()=>fs.removeDirectory('C:\\Game'));
    assert.doesNotThrow(()=>fs.deleteFile('C:\\Readme.TXT'));
    assert.doesNotThrow(()=>fs.rename('C:\\Readme.TXT', 'C:\\Other.TXT'));
    assert.doesNotThrow(()=>fs.seek(handle, 0));
    assert.doesNotThrow(()=>fs.setEndOfFile(handle));
    assert.doesNotThrow(()=>fs.close(handle));
    assert.doesNotThrow(()=>fs.mount('D', {}));
    assert.doesNotThrow(()=>fs.onChanged(()=>{}));
});

test('a rename moves a file the program wrote, and copies one the source holds', async()=>{
    // An installer unpacks every file under a temporary name and renames it,
    // a gigabyte at a time; a copy was seconds of the install for each.
    const writable = createMemoryStore();
    let written = 0;
    const counting = {
        ...writable,
        /** @param {string} path @param {number} offset @param {Uint8Array} data */
        write: (path, offset, data)=>{
            written += data.length;
            writable.write(path, offset, data);
        },
    };
    const fs = await filesystemModule.create({ drives: { C: {
        source: createMemoryStore({ 'Game\\Setup.EXE': 'binary' }),
        writable: counting,
    } } });
    fs.createDirectory('C:\\Temp');
    const handle = fs.open('C:\\Temp\\~GLH0000.TMP',
        { write: true, disposition: fs.Disposition.CREATE_NEW });
    fs.write(handle, new Uint8Array(1 << 20).fill(7));
    fs.close(handle);
    fs.setModified('C:\\Temp\\~GLH0000.TMP', Date.UTC(2004, 11, 21));
    written = 0;

    fs.createDirectory('C:\\Steam');
    fs.rename('C:\\Temp\\~GLH0000.TMP', 'C:\\Steam\\Content.gcf');
    assert.equal(written, 0, 'not a byte copied');
    assert.equal(fs.stat('C:\\Temp\\~GLH0000.TMP'), null, 'the old name is gone');
    const moved = fs.stat('c:\\steam\\content.GCF');
    assert.equal(moved?.size, 1 << 20);
    assert.equal(moved?.name, 'Content.gcf', 'spelt as it was renamed to');
    assert.equal(moved?.modified, Date.UTC(2004, 11, 21), 'and as old as it was');
    const reopened = fs.open('C:\\Steam\\Content.gcf');
    assert.deepEqual([...fs.read(reopened, 3)], [7, 7, 7]);
    fs.close(reopened);
    assert.deepEqual(fs.list('C:\\Temp'), []);

    fs.rename('C:\\Game\\Setup.EXE', 'C:\\Game\\Setup.old');
    assert.equal(written, 6, 'what the source holds is copied');
    assert.equal(fs.stat('C:\\Game\\Setup.EXE'), null, 'and its name does not come back');
    assert.throws(()=>fs.rename('C:\\Steam\\Content.gcf', 'C:\\Game\\Setup.old'),
        /already exists/);
    assert.equal(fs.stat('C:\\Steam\\Content.gcf')?.size, 1 << 20,
        'a refused move moves nothing');
    await filesystemModule.dispose();
});

test('what one volume exports another takes as the same pieces, bytes made when read', async()=>{
    const first = await filesystemModule.create({ drives: { C: {} } });
    first.createDirectory('C:\\Steam');
    const handle = first.open('C:\\Steam\\content.gcf',
        { write: true, disposition: first.Disposition.CREATE_NEW });
    first.write(handle, new Uint8Array((3 << 20) + 1).fill(3));
    first.close(handle);
    const exported = first.export();
    await filesystemModule.dispose();

    const writable = createMemoryStore();
    let written = 0;
    const counting = {
        ...writable,
        /** @param {string} path @param {number} offset @param {Uint8Array} data */
        write: (path, offset, data)=>{
            written += data.length;
            writable.write(path, offset, data);
        },
    };
    const second = await filesystemModule.create({ drives: { C: { writable: counting } } });
    assert.equal(second.apply(exported), 1);
    assert.equal(written, 0, 'not copied');
    assert.equal(second.stat('C:\\Steam\\content.gcf')?.size, (3 << 20) + 1);
    assert.equal(Object.keys(exported[0]).join(), 'path,bytes',
        'the pieces do not travel in a copy');
    assert.equal(exported[0].bytes.length, (3 << 20) + 1, 'the bytes, made when asked for');
    assert.equal(exported[0].bytes, exported[0].bytes, 'once');
    await filesystemModule.dispose();
});

test('diagnostics answers for the live instance', async()=>{
    await volume();
    const second = await filesystemModule.create(undefined);
    second.setCurrentDirectory('C:\\');

    const report = /** @type {any} */ (filesystemModule.diagnostics());
    assert.equal(report.status, 'ready');
    assert.equal(report.metrics.current, 'C:\\');
    assert.deepEqual(Object.keys(report.metrics.volumes), ['C:'],
        'the live instance mounts one drive, whatever the one before it mounted');
    await filesystemModule.dispose();
});

/** A disc image mounted as D:, beside an ordinary C:. */
async function withDisc(){
    const image = buildIso({
        label: 'DEMO',
        files: {
            'AUTORUN.INF': '[autorun]\r\nopen=Setup.exe\r\n',
            'Setup.exe': 'MZ setup',
            'Data/Big Cabinet.cab': 'cabinet',
            'Hidden.dat': 'h',
        },
        hidden: ['Hidden.dat'],
    });
    const iso = await openIso((offset, length)=>image.subarray(offset, offset + length));
    const fs = await filesystemModule.create({});
    fs.mount('D', {
        source: createIsoSource(iso),
        readOnly: true,
        volume: { kind: 'cdrom', label: iso.volume.label, serial: iso.volume.serial },
    });
    return fs;
}

test('a disc is a drive of its own that reads like any other', async()=>{
    const fs = await withDisc();
    assert.deepEqual(fs.drives(), ['C', 'D']);
    assert.deepEqual(fs.list('D:\\*').map((/** @type {any} */ entry)=>entry.name).sort(),
        ['AUTORUN.INF', 'Data', 'Hidden.dat', 'Setup.exe']);
    const handle = fs.open('d:\\data\\big cabinet.CAB');
    assert.equal(text(fs.read(handle, 100)), 'cabinet');
    fs.close(handle);
    fs.setCurrentDirectory('D:\\');
    assert.equal(fs.currentDirectory(), 'D:\\');
    assert.equal(fs.stat('Setup.exe')?.readOnly, true);
    assert.equal(fs.stat('Hidden.dat')?.hidden, true);
    assert.equal(fs.stat('Setup.exe')?.hidden, false);
    // The disc's own recording time, rather than the date a source file
    // nobody recorded one for carries.
    assert.equal(fs.stat('Setup.exe')?.modified, Date.UTC(2001, 1, 3, 4, 5, 6));
    assert.equal(fs.stat('C:\\')?.readOnly, false);
    assert.deepEqual(fs.volume('d:'), { kind: 'cdrom', label: 'DEMO',
        serial: fs.volume('D').serial, readOnly: true });
    assert.deepEqual(fs.volume('C'), { readOnly: false });
    assert.equal(fs.volume('Q'), null);
    await filesystemModule.dispose();
});

test('nothing on a disc can be written, made or removed', async()=>{
    const fs = await withDisc();
    const refused = { code: 'WRITE_PROTECTED' };
    assert.throws(()=>fs.open('D:\\Setup.exe', { write: true }), refused);
    // The device refuses the access, so a name that is not there is refused the same way.
    assert.throws(()=>fs.open('D:\\missing.txt', { write: true }), refused);
    assert.throws(()=>fs.open('D:\\new.txt',
        { disposition: fs.Disposition.CREATE_NEW }), refused);
    assert.throws(()=>fs.open('D:\\Setup.exe',
        { disposition: fs.Disposition.CREATE_ALWAYS }), refused);
    assert.throws(()=>fs.createDirectory('D:\\Saves'), refused);
    assert.throws(()=>fs.deleteFile('D:\\Setup.exe'), refused);
    assert.throws(()=>fs.removeDirectory('D:\\Data'), refused);
    assert.throws(()=>fs.rename('D:\\Setup.exe', 'D:\\Other.exe'), refused);
    assert.throws(()=>fs.setModified('D:\\Setup.exe', 0), refused);
    assert.throws(()=>fs.apply([{ path: 'D:\\x.txt', bytes: bytes('x') }]), refused);
    // Opening to read an existing file, whatever the disposition says of a
    // missing one, is still a read.
    const handle = fs.open('D:\\Setup.exe', { disposition: fs.Disposition.OPEN_ALWAYS });
    assert.equal(text(fs.read(handle, 2)), 'MZ');
    fs.close(handle);
    // Moving a file off the disc copies it; the original stays where it is.
    assert.throws(()=>fs.rename('D:\\AUTORUN.INF', 'C:\\autorun.inf'), refused);
    assert.ok(fs.stat('D:\\AUTORUN.INF'));
    assert.deepEqual(fs.export('D'), []);
    await filesystemModule.dispose();
});

test('a file handed from one volume to another is the same bytes until either writes it',
    async()=>{
        // A copy per process made an installer that starts several processes
        // hold its extracted archives once for every one of them.
        const at = (/** @type {string[]} */ ...parts)=>['C:', ...parts].join(String.fromCharCode(92));
        const ours = await volume();
        const theirs = await volume();
        const handle = ours.open(at('data1.cab'),
            { write: true, disposition: ours.Disposition.CREATE_NEW });
        ours.write(handle, bytes('archive'));
        ours.close(handle);

        const [exported] = ours.export('C');
        theirs.apply([exported]);
        const [again] = theirs.export('C');
        assert.ok(exported.contents?.pieces[0]);
        assert.equal(again.contents?.pieces[0], exported.contents?.pieces[0],
            'not copied on the way');

        const writing = theirs.open(at('data1.cab'), { write: true });
        theirs.write(writing, bytes('X'));
        theirs.close(writing);
        const read = (/** @type {any} */ side)=>{
            const reading = side.open(at('data1.cab'), { read: true });
            const got = text(side.read(reading, 64));
            side.close(reading);
            return got;
        };
        assert.equal(read(theirs), 'Xrchive');
        assert.equal(read(ours), 'archive', 'a write copies first');

        const mine = ours.open(at('data1.cab'), { write: true });
        ours.write(mine, bytes('Y'));
        ours.close(mine);
        assert.equal(read(ours), 'Yrchive');
        assert.equal(read(theirs), 'Xrchive', 'and so does the side that handed them over');
        await filesystemModule.dispose();
    });

test('what changed after a generation is named, and what a quiet apply put in is not',
    async()=>{
        const fs = await volume();
        const at = (/** @type {string[]} */ ...parts)=>['C:', ...parts].join(String.fromCharCode(92));
        fs.createDirectory(at('Save'));
        const start = fs.generation();
        const handle = fs.open(at('Save', 'slot.dat'),
            { write: true, disposition: fs.Disposition.CREATE_NEW });
        fs.write(handle, bytes('slot'));
        fs.close(handle);
        const changed = fs.changesSince(start);
        assert.deepEqual(changed.map((/** @type {any} */ file)=>[file.path, text(file.bytes ?? [])]),
            [[at('Save', 'slot.dat'), 'slot']]);

        const mark = fs.generation();
        fs.apply([{ path: at('Save', 'other.dat'), bytes: bytes('theirs') }], { quiet: true });
        assert.deepEqual(fs.changesSince(mark), [], 'another copy of the volume wrote that');
        assert.equal(fs.stat(at('Save', 'other.dat'))?.size, 6);

        fs.deleteFile(at('Save', 'slot.dat'));
        assert.deepEqual(fs.changesSince(mark), [{ path: at('Save', 'slot.dat'), delete: true }]);
        await filesystemModule.dispose();
    });
