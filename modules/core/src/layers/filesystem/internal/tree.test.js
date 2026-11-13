/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIECE_SIZE, createMemoryStore } from './memory-store.js';
import { createOverlay } from './tree.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(character=>character.charCodeAt(0)));

/** @param {Uint8Array} data */
const text = data=>[...data].map(byte=>String.fromCharCode(byte)).join('');

/**
 * A source holding an installation, and an empty writable layer over it -- the
 * shape every mounted drive has before the program has written anything.
 */
function mounted(){
    const source = createMemoryStore({
        'Game': null,
        'Game\\Data': null,
        'Game\\Data\\Config.WTF': 'source',
        'Game\\Setup.EXE': 'binary',
        'Readme.TXT': 'read me',
    });
    const writable = createMemoryStore();
    return { source, writable, tree: createOverlay({ source, writable }) };
}

test('both layers are one volume, and case is no obstacle to finding a file', ()=>{
    const { tree } = mounted();

    assert.equal(tree.stat(['Game', 'Data', 'Config.WTF'])?.size, 6);
    // The lookup a program actually makes: it wrote Config.WTF and now asks
    // for config.wtf.
    assert.equal(tree.stat(['game', 'data', 'config.wtf'])?.size, 6);
    assert.equal(tree.stat(['GAME', 'DATA'])?.directory, true);
    assert.equal(tree.stat(['Game', 'Missing']), null);
});

test('enumeration reports the case a name was created with', ()=>{
    const { tree } = mounted();

    const names = tree.list(['game', 'data']).map(entry=>entry.name);
    assert.deepEqual(names, ['Config.WTF'],
        'asking in lower case does not make the listing lower case');
    assert.deepEqual(tree.list([]).map(entry=>entry.name).sort(), ['Game', 'Readme.TXT']);
});

test('enumeration filters by the wildcard pattern it was given', ()=>{
    const { tree } = mounted();

    assert.deepEqual(tree.list(['Game'], '*.exe').map(entry=>entry.name), ['Setup.EXE']);
    assert.deepEqual(tree.list(['Game'], '*.').map(entry=>entry.name), ['Data']);
    assert.deepEqual(tree.list(['Game'], '*.*').map(entry=>entry.name).sort(),
        ['Data', 'Setup.EXE'], 'a directory with no dot in its name is still matched by *.*');
});

test('a read comes from the source until a write moves the file up', ()=>{
    const { source, writable, tree } = mounted();
    const at = ['Game', 'Data', 'Config.WTF'];

    assert.equal(text(tree.read(at, 0, 6)), 'source');
    assert.equal(writable.stat('Game\\Data\\Config.WTF'), null, 'nothing is copied up early');

    // The copy-on-write moment: one byte written, and the whole file is now
    // the writable layer's, with the bytes it had before still in place.
    tree.write(at, 6, bytes('+more'));

    assert.equal(text(tree.read(at, 0, 32)), 'source+more');
    assert.equal(writable.stat('Game\\Data\\Config.WTF')?.size, 11);
    assert.equal(text(source.read('Game\\Data\\Config.WTF', 0, 32)), 'source',
        'the source is never written to');
    // The directories above it had to be created in the writable layer first.
    assert.equal(writable.stat('Game\\Data')?.directory, true);
});

test('a write past the end extends the file and zero-fills the gap', ()=>{
    const { tree } = mounted();
    const at = ['Readme.TXT'];

    tree.write(at, 10, bytes('X'));

    assert.equal(tree.size(at), 11);
    assert.deepEqual([...tree.read(at, 6, 5)], [0x65, 0, 0, 0, 0x58],
        'the bytes between the old end and the new data are zero');
});

test('truncating a source file to nothing does not copy it up first', ()=>{
    const { writable, tree } = mounted();
    const at = ['Game', 'Setup.EXE'];

    tree.truncate(at, 0);

    assert.equal(tree.size(at), 0);
    assert.equal(writable.stat('Game\\Setup.EXE')?.size, 0);
    assert.equal(text(tree.read(at, 0, 32)), '');
});

