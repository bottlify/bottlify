/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cases are shell32's file operation tests (shlfileop.c), run against the
 * real filesystem layer through kernel32's view of it, in a directory laid out
 * as those tests lay theirs out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import {
    FO_COPY, FO_DELETE, FO_MOVE, FO_RENAME, createDirectoryPath, runFileOperation,
} from './fileop.js';

const FOF_MULTIDESTFILES = 0x0001;
const FOF_SILENT = 0x0004;
const FOF_RENAMEONCOLLISION = 0x0008;
const FOF_NOCONFIRMATION = 0x0010;
const FOF_FILESONLY = 0x0080;
const FOF_NOCONFIRMMKDIR = 0x0200;
const FOF_NOERRORUI = 0x0400;
const FOF_NORECURSION = 0x1000;
const FOF_NO_UI = FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NOCONFIRMMKDIR;

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_NAME = 123;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_BAD_PATHNAME = 161;
const DE_SAMEFILE = 0x71;
const DE_MANYSRC1DEST = 0x72;
const DE_DIFFDIR = 0x73;
const DE_DESTSUBTREE = 0x76;
const DE_INVALIDFILES = 0x7c;
const DE_DESTSAMETREE = 0x7d;
const DE_FLDDESTISFILE = 0x7e;
const DE_FILEDESTISFLD = 0x80;

/** init_shfo_tests: the files and directories every case starts from. */
async function workspace(){
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    volume.mkdir('C:\\work');
    volume.setCurrentDirectory('C:\\work');
    /** @param {string} name */
    const file = name=>{
        const node = volume.open(name, { write: true, create: true, truncate: true });
        volume.write(node, 0, Uint8Array.from([...`${name}\n`].map(c=>c.charCodeAt(0))));
        volume.close(node);
    };
    for (const name of ['test1.txt', 'test2.txt', 'test3.txt', 'test_5.txt'])
    {
        file(name);
    }
    for (const name of ['test4.txt', 'testdir2', 'testdir2\\nested', 'testdir4',
        'testdir4\\nested', 'testdir4\\nested\\subnested', 'testdir6', 'testdir6\\nested',
        'testdir8', 'testdir8\\nested'])
    {
        volume.mkdir(name);
    }
    for (const name of ['testdir2\\one.txt', 'testdir2\\nested\\two.txt', 'testdir4\\nested\\2.txt',
        'testdir4\\nested\\subnested\\3.txt'])
    {
        file(name);
    }
    /** @type {string[]} */
    const diverged = [];
    const deps = {
        volume,
        resolve: (/** @type {string} */ path)=>fs.resolve(path).path,
        divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            diverged.push(`${api}: ${detail}`),
    };
    /**
     * @param {number} func @param {number} flags
     * @param {string[] | null} from @param {string[] | null} [to]
     */
    const run = (func, flags, from, to = null)=>runFileOperation(deps, { func, flags, from, to });
    /** @param {string} path */
    const exists = path=>volume.stat(path) !== null;
    /** @param {string} path */
    const isDirectory = path=>volume.stat(path)?.isDirectory === true;
    /** @param {string} path */
    const text = path=>{
        const node = volume.open(path, { read: true });
        const bytes = /** @type {Uint8Array} */ (volume.read(node, 0, 256));
        volume.close(node);
        return String.fromCharCode(...bytes);
    };
    return { fs, volume, deps, run, exists, isDirectory, text, file, diverged };
}

