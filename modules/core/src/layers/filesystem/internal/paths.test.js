/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createDirectoryState,
    deviceName,
    formatPath,
    matchName,
    normalise,
    parsePath,
    splitPattern,
} from './paths.js';

/** @param {string} text */
const parts = text=>parsePath(text).components;

test('a path names a drive, a root, or neither', ()=>{
    assert.deepEqual(parsePath('C:\\Game\\x'), {
        drive: 'C', rooted: true, components: ['Game', 'x'], device: null, wildcard: false,
    });
    // Drive-relative: the drive is named but the walk starts at its current
    // directory, which is a different file from C:\Game.
    assert.equal(parsePath('C:Game').rooted, false);
    assert.equal(parsePath('C:Game').drive, 'C');
    assert.equal(parsePath('\\Game').rooted, true);
    assert.equal(parsePath('\\Game').drive, null);
    assert.equal(parsePath('Game').rooted, false);
    assert.equal(parsePath('c:\\x').drive, 'C', 'a drive letter is folded on the way in');
});

test('both separators divide, and repeats collapse', ()=>{
    assert.deepEqual(parts('C:/Game/Data/x'), ['Game', 'Data', 'x']);
    assert.deepEqual(parts('C:\\Game//Data\\\\x'), ['Game', 'Data', 'x']);
    assert.deepEqual(parts('C:\\Game\\'), ['Game'], 'a trailing separator is not a component');
    assert.deepEqual(parts('C:\\'), []);
    assert.deepEqual(parts('C:'), []);
});

test('trailing dots and spaces are not part of a component', ()=>{
    // The shape that matters: a program concatenated a name and left a space on
    // it, then went looking for a file that does exist.
    assert.deepEqual(parts('C:\\Game\\file.txt '), ['Game', 'file.txt']);
    assert.deepEqual(parts('C:\\Game\\file.txt.'), ['Game', 'file.txt']);
    assert.deepEqual(parts('C:\\Game\\file.txt . . '), ['Game', 'file.txt']);
    assert.deepEqual(parts('C:\\Game \\file'), ['Game', 'file']);
    assert.deepEqual(parts('C:\\ leading'), [' leading'], 'only the trailing end is stripped');
    assert.throws(()=>parsePath('C:\\...'), { code: 'INVALID_PATH' },
        'a component that is nothing but dots and spaces strips away to nothing');
});

test('dot and dot-dot survive parsing and are applied by normalisation', ()=>{
    // A relative `..` cannot be applied before the current directory is known.
    assert.deepEqual(parts('..\\x'), ['..', 'x']);
    assert.deepEqual(normalise(['Game', '.', 'Data', '..', 'x']), ['Game', 'x']);
});

test('dot-dot at a root stays at the root', ()=>{
    assert.deepEqual(normalise(['..']), []);
    assert.deepEqual(normalise(['..', '..', '..', 'Game']), ['Game']);
    assert.deepEqual(normalise(['Game', '..', '..', '..', 'Other']), ['Other']);
});

test('a reserved name is a device wherever it appears', ()=>{
    assert.equal(parsePath('NUL').device, 'NUL');
    assert.equal(parsePath('C:\\Game\\nul').device, 'NUL');
    assert.equal(parsePath('C:\\Game\\nul.txt').device, 'NUL', 'an extension does not hide it');
    assert.equal(parsePath('NUL:').device, 'NUL');
    assert.equal(parsePath('com1').device, 'COM1');
    assert.equal(parsePath('LPT9').device, 'LPT9');
    assert.deepEqual(parsePath('C:\\Game\\nul').components, [],
        'the directory part of a device path is never walked');

    assert.equal(parsePath('C:\\Game\\nulls').device, null);
    assert.equal(parsePath('COM0').device, null);
    assert.equal(parsePath('COM10').device, null);
    assert.equal(deviceName('conx'), null);
});