test('a deleted source file stays deleted', ()=>{
    const { tree } = mounted();
    const at = ['Game', 'Setup.EXE'];

    tree.removeFile(at);

    assert.equal(tree.stat(at), null);
    assert.deepEqual(tree.list(['Game']).map(entry=>entry.name), ['Data'],
        'the source cannot forget the file, so enumeration has to');
    assert.throws(()=>tree.read(at, 0, 1), { code: 'NOT_FOUND' });
    assert.equal(tree.diagnostics().tombstones, 1);
});

test('a file copied up and then deleted does not fall back to the source', ()=>{
    const { tree } = mounted();
    const at = ['Game', 'Data', 'Config.WTF'];

    tree.write(at, 0, bytes('mine'));
    tree.removeFile(at);

    assert.equal(tree.stat(at), null);
    assert.deepEqual(tree.list(['Game', 'Data']), []);
});

test('recreating a deleted name does not resurrect what was under it', ()=>{
    const { tree } = mounted();

    tree.removeFile(['Game', 'Setup.EXE']);
    tree.createFile(['Game', 'setup.exe']);

    assert.equal(tree.stat(['Game', 'Setup.EXE'])?.size, 0);
    assert.equal(tree.stat(['Game', 'Setup.EXE'])?.name, 'setup.exe',
        'a recreated file carries the spelling it was recreated with');

    tree.removeFile(['Game', 'Data', 'Config.WTF']);
    tree.removeDirectory(['Game', 'Data']);
    assert.throws(()=>tree.removeDirectory(['Game', 'Data']), { code: 'NOT_FOUND' });
    tree.createDirectory(['Game', 'Data']);
    assert.deepEqual(tree.list(['Game', 'Data']), [],
        'the source file that used to be in here is gone with the directory');
});

test('a directory is refused while anything is still in it', ()=>{
    const { tree } = mounted();

    assert.throws(()=>tree.removeDirectory(['Game']), { code: 'DIRECTORY_NOT_EMPTY' });
    assert.throws(()=>tree.removeDirectory(['Game', 'Setup.EXE']), { code: 'NOT_A_DIRECTORY' });
    assert.throws(()=>tree.removeFile(['Game']), { code: 'IS_A_DIRECTORY' });
});

test('creating a directory over a source directory merges rather than hides', ()=>{
    const { writable, tree } = mounted();

    assert.equal(tree.createDirectory(['Game', 'Data']), false, 'it was already there');
    assert.equal(writable.stat('Game\\Data')?.directory, true, 'but it exists in both layers now');
    assert.deepEqual(tree.list(['Game', 'Data']).map(entry=>entry.name), ['Config.WTF'],
        'and what the source put in it is still visible');

    tree.createFile(['Game', 'Data', 'Save.DAT']);
    tree.write(['Game', 'Data', 'Save.DAT'], 0, bytes('save'));
    assert.deepEqual(tree.list(['Game', 'Data']).map(entry=>entry.name).sort(),
        ['Config.WTF', 'Save.DAT']);
});

test('a name in both layers is enumerated once', ()=>{
    const source = createMemoryStore({ 'Game\\Config.WTF': 'source' });
    const writable = createMemoryStore({ 'Game\\Config.WTF': 'mine' });
    const tree = createOverlay({ source, writable });

    assert.deepEqual(tree.list(['Game']).map(entry=>entry.name), ['Config.WTF']);
    assert.equal(text(tree.read(['Game', 'Config.WTF'], 0, 32)), 'mine',
        'and the writable layer is the one that answers');
});