test('a delete takes files, directories and what a wildcard matches', async()=>{
    // test_delete.
    let w = await workspace();
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI | FOF_FILESONLY, ['C:\\work\\test?.txt']), 0);
    assert.ok(w.isDirectory('test4.txt'),
        'FOF_FILESONLY leaves the directory the wildcard matched');
    assert.ok(!w.exists('test1.txt') && !w.exists('test2.txt') && !w.exists('test3.txt'));
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['C:\\work\\test?.txt']), 0);
    assert.ok(!w.exists('test4.txt'), 'and without it the directory goes too');
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['C:\\work\\test?.txt']), 0,
        'a wildcard that matches nothing is nothing to do');

    w = await workspace();
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['test1.txt', 'test4.txt']), 0);
    assert.ok(!w.exists('test1.txt') && !w.exists('test4.txt') && w.exists('test2.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI | FOF_FILESONLY, ['test_?.txt', 'test4.txt']),
        0, 'a directory named outright is deleted even with FOF_FILESONLY');
    assert.ok(!w.exists('test4.txt') && !w.exists('test_5.txt') && w.exists('test1.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, []), 0, 'an empty list');
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, null), ERROR_INVALID_PARAMETER);
    assert.equal(await w.run(0, FOF_NO_UI, ['test1.txt']), ERROR_INVALID_PARAMETER);
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['nonexistent.txt']), ERROR_FILE_NOT_FOUND);
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['test1.txt', 'nonexistent.txt', 'test2.txt']),
        ERROR_FILE_NOT_FOUND);
    assert.ok(w.exists('test1.txt') && w.exists('test2.txt'), 'nothing deleted');
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['testdir2\\nonexistent.txt']),
        ERROR_FILE_NOT_FOUND);
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['nonexistent\\one.txt']), DE_INVALIDFILES);
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI, ['testdir2', 'testdir2\\one.txt']),
        DE_INVALIDFILES, 'the second went with the first');
    assert.ok(!w.exists('testdir2'));
    assert.equal(await w.run(FO_DELETE, FOF_NO_UI | FOF_NORECURSION, ['testdir4']), 0);
    assert.ok(!w.exists('testdir4'), 'FOF_NORECURSION still takes the subdirectories');
});

test('a rename stays in its directory and does not cross a file and a folder', async()=>{
    // test_rename.
    const w = await workspace();
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test1.txt'], ['test4.txt']), DE_FILEDESTISFLD);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test4.txt'], ['test1.txt']), DE_FLDDESTISFILE);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test3.txt'], ['test4.txt\\test1.txt']),
        DE_DIFFDIR);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test1.txt', 'test2.txt'], ['a.txt']),
        DE_MANYSRC1DEST);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt'], ['a.txt', 'b.txt']), DE_MANYSRC1DEST);
    assert.ok(w.exists('test1.txt'));

    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['C:\\work\\test1.txt'],
        ['C:\\work\\test6.txt']), 0);
    assert.ok(!w.exists('test1.txt') && w.exists('test6.txt'));
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test4.txt'], ['test7.txt']), 0);
    assert.ok(w.isDirectory('test7.txt'));
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test6.txt'], ['a.txt', 'b.txt']), 0,
        'only the first destination counts');
    assert.ok(w.exists('a.txt') && !w.exists('b.txt'));
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['idontexist'], ['newfile']),
        ERROR_FILE_NOT_FOUND);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['a.txt'], ['test2.txt']), 0,
        'onto a file that is there');
    assert.equal(w.text('test2.txt'), 'test1.txt\n');

    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, [], ['test1.txt']), DE_MANYSRC1DEST);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['testdir2'], ['']), DE_DIFFDIR);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['nonexistence'], ['']), ERROR_FILE_NOT_FOUND);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test2.txt'], null), ERROR_ACCESS_DENIED);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test?.txt'], ['x.txt']), DE_MANYSRC1DEST);
    assert.equal(await w.run(FO_RENAME, FOF_NO_UI, ['test2.txt'], ['test?.txt']),
        ERROR_INVALID_NAME);
});