test('a path this layer cannot address is refused rather than half-parsed', ()=>{
    assert.throws(()=>parsePath(''), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('\\\\server\\share'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('//server/share'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('C:\\a<b'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('C:\\a\\b:c'), { code: 'INVALID_PATH' });
});

test('a \\\\?\\ path is taken as written: one divider, no trimming, no devices', ()=>{
    // The Win32 file namespace turns the parsing off (Naming Files, Paths, and Namespaces).
    assert.deepEqual(parsePath('\\\\?\\C:\\Documents and Settings\\User'),
        { drive: 'C', rooted: true, components: ['Documents and Settings', 'User'],
            device: null, wildcard: false });
    assert.deepEqual(parsePath('\\\\?\\c:').components, []);
    assert.deepEqual(parsePath('\\\\?\\C:\\a.\\nul ').components, ['a.', 'nul ']);
    assert.equal(parsePath('\\\\?\\C:\\a\\nul').device, null);
    assert.equal(parsePath('\\\\?\\C:\\a\\*.txt').wildcard, true);
    // A slash is a character there, and no name holds one; a dot is a name, not a step.
    assert.throws(()=>parsePath('\\\\?\\C:\\a/b'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('\\\\?\\C:\\a\\..\\b'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('\\\\?\\UNC\\server\\share'), { code: 'INVALID_PATH' });
    assert.throws(()=>parsePath('\\\\?\\'), { code: 'INVALID_PATH' });
});

test('a wildcard is reported and kept verbatim', ()=>{
    assert.equal(parsePath('C:\\Game\\*.exe').wildcard, true);
    assert.equal(parsePath('C:\\Game\\file.exe').wildcard, false);
    // Trimming `*.` down to `*` would silently widen the search to everything.
    assert.deepEqual(parts('C:\\Game\\*.'), ['Game', '*.']);
});

test('a search path splits into the directory and the pattern', ()=>{
    assert.deepEqual(splitPattern('C:\\Game\\*.exe'),
        { directory: 'C:\\Game\\', pattern: '*.exe' });
    assert.deepEqual(splitPattern('C:\\*'), { directory: 'C:\\', pattern: '*' });
    assert.deepEqual(splitPattern('C:\\Game'),
        { directory: 'C:\\Game', pattern: null });
    assert.deepEqual(splitPattern('*.dll'), { directory: '.', pattern: '*.dll' });
});

test('a wildcard match ignores case', ()=>{
    assert.equal(matchName('*.EXE', 'game.exe'), true);
    assert.equal(matchName('Game.*', 'GAME.EXE'), true);
    assert.equal(matchName('readme.txt', 'README.TXT'), true);
    assert.equal(matchName('readme.txt', 'readme.txtx'), false);
});

test('star does not cross the last dot when the pattern asks for one', ()=>{
    assert.equal(matchName('*.exe', 'game.exe'), true);
    assert.equal(matchName('*.exe', 'game.old.exe'), true);
    assert.equal(matchName('*.exe', 'game.exe.bak'), false);
    assert.equal(matchName('*.*', 'game.exe'), true);
    assert.equal(matchName('a*.b', 'a.b'), true);
    assert.equal(matchName('*', 'anything.at.all'), true);
});

test('star-dot-star matches a name with no dot in it', ()=>{
    // The one every naive glob gets wrong: on Windows `*.*` is "everything",
    // not "everything with an extension".
    assert.equal(matchName('*.*', 'readme'), true);
    assert.equal(matchName('*.*', 'setup.exe'), true);
    assert.equal(matchName('g*.*', 'game'), true);
    assert.equal(matchName('g*.*', 'other'), false);
});

test('star-dot matches only names without an extension', ()=>{
    assert.equal(matchName('*.', 'readme'), true);
    assert.equal(matchName('*.', 'readme.txt'), false);
    assert.equal(matchName('*.', 'a.b.c'), false);
    assert.equal(matchName('data*.', 'data01'), true);
    assert.equal(matchName('data*.', 'data01.dat'), false);
});

test('a question mark takes one character, or none at the end', ()=>{
    assert.equal(matchName('file?.txt', 'file1.txt'), true);
    assert.equal(matchName('file?.txt', 'file.txt'), true, 'none, immediately before the last dot');
    assert.equal(matchName('file?.txt', 'file12.txt'), false);
    assert.equal(matchName('a?c', 'ac'), false, 'and never in the middle of a name');
    assert.equal(matchName('??', 'a'), true);
    assert.equal(matchName('??', 'abc'), false);
});

test('the current directory is remembered per drive', ()=>{
    const state = createDirectoryState();
    assert.equal(state.drive(), 'C');
    assert.deepEqual(state.resolve('Game\\x').components, ['Game', 'x']);

    state.setCurrent('C', ['Game', 'Data']);
    assert.deepEqual(state.resolve('x').components, ['Game', 'Data', 'x']);
    assert.deepEqual(state.resolve('..\\y').components, ['Game', 'y']);
    assert.deepEqual(state.resolve('\\y').components, ['y'], 'a rooted path ignores it');

    // D: keeps its own, so `D:x` is not resolved against C:'s directory.
    assert.deepEqual(state.resolve('D:x'), {
        drive: 'D', components: ['x'], device: null, wildcard: false,
    });
    state.setCurrent('D', ['Other']);
    assert.equal(state.drive(), 'D', 'moving to another drive makes it current');
    assert.deepEqual(state.resolve('x').components, ['Other', 'x']);
    assert.deepEqual(state.resolve('C:x').components, ['Game', 'Data', 'x'],
        'C: still remembers where it was');
});

test('resolution clamps dot-dot at the root of the drive it lands on', ()=>{
    const state = createDirectoryState({ drive: 'C', directory: ['Game'] });
    assert.deepEqual(state.resolve('..\\..\\..\\x').components, ['x']);
    assert.equal(formatPath('C', state.resolve('..\\..\\x').components), 'C:\\x');
    assert.equal(formatPath('C', []), 'C:\\');
});