test('a missing directory and a missing file are different failures', ()=>{
    const { tree } = mounted();

    assert.throws(()=>tree.size(['Game', 'Missing.DAT']), { code: 'NOT_FOUND' });
    assert.throws(()=>tree.size(['Nowhere', 'Missing.DAT']), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>tree.createFile(['Nowhere', 'New.DAT']), { code: 'PATH_NOT_FOUND' });
    assert.throws(()=>tree.createFile(['Readme.TXT']), { code: 'ALREADY_EXISTS' });
    assert.throws(()=>tree.list(['Readme.TXT']), { code: 'NOT_A_DIRECTORY' });
});

test('a drive with no source at all is just the writable layer', ()=>{
    const tree = createOverlay({ writable: createMemoryStore() });

    tree.createDirectory(['Save']);
    tree.createFile(['Save', 'slot1.sav']);
    tree.write(['Save', 'slot1.sav'], 0, bytes('data'));

    assert.deepEqual(tree.list(['Save']).map(entry=>entry.name), ['slot1.sav']);
    assert.equal(tree.diagnostics().layered, false);
    tree.removeFile(['Save', 'slot1.sav']);
    assert.equal(tree.diagnostics().tombstones, 0, 'nothing to tombstone without a source');
});

test('what was copied up is visible in diagnostics', ()=>{
    const { tree } = mounted();

    assert.deepEqual(tree.diagnostics(),
        { files: 3, directories: 2, tombstones: 0, copied: 0, layered: true, disagreements: 0 });

    tree.write(['Readme.TXT'], 0, bytes('x'));
    assert.equal(tree.diagnostics().copied, 1);
});

test('a hard link is one file under two names', ()=>{
    const { tree, writable } = mounted();
    tree.createDirectory(['Saves']);
    tree.createFile(['Saves', 'A.DAT']);
    tree.write(['Saves', 'A.DAT'], 0, bytes('first'));
    const made = tree.link(['Saves', 'A.DAT'], ['Game', 'B.DAT']);
    assert.equal(made.links, 2);

    // A write through either name is seen through the other; one store file.
    tree.write(['Game', 'B.DAT'], 0, bytes('FI'));
    assert.equal(text(tree.read(['Saves', 'A.DAT'], 0, 10)), 'FIrst');
    assert.equal(writable.stat('Game\\B.DAT'), null, 'the bytes are kept once');
    assert.deepEqual(tree.writableFiles().map(file=>file.path), ['Saves\\A.DAT']);
    assert.equal(tree.stat(['saves', 'a.dat'])?.identity, tree.stat(['game', 'b.dat'])?.identity);
    tree.setModified(['Game', 'B.DAT'], 1234);
    assert.equal(tree.stat(['Saves', 'A.DAT'])?.modified, 1234, 'the time is the file\'s');
    assert.deepEqual(tree.links(), [{ owner: 'Saves\\A.DAT', names: ['Game\\B.DAT'] }]);
    assert.deepEqual(tree.verify(), [], 'a further name holds nothing of its own');

    // Renaming one name leaves the other; deleting the owner name moves the bytes.
    assert.equal(tree.moveFile(['Game', 'B.DAT'], ['Game', 'C.DAT']), true);
    assert.equal(tree.stat(['Game', 'B.DAT']), null);
    assert.equal(tree.stat(['Saves', 'A.DAT'])?.links, 2);
    tree.removeFile(['Saves', 'A.DAT']);
    assert.equal(tree.stat(['Saves', 'A.DAT']), null);
    assert.deepEqual([tree.stat(['Game', 'C.DAT'])?.links,
        text(tree.read(['Game', 'C.DAT'], 0, 9))], [1, 'FIrst']);
    assert.equal(writable.stat('Saves\\A.DAT'), null);
    assert.equal(writable.stat('Game\\C.DAT')?.size, 5);
    assert.deepEqual(tree.links(), [], 'one name left: an ordinary file');

    // The last name takes the bytes.
    tree.removeFile(['Game', 'C.DAT']);
    assert.equal(writable.stat('Game\\C.DAT'), null);
});