test('a copy goes to a name, into a directory, or into one per source', async()=>{
    // test_copy.
    let w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt', 'test2.txt', 'test4.txt'],
        ['test6.txt', 'test7.txt', 'test8.txt']), 0);
    assert.ok(w.exists('test6.txt\\test1.txt') && w.isDirectory('test6.txt\\test4.txt'),
        'without FOF_MULTIDESTFILES, all into the first destination');
    assert.ok(!w.exists('test7.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test4.txt'], ['test6.txt', 'test7.txt', 'test8.txt']), 0);
    assert.ok(w.exists('test6.txt') && !w.isDirectory('test6.txt'), 'each to its own name');
    assert.ok(w.isDirectory('test8.txt'));

    w = await workspace();
    w.file('test4.txt\\test1.txt');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test?.txt'], ['testdir2']), 0);
    assert.ok(w.exists('testdir2\\test1.txt') && w.exists('testdir2\\test4.txt\\test1.txt'),
        'a wildcard copies the directories it matches, and their contents');

    w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_FILESONLY, ['test?.txt'], ['testdir2']), 0);
    assert.ok(w.exists('testdir2\\test1.txt') && !w.exists('testdir2\\test4.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt', 'test10.txt', 'test2.txt'],
        ['testdir2']), ERROR_FILE_NOT_FOUND);
    assert.ok(!w.exists('testdir2\\test1.txt'), 'nothing is copied when a source is missing');

    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt'],
        ['nonexistent\\notreal\\test2.txt']), 0);
    assert.ok(w.exists('nonexistent\\notreal\\test2.txt'), 'the directories on the way are made');
    assert.equal(w.text('nonexistent\\notreal\\test2.txt'), 'test1.txt\n');

    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt', 'test2.txt'], ['test3.txt']),
        DE_INVALIDFILES, 'several files into a file');
    w.volume.remove('test3.txt');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt', 'test2.txt'], ['test3.txt']), 0);
    assert.ok(w.exists('test3.txt\\test1.txt') && w.exists('test3.txt\\test2.txt'),
        'into a directory made for them');

    w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test3.txt'],
        ['testdir2\\a.txt', 'testdir2\\b.txt', 'testdir2\\c.txt', 'testdir2\\d.txt']), 0);
    assert.ok(w.exists('testdir2\\a.txt\\test1.txt') && !w.exists('testdir2\\d.txt'),
        'more destinations than sources: each a directory');
    const fewer = await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test3.txt'], ['e.txt', 'f.txt']);
    assert.equal(fewer, DE_SAMEFILE,
        'fewer: the last goes to the current directory, where it already is');
    assert.ok(w.exists('e.txt\\test1.txt') && w.exists('f.txt\\test2.txt'));
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES, ['test1.txt'],
        ['b.txt', 'c.txt']), 0);
    assert.ok(w.exists('b.txt') && !w.isDirectory('b.txt') && !w.exists('c.txt'));

    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test3.txt'], ['g.txt', 'test2.txt', 'h.txt']), DE_SAMEFILE);
    assert.ok(w.exists('g.txt') && !w.exists('h.txt'), 'stopped where it failed');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test4.txt', 'test3.txt'], ['i.txt', 'test4.txt', 'j.txt']), DE_DESTSAMETREE);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test4.txt'], ['test4.txt\\newdir']),
        DE_DESTSUBTREE);
    assert.ok(!w.exists('test4.txt\\newdir'));
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test4.txt'], ['test4.txt']), DE_DESTSUBTREE);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['missing.txt'], ['nonexistent2']),
        ERROR_FILE_NOT_FOUND);
    assert.ok(!w.exists('nonexistent2'));

    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['testdir2\\one.txt'], ['']), 0,
        'an empty destination is the current directory');
    assert.ok(w.exists('one.txt'));
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt'], null), ERROR_ACCESS_DENIED);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, null, ['x']), ERROR_INVALID_PARAMETER);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, [], ['testdir2']), 0);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test1.txt'], ['tw?']), ERROR_INVALID_NAME);
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['testdir2/one.txt'], ['dir\\destdir/one.txt']),
        0, 'a forward slash separates as a backslash does');
    assert.ok(w.exists('dir\\destdir\\one.txt'));
});