test('a link to a source file copies it up; a directory or a taken name is refused', ()=>{
    const { tree, source } = mounted();
    tree.link(['Readme.TXT'], ['Game', 'Readme2.TXT']);
    tree.write(['Game', 'Readme2.TXT'], 0, bytes('R'));
    assert.equal(text(tree.read(['Readme.TXT'], 0, 7)), 'Read me');
    assert.equal(text(source.read('Readme.TXT', 0, 7)), 'read me', 'the source untouched');
    assert.throws(()=>tree.link(['Game'], ['G2']), { code: 'ACCESS_DENIED' });
    assert.throws(()=>tree.link(['Readme.TXT'], ['Game', 'Setup.EXE']),
        { code: 'ALREADY_EXISTS' });
    assert.throws(()=>tree.link(['Nothing.TXT'], ['N2.TXT']), { code: 'NOT_FOUND' });
    // Deleting the source name leaves a tombstone and the link its bytes.
    tree.removeFile(['Readme.TXT']);
    assert.equal(tree.stat(['Readme.TXT']), null);
    assert.equal(text(tree.read(['Game', 'Readme2.TXT'], 0, 7)), 'Read me');
});

test('a junction shows the directory it stands for; removing it leaves that directory', ()=>{
    // The .NET Framework's assembly cache: fusion moves an assembly into
    // WinSxS and makes its GAC folder a mount point standing for it, then
    // reads the files back through the GAC path.
    const { tree } = mounted();
    tree.createDirectory(['Store']);
    tree.createDirectory(['Store', 'Lib']);
    tree.createFile(['Store', 'Lib', 'A.DLL']);
    tree.write(['Store', 'Lib', 'A.DLL'], 0, bytes('lib'));
    tree.createDirectory(['Cache']);
    tree.setJunction(['Cache'], ['Store', 'Lib']);

    assert.equal(tree.stat(['Cache'])?.junction, 'Store\\Lib');
    assert.equal(tree.stat(['Cache'])?.directory, true);
    assert.equal(text(tree.read(['cache', 'a.dll'], 0, 3)), 'lib', 'a path goes through it');
    assert.deepEqual(tree.list(['Cache']).map(entry=>entry.name), ['A.DLL'],
        'its listing is the target\'s');
    tree.createFile(['Cache', 'B.DLL']);
    assert.ok(tree.stat(['Store', 'Lib', 'B.DLL']), 'what is made through it is the target\'s');

    const records = tree.links();
    assert.deepEqual(records, [{ owner: 'Store\\Lib', names: ['Cache'], junction: true }]);
    tree.removeDirectory(['Cache']);
    assert.equal(tree.stat(['Cache']), null);
    assert.ok(tree.stat(['Store', 'Lib', 'A.DLL']), 'the target stays');

    tree.createDirectory(['Cache']);
    tree.restoreLinks(records);
    assert.equal(text(tree.read(['Cache', 'A.DLL'], 0, 3)), 'lib', 'a session gives it back');
    tree.setJunction(['Cache'], null);
    assert.deepEqual(tree.list(['Cache']), [], 'undone, an empty directory again');
});

test('a junction is made of an empty directory only, and undone only of a junction', ()=>{
    const { tree } = mounted();
    tree.createDirectory(['Full']);
    tree.createFile(['Full', 'X.TXT']);
    assert.throws(()=>tree.setJunction(['Full'], ['Game']), { code: 'DIRECTORY_NOT_EMPTY' });
    assert.throws(()=>tree.setJunction(['Readme.TXT'], ['Game']), { code: 'NOT_A_DIRECTORY' });
    assert.throws(()=>tree.setJunction(['Full'], null), { code: 'NOT_A_REPARSE_POINT' });
    tree.createDirectory(['Loop']);
    tree.setJunction(['Loop'], ['Loop']);
    assert.equal(tree.stat(['Loop', 'X']), null, 'a junction to itself stands for nothing');
});

test('a drive remounted from its files and links has the same names', ()=>{
    const { tree, writable } = mounted();
    tree.createFile(['A.DAT']);
    tree.write(['A.DAT'], 0, bytes('abc'));
    tree.link(['A.DAT'], ['Game', 'Data', 'B.DAT']);
    tree.link(['A.DAT'], ['New', 'C.DAT'].slice(1));
    const records = tree.links();
    const again = createOverlay({ source: null, writable });
    again.restoreLinks(records);
    for (const name of [['A.DAT'], ['Game', 'Data', 'B.DAT'], ['C.DAT']])
    {
        assert.deepEqual([again.stat(name)?.links, text(again.read(name, 0, 3))], [3, 'abc']);
    }
    again.write(['C.DAT'], 0, bytes('X'));
    assert.equal(text(again.read(['A.DAT'], 0, 3)), 'Xbc');
    assert.deepEqual(again.verify(), []);
});

test('a link under a directory the source spells otherwise keeps its bytes where the writable'
    + ' layer has the directory', ()=>{
    const source = createMemoryStore({ 'Windows\\system32\\x.dll': 'library' });
    const writable = createMemoryStore({ 'WINDOWS\\TEMP\\old.tmp': 'old' });
    const tree = createOverlay({ source, writable });
    tree.link(['Windows', 'system32', 'x.dll'], ['windows', 'temp', 'y.dll']);
    assert.equal(text(writable.read('WINDOWS\\system32\\x.dll', 0, 8)), 'library');
    tree.write(['Windows', 'TEMP', 'Y.DLL'], 0, bytes('L'));
    assert.equal(text(tree.read(['WINDOWS', 'SYSTEM32', 'X.DLL'], 0, 8)), 'Library');
    assert.deepEqual(tree.verify(), []);
    assert.equal(tree.moveFile(['Windows', 'system32', 'x.dll'], ['Windows', 'TEMP', 'z.dll']),
        true, 'the owning name moved: the bytes go with it');
    assert.equal(text(writable.read('WINDOWS\\TEMP\\z.dll', 0, 8)), 'Library');
    assert.deepEqual(tree.verify(), []);
});

test('a source that spells a directory otherwise than the writable layer does is one directory'
    + ' that both layers keep under their own spelling', ()=>{
    // The machine makes WINDOWS\TEMP before the bundle is mounted, and the
    // bundle spells the directory Windows; neither store folds case.
    const source = createMemoryStore({ 'Windows\\system32\\x.dll': 'library' });
    const writable = createMemoryStore({ 'WINDOWS\\TEMP\\old.tmp': 'old' });
    const tree = createOverlay({ source, writable });

    assert.deepEqual(tree.list([]).map(entry=>entry.name), ['Windows']);
    assert.equal(text(tree.read(['Windows', 'TEMP', 'old.tmp'], 0, 8)), 'old',
        'what the writable layer held before the mount is read where it is');

    tree.createFile(['Windows', 'TEMP', 'cpuz.sys']);
    tree.write(['Windows', 'TEMP', 'cpuz.sys'], 0, bytes('driver'));
    assert.equal(text(writable.read('WINDOWS\\TEMP\\cpuz.sys', 0, 8)), 'driver',
        'a file made under the bundle\'s spelling goes where the writable layer has the directory');

    assert.equal(text(tree.read(['WINDOWS', 'System32', 'X.DLL'], 0, 16)), 'library');
    tree.write(['Windows', 'system32', 'x.dll'], 7, bytes('!'));
    assert.equal(text(writable.read('WINDOWS\\system32\\x.dll', 0, 16)), 'library!',
        'a copy-up reads the source under its spelling and writes the store under its own');
    tree.createDirectory(['Windows', 'Fonts']);
    assert.equal(writable.stat('WINDOWS\\Fonts')?.directory, true);

    for (const entry of tree.writableFiles())
    {
        assert.ok(writable.stat(entry.path), `"${entry.path}" is in the writable store`);
    }
    assert.deepEqual(tree.verify(), []);

    tree.removeFile(['windows', 'temp', 'CPUZ.SYS']);
    tree.removeFile(['Windows', 'TEMP', 'old.tmp']);
    tree.removeDirectory(['Windows', 'TEMP']);
    assert.equal(writable.stat('WINDOWS\\TEMP'), null);
    assert.deepEqual(tree.verify(), []);
});