test('a copy over an existing file replaces it, or renames with FOF_RENAMEONCOLLISION', async()=>{
    const w = await workspace();
    assert.equal(await w.run(FO_COPY, FOF_NOCONFIRMATION, ['test1.txt'], ['test2.txt']), 0);
    assert.equal(w.text('test2.txt'), 'test1.txt\n');
    assert.deepEqual(w.diverged, []);
    assert.equal(await w.run(FO_COPY, 0, ['test3.txt'], ['test2.txt']), 0);
    assert.equal(w.text('test2.txt'), 'test3.txt\n');
    assert.equal(w.diverged.length, 1, 'replaced without the question, and reported');

    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_RENAMEONCOLLISION, ['test1.txt'],
        ['test2.txt']), 0);
    assert.equal(w.text('test2.txt'), 'test3.txt\n', 'kept');
    assert.equal(w.text('Copy of test2.txt'), 'test1.txt\n');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI | FOF_RENAMEONCOLLISION, ['test1.txt'],
        ['test2.txt']), 0);
    assert.ok(w.exists('Copy (2) of test2.txt'));

    // A directory copied onto one of the same name merges into it.
    w.file('test4.txt\\test1.txt');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test4.txt'], ['testdir2']), 0);
    w.file('test4.txt\\test1.txt');
    assert.equal(await w.run(FO_COPY, FOF_NO_UI, ['test4.txt'], ['testdir2']), 0);
    assert.ok(w.exists('testdir2\\test4.txt\\test1.txt'));
});

test('a move takes files and trees, merging into a directory already there', async()=>{
    // test_move.
    let w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['C:\\work\\testdir2\\*.*'],
        ['C:\\work\\test4.txt\\*.*']), ERROR_INVALID_NAME);
    assert.ok(w.exists('testdir2\\one.txt'));
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['C:\\work\\testdir2/*.*'],
        ['C:\\work\\test4.txt']), 0);
    assert.ok(w.isDirectory('testdir2') && !w.exists('testdir2\\one.txt'));
    assert.ok(w.exists('test4.txt\\one.txt') && w.exists('test4.txt\\nested\\two.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['testdir2\\nested'], ['testdir4']), 0);
    assert.ok(!w.exists('testdir2\\nested'));
    assert.ok(w.exists('testdir4\\nested\\two.txt') && w.exists('testdir4\\nested\\2.txt'),
        'into the directory, merged with the one of the same name');

    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI | FOF_MULTIDESTFILES, ['testdir2\\nested'],
        ['testdir6']), 0);
    assert.ok(w.exists('testdir6\\two.txt') && !w.exists('testdir6\\nested\\two.txt'),
        'with FOF_MULTIDESTFILES the destination is the new name, merged');

    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test4.txt'], ['test6.txt', 'test7.txt', 'test8.txt']), 0);
    assert.ok(w.exists('test6.txt') && w.isDirectory('test8.txt') && !w.exists('test1.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test4.txt'], ['test6.txt', 'test7.txt']), DE_DESTSAMETREE);
    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI | FOF_MULTIDESTFILES,
        ['test1.txt', 'test2.txt', 'test3.txt'], ['test6.txt', 'test7.txt']), DE_SAMEFILE);
    assert.ok(w.exists('test3.txt'));

    w = await workspace();
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['test1.txt'], ['']), DE_SAMEFILE);
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['testdir2'], ['']), DE_DESTSAMETREE);
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['nonexistence'], ['']), ERROR_FILE_NOT_FOUND);
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, [], ['nonexistence']), 0);
    assert.ok(!w.exists('nonexistence'));
    assert.equal(await w.run(FO_MOVE, FOF_NO_UI, ['test1.txt'], null), ERROR_ACCESS_DENIED);
});

test('SHCreateDirectoryEx makes every directory of a full path', async()=>{
    // test_sh_create_dir.
    const w = await workspace();
    assert.equal(createDirectoryPath(w.deps, 'C:\\work\\newdir\\test4.txt'), 0);
    assert.ok(w.isDirectory('newdir\\test4.txt'));
    assert.equal(createDirectoryPath(w.deps, 'C:\\work\\newdir\\test4.txt'), ERROR_ALREADY_EXISTS);
    assert.equal(createDirectoryPath(w.deps, 'c:\\testdir3'), 0);
    assert.ok(w.isDirectory('C:\\testdir3'));
    assert.equal(createDirectoryPath(w.deps, 'relative\\dir'), ERROR_BAD_PATHNAME);
    assert.equal(createDirectoryPath(w.deps, 'C:\\work\\test1.txt'), 80, 'ERROR_FILE_EXISTS');
});