test('a store that refuses a change leaves the tree as it was', ()=>{
    const { source, writable } = mounted();
    const full = Object.assign(Object.create(null), writable, {
        truncate: ()=>{
            throw Object.assign(new Error('full'), { code: 'DISK_FULL' });
        },
        adopt: ()=>{
            throw Object.assign(new Error('full'), { code: 'DISK_FULL' });
        },
        mkdir: ()=>{
            throw Object.assign(new Error('full'), { code: 'DISK_FULL' });
        },
    });
    const tree = createOverlay({ source, writable: full });

    assert.throws(()=>tree.createFile(['New.DAT']), { code: 'DISK_FULL' });
    assert.equal(tree.stat(['New.DAT']), null, 'no name is left behind that holds nothing');
    assert.doesNotThrow(()=>tree.removeFile(['Readme.TXT']));
    assert.throws(()=>tree.createFile(['Readme.TXT']), { code: 'DISK_FULL' });
    assert.equal(tree.stat(['Readme.TXT']), null, 'the deleted name stays deleted');

    assert.throws(()=>tree.truncate(['Game', 'Setup.EXE'], 0), { code: 'DISK_FULL' });
    assert.throws(()=>tree.replace(['Game', 'Data', 'Config.WTF'], bytes('x')),
        { code: 'DISK_FULL' });
    assert.equal(text(tree.read(['Game', 'Data', 'Config.WTF'], 0, 8)), 'source',
        'a file the store would not take is still the source\'s');
    assert.equal(text(tree.read(['Game', 'Setup.EXE'], 0, 8)), 'binary');
    assert.throws(()=>tree.createDirectory(['Saves']), { code: 'DISK_FULL' });
    assert.equal(tree.stat(['Saves']), null);
    assert.deepEqual(tree.verify(), []);
    assert.deepEqual(tree.writableFiles(), []);
});

test('verify names every place the tree and its stores disagree', ()=>{
    const { writable, tree } = mounted();
    tree.write(['Readme.TXT'], 0, bytes('x'));
    assert.deepEqual(tree.verify(), []);

    // Behind the tree's back, as a second overlay on the same store would.
    writable.remove('Readme.TXT');
    writable.write('Stray.DAT', 0, bytes('?'));
    assert.deepEqual(tree.verify(), [
        'the writable layer has no file "Readme.TXT"',
        'the writable layer holds "Stray.DAT", which the tree does not hold there',
    ]);
    assert.equal(tree.diagnostics().disagreements, 2);
});

test('a source file is copied up a piece at a time, never read whole', ()=>{
    const whole = new Uint8Array(2 * PIECE_SIZE + 77).map((_, at)=>at % 253);
    const source = createMemoryStore({ 'Data': null, 'Data\\Archive.pak': whole });
    /** @type {number[]} */
    const asked = [];
    const read = source.read;
    source.read = (path, offset, length)=>{
        asked.push(length);
        return read(path, offset, length);
    };
    const writable = createMemoryStore();
    const tree = createOverlay({ source, writable });

    tree.write(['Data', 'Archive.pak'], PIECE_SIZE + 5, Uint8Array.of(255));

    assert.ok(asked.every(length=>length <= PIECE_SIZE), `asked for ${asked.join(', ')}`);
    const expected = whole.slice();
    expected[PIECE_SIZE + 5] = 255;
    assert.deepEqual(writable.read('Data\\Archive.pak', 0, whole.length), expected);
});
