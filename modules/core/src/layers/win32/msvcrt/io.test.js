/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescriptors, createIoFunctions } from './io.js';
import { fakeHandles, fakeMemory, fakeVolume } from './harness.test.js';

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_APPEND = 0x0008;
const O_TEMPORARY = 0x0040;
const O_CREAT = 0x0100;
const O_TRUNC = 0x0200;
const O_EXCL = 0x0400;
const O_TEXT = 0x4000;
const O_BINARY = 0x8000;
const O_WTEXT = 0x10000;
const O_U16TEXT = 0x20000;
const O_U8TEXT = 0x40000;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const ENOENT = 2;
const EBADF = 9;
const EACCES = 13;
const EEXIST = 17;
const EINVAL = 22;

/** Wine's msvcrt test_file_write_read: the same two lines, LF and CR LF. */
const MYTEXT = 'This is test_file_write_read\nsecond line\n';
const DOSTEXT = 'This is test_file_write_read\r\nsecond line\r\n';

/** @param {string} text */
const bytesOf = text=>Uint8Array.from(text, character=>character.charCodeAt(0));

/**
 * @param {Record<string, Uint8Array>} [contents]
 * @param {{ late?: boolean, fmode?: number }} [options]
 */
function build(contents = {}, { late = false, fmode = 0 } = {}){
    const memory = fakeMemory();
    const files = fakeVolume(contents, {
        late, directories: ['C:\\', 'C:\\game'], modified: Date.UTC(2001, 0, 2),
    });
    /** @type {number[]} */
    const errno = [];
    /** @type {[number, string][]} */
    const console = [];
    const descriptors = createDescriptors({
        files, errno: code=>errno.push(code), fmode: ()=>fmode,
        write: (handle, text)=>console.push([handle, text]),
    });
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({
        ...memory, files, errno: code=>errno.push(code),
    }, descriptors));
    /** @param {string} path @param {number} flags */
    const open = (path, flags)=>fns._open.handler([memory.put(path), flags, 0x180]);
    const buffer = memory.allocate(256);
    /** @param {number} fd @param {number} count */
    const read = (fd, count)=>{
        const got = fns._read.handler([fd, buffer, count]);
        return got < 0 ? got : String.fromCharCode(...memory.bytes.subarray(buffer, buffer + got));
    };
    /** @param {number} fd */
    const tell = fd=>fns._lseek.handler([fd, 0, SEEK_CUR]);
    return { memory, files, fns, errno, console, descriptors, open, read, tell, buffer };
}

test('a descriptor opens, writes, seeks, reads and closes, numbered from 3', ()=>{
    const { memory, files, fns, open, read, tell } = build();
    const fd = open('C:\\game\\new.bin', O_CREAT | O_TRUNC | O_BINARY | O_RDWR);
    assert.equal(fd, 3, 'the lowest number above the console\'s three');
    assert.equal(open('C:\\game\\new.bin', O_RDONLY | O_BINARY), 4);

    assert.equal(fns._write.handler([fd, memory.put(DOSTEXT), DOSTEXT.length]), DOSTEXT.length);
    assert.equal(String.fromCharCode(...files.files['C:\\game\\new.bin']), DOSTEXT,
        'a binary write stores the bytes as they are');
    assert.equal(tell(fd), DOSTEXT.length);
    assert.equal(fns._lseek.handler([fd, 5, SEEK_SET]), 5);
    assert.equal(fns._lseek.handler([fd, -3, SEEK_END]), DOSTEXT.length - 3);
    assert.equal(fns._lseek.handler([fd, 1, SEEK_CUR]), DOSTEXT.length - 2);
    assert.equal(read(fd, 16), '\r\n', 'a binary read leaves CR LF alone');
    assert.equal(read(fd, 16), '', 'at the end');

    assert.equal(fns._close.handler([fd]), 0);
    assert.deepEqual(files.closed, ['C:\\game\\new.bin']);
    assert.equal(open('C:\\game\\new.bin', O_RDONLY), 3, 'a closed number is used again');
});

test('a file opened _O_TEMPORARY is removed when its descriptor closes', ()=>{
    const { memory, files, fns, open } = build({ 'C:\\game\\keep.bin': bytesOf('k') });
    const fd = open('C:\\game\\scratch.tmp', O_CREAT | O_RDWR | O_BINARY | O_TEMPORARY);
    assert.equal(fns._write.handler([fd, memory.put('abc'), 3]), 3);
    assert.equal(fns._lseek.handler([fd, 0, SEEK_SET]), 0, 'it is a file like any other');
    assert.ok(files.files['C:\\game\\scratch.tmp']);
    assert.equal(fns._close.handler([fd]), 0);
    assert.equal(files.files['C:\\game\\scratch.tmp'], undefined);

    const kept = open('C:\\game\\keep.bin', O_RDONLY);
    fns._close.handler([kept]);
    assert.ok(files.files['C:\\game\\keep.bin'], 'a file opened without it stays');
});

test('the end of the process closes every descriptor, and a temporary file goes with it', ()=>{
    // Windows closes every handle a process held when it ends, however it
    // ends, which is when a file opened to be deleted on close is.
    const { memory, files, fns, descriptors, open, console } = build();
    const scratch = open('C:\\game\\scratch.tmp', O_CREAT | O_RDWR | O_TEMPORARY);
    open('C:\\game\\kept.bin', O_CREAT | O_RDWR);
    fns._write.handler([scratch, memory.put('x'), 1]);

    descriptors.closeAll();
    assert.equal(files.files['C:\\game\\scratch.tmp'], undefined);
    assert.ok(files.files['C:\\game\\kept.bin']);
    assert.deepEqual([...files.closed].sort(), ['C:\\game\\kept.bin', 'C:\\game\\scratch.tmp']);
    assert.equal(fns._write.handler([scratch, memory.put('y'), 1]), -1);
    assert.equal(fns._write.handler([1, memory.put('still'), 5]), 5, 'the console stays');
    assert.deepEqual(console, [[2, 'still']]);
});

test('bytes written to the console read in the ANSI page, as WriteFile\'s to it do', ()=>{
    // 0x80 is the euro sign there, 0x99 the trade mark and 0x97 an em dash.
    const { memory, fns, console } = build();
    const text = memory.allocate(4);
    memory.writeMemory(text, Uint8Array.of(0x80, 0x99, 0x97, 0xe9));
    assert.equal(fns._write.handler([1, text, 4]), 4);
    assert.deepEqual(console, [[2, '€™—é']]);
});

test('_open says why it failed', ()=>{
    const { memory, fns, errno, open } = build({ 'C:\\game\\data.bin': bytesOf('x') });

    assert.equal(open('C:\\game\\none.bin', O_RDONLY), -1);
    assert.equal(open('C:\\game\\data.bin', O_CREAT | O_EXCL | O_WRONLY), -1);
    assert.equal(open('C:\\game', O_RDONLY), -1, 'a directory is not a file');
    assert.equal(open('C:\\game\\data.bin', 3), -1, 'not an access mode');
    assert.equal(fns._open.handler([0, O_RDONLY, 0]), -1);
    assert.deepEqual(errno, [ENOENT, EEXIST, EACCES, EINVAL, EINVAL]);
    assert.equal(fns._open.handler([memory.put('C:\\game\\data.bin'), O_RDONLY, 0]), 3);
});

test('a number that is not open, or not open that way, is EBADF', ()=>{
    // Wine's msvcrt test_readmode: reading a descriptor opened write-only.
    const { memory, fns, errno, open } = build({ 'C:\\game\\data.bin': bytesOf('abc') });
    const writeOnly = open('C:\\game\\data.bin', O_WRONLY);
    const readOnly = open('C:\\game\\data.bin', O_RDONLY);
    const scratch = memory.allocate(8);

    assert.equal(fns._read.handler([writeOnly, scratch, 1]), -1);
    assert.equal(fns._write.handler([readOnly, scratch, 1]), -1);
    assert.equal(fns._read.handler([77, scratch, 1]), -1);
    assert.equal(fns._write.handler([77, scratch, 1]), -1);
    assert.equal(fns._lseek.handler([77, 0, SEEK_SET]), -1);
    assert.equal(fns._close.handler([77]), -1);
    assert.equal(fns._fstat.handler([77, scratch]), -1);
    assert.deepEqual(errno.splice(0), Array(7).fill(EBADF));

    assert.equal(fns._lseek.handler([readOnly, -1, SEEK_SET]), -1, 'before the start');
    assert.equal(fns._lseek.handler([readOnly, 0, 7]), -1, 'no such origin');
    assert.deepEqual(errno, [EINVAL, EINVAL]);
});

test('a text-mode _write puts CR before each LF and answers with the caller\'s count', ()=>{
    const { memory, files, fns, open } = build();
    const fd = open('C:\\game\\t.txt', O_CREAT | O_TRUNC | O_TEXT | O_RDWR);
    assert.equal(fns._write.handler([fd, memory.put(MYTEXT), MYTEXT.length]), MYTEXT.length);
    assert.equal(String.fromCharCode(...files.files['C:\\game\\t.txt']), DOSTEXT);
    fns._close.handler([fd]);
});

test('a text-mode _read folds CR LF to LF, and a CR last in the read looks one further', ()=>{
    // Every case is one of Wine's msvcrt test_file_write_read.
    const { fns, open, read, tell } = build({ 'C:\\game\\t.txt': bytesOf(DOSTEXT) });
    const fd = open('C:\\game\\t.txt', O_RDONLY | O_TEXT);

    assert.equal(read(fd, 256), MYTEXT);
    fns._lseek.handler([fd, 0, SEEK_SET]);
    assert.equal(read(fd, MYTEXT.length), MYTEXT.slice(0, -1),
        'the file\'s first 41 bytes are 40 once folded');

    fns._lseek.handler([fd, 0, SEEK_SET]);
    let single = '';
    for (let at = 0; at < MYTEXT.length; at++)
    {
        single += read(fd, 1);
    }
    assert.equal(single, MYTEXT, 'a one-byte read at a CR reads its LF instead');
    assert.equal(read(fd, 1), '');

    fns._lseek.handler([fd, -1, SEEK_END]);
    assert.equal(read(fd, 256), '\n');
    fns._lseek.handler([fd, -2, SEEK_END]);
    assert.equal(read(fd, 256), '\n');
    fns._lseek.handler([fd, -2, SEEK_END]);
    assert.equal(read(fd, 1), '\n');
    assert.equal(read(fd, 1), '');

    fns._lseek.handler([fd, -3, SEEK_END]);
    assert.equal(read(fd, 1), 'e');
    assert.equal(tell(fd), 41);
    fns._lseek.handler([fd, -3, SEEK_END]);
    assert.equal(read(fd, 2), 'e', 'the CR is dropped and its LF left for the next read');
    assert.equal(tell(fd), 42);
    assert.equal(read(fd, 2), '\n');
    fns._lseek.handler([fd, -3, SEEK_END]);
    assert.equal(read(fd, 3), 'e\n');
    assert.equal(tell(fd), 43);
});

test('in text mode a lone CR is itself, and a ^Z ends the data until a seek', ()=>{
    const { open, read, fns } = build({
        'C:\\game\\cr.txt': bytesOf('\r\r\n'),
        'C:\\game\\z.txt': bytesOf('foo\x1abar'),
        'C:\\game\\end.txt': bytesOf('ab\r'),
    });
    assert.equal(read(open('C:\\game\\cr.txt', O_RDONLY | O_TEXT), 16), '\r\n',
        'CR CR LF reads as CR LF');
    assert.equal(read(open('C:\\game\\end.txt', O_RDONLY | O_TEXT), 16), 'ab\r',
        'a CR at the end of the file stays');

    const fd = open('C:\\game\\z.txt', O_RDONLY | O_TEXT);
    assert.equal(read(fd, 16), 'foo');
    assert.equal(read(fd, 16), '', 'nothing after the ^Z');
    fns._lseek.handler([fd, 0, SEEK_SET]);
    assert.equal(read(fd, 2), 'fo', 'a seek reads again');
    assert.equal(read(open('C:\\game\\z.txt', O_RDONLY | O_BINARY), 16), 'foo\x1abar',
        'binary mode has no end-of-data byte');
});

test('with neither mode named a descriptor is text, unless _fmode says binary', ()=>{
    const contents = { 'C:\\game\\t.txt': bytesOf(DOSTEXT) };
    const text = build({ ...contents });
    assert.equal(text.read(text.open('C:\\game\\t.txt', O_RDONLY), 256), MYTEXT);

    const binary = build({ ...contents }, { fmode: O_BINARY });
    assert.equal(binary.read(binary.open('C:\\game\\t.txt', O_RDONLY), 256), DOSTEXT);
    assert.equal(binary.read(binary.open('C:\\game\\t.txt', O_RDONLY | O_TEXT), 256), MYTEXT,
        'and a mode named wins over it');
});

test('an appending descriptor starts at 0 and writes at the end', ()=>{
    // Wine's msvcrt test_file_write_read: tell() is 0 right after the open.
    const { memory, files, fns, open, read, tell } = build({
        'C:\\game\\log.txt': bytesOf('abc'),
    });
    const fd = open('C:\\game\\log.txt', O_APPEND | O_RDWR | O_BINARY);
    assert.equal(tell(fd), 0);
    assert.equal(read(fd, 1), 'a');
    assert.equal(fns._write.handler([fd, memory.put('de'), 2]), 2);
    assert.equal(String.fromCharCode(...files.files['C:\\game\\log.txt']), 'abcde');
    assert.equal(tell(fd), 5);
});

test('a read whose bytes are still on their way answers when they arrive', async()=>{
    const { open, fns, memory, buffer } = build({ 'C:\\game\\t.txt': bytesOf(DOSTEXT) },
        { late: true });
    const fd = open('C:\\game\\t.txt', O_RDONLY | O_TEXT);
    const answer = fns._read.handler([fd, buffer, 2]);
    assert.equal(typeof answer.then, 'function');
    assert.equal(await answer, 2);
    fns._lseek.handler([fd, 28, SEEK_SET]);
    assert.equal(await fns._read.handler([fd, buffer, 1]), 1, 'the CR waits for its LF');
    assert.equal(memory.bytes[buffer], 0x0a);
});

test('_fstat: a file is regular and read-write, the console a character device', ()=>{
    // Wine's msvcrt test_stat.
    const { memory, fns, open } = build({ 'C:\\game\\data.bin': bytesOf('12345') });
    const stat = memory.allocate(36);
    const fd = open('C:\\game\\data.bin', O_RDONLY);

    assert.equal(fns._fstat.handler([fd, stat]), 0);
    const view = new DataView(memory.bytes.buffer, stat, 36);
    assert.equal(view.getUint16(6, true), 0x8000 | 0o666, 'S_IFREG, rw for all');
    assert.equal(view.getUint32(0, true), 0, 'st_dev');
    assert.equal(view.getUint32(16, true), 0, 'st_rdev');
    assert.equal(view.getInt16(8, true), 1, 'st_nlink');
    assert.equal(view.getInt32(20, true), 5, 'st_size');
    assert.equal(view.getUint32(28, true), Date.UTC(2001, 0, 2) / 1000, 'st_mtime');

    assert.equal(fns._fstat.handler([1, stat]), 0);
    assert.equal(view.getUint16(6, true), 0x2000, 'S_IFCHR');
    assert.deepEqual([view.getUint32(0, true), view.getUint32(16, true)], [1, 1]);
});

test('_stat: device, mode and the names Windows refuses', ()=>{
    // Wine's msvcrt test_stat, for the paths the volume can stand for.
    const { memory, fns, errno } = build({
        'C:\\game\\data.bin': bytesOf('12345'), 'C:\\game\\run.exe': bytesOf('MZ'),
    });
    const stat = memory.allocate(36);
    const view = new DataView(memory.bytes.buffer, stat, 36);
    /** @param {string} path */
    const statOf = path=>fns._stat.handler([memory.put(path), stat]);

    assert.equal(statOf('C:\\game\\data.bin'), 0);
    assert.equal(view.getUint16(6, true), 0x8000 | 0o666);
    assert.deepEqual([view.getUint32(0, true), view.getUint32(16, true)], [2, 2], 'drive C');
    assert.equal(view.getInt32(20, true), 5);
    assert.deepEqual([24, 28, 32].map(at=>view.getUint32(at, true)),
        Array(3).fill(Date.UTC(2001, 0, 2) / 1000));

    assert.equal(statOf('C:\\game\\run.exe'), 0);
    assert.equal(view.getUint16(6, true), 0x8000 | 0o777, 'a program is executable');
    assert.equal(statOf('C:\\game   '), 0, 'trailing spaces are not part of the name');
    assert.equal(view.getUint16(6, true), 0x4000 | 0o777);
    assert.equal(statOf('C:\\'), 0, 'a drive\'s root');
    assert.equal(view.getUint32(0, true), 2);

    assert.equal(statOf('C:\\game\\data.bin\\'), -1, 'a file named as a directory');
    assert.equal(statOf('C:\\game\\'), -1);
    assert.equal(statOf('C:'), -1);
    assert.equal(statOf('C:\\game\\none'), -1);
    assert.deepEqual(errno, [ENOENT, ENOENT, ENOENT, ENOENT]);
});

/**
 * `struct _stati64` as msvcrt.dll lays it out: `_stat`'s fields with a 64-bit
 * size, which its alignment puts at 24, and the three 32-bit times after it.
 */
const STATI64 = { DEV: 0, MODE: 6, NLINK: 8, RDEV: 16, SIZE: 24, TIMES: [32, 36, 40], BYTES: 48 };

test('_stati64 answers as _stat does, into the record with the 64-bit size', ()=>{
    const { memory, fns, errno } = build({ 'C:\\game\\data.bin': bytesOf('12345') });
    const stat = memory.allocate(STATI64.BYTES);
    memory.writeMemory(stat, new Uint8Array(STATI64.BYTES).fill(0xcc));
    const view = new DataView(memory.bytes.buffer, stat, STATI64.BYTES);

    assert.equal(fns._stati64.handler([memory.put('C:\\game\\data.bin'), stat]), 0);
    assert.equal(view.getUint16(STATI64.MODE, true), 0x8000 | 0o666);
    assert.deepEqual([view.getUint32(STATI64.DEV, true), view.getUint32(STATI64.RDEV, true)],
        [2, 2], 'drive C');
    assert.equal(view.getInt16(STATI64.NLINK, true), 1);
    assert.equal(view.getBigInt64(STATI64.SIZE, true), 5n);
    assert.deepEqual(STATI64.TIMES.map(at=>view.getUint32(at, true)),
        Array(3).fill(Date.UTC(2001, 0, 2) / 1000));
    assert.equal(view.getUint32(20, true), 0, 'the padding before the size is written too');
    assert.equal(view.getUint32(44, true), 0, 'and after the times');

    assert.equal(fns._stati64.handler([memory.put('C:\\game\\'), stat]), -1);
    assert.equal(fns._stati64.handler([memory.put('C:\\game\\none'), stat]), -1);
    assert.equal(fns._stati64.handler([0, stat]), -1);
    assert.deepEqual(errno, [ENOENT, ENOENT, EINVAL]);
});

test('_stati64 reports a size past 4 GiB whole', ()=>{
    const memory = fakeMemory();
    const files = fakeVolume({});
    const big = 5 * 2 ** 30;
    files.stat = ()=>({ exists: true, isDirectory: false, size: big, modified: 0 });
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({ ...memory, files },
        createDescriptors({ files })));
    const stat = memory.allocate(STATI64.BYTES);
    assert.equal(fns._stati64.handler([memory.put('C:\\movie.bik'), stat]), 0);
    const view = new DataView(memory.bytes.buffer, stat, STATI64.BYTES);
    assert.equal(view.getBigInt64(STATI64.SIZE, true), BigInt(big));
});

/**
 * The descriptor calls with a register for the high half of an __int64
 * answer, which a program reads from EDX:EAX.
 *
 * @param {Record<string, Uint8Array>} [contents]
 */
function wide(contents = {}){
    const memory = fakeMemory();
    const files = fakeVolume(contents, { directories: ['C:\\', 'C:\\game'] });
    /** @type {number[]} */
    const errno = [];
    const registers = { edx: 0x5a5a5a5a };
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({
        ...memory, files, errno: code=>errno.push(code),
        setRegisters: values=>Object.assign(registers, values),
    }, createDescriptors({ files, errno: code=>errno.push(code) })));
    /** @param {number} eax */
    const pair = eax=>BigInt(registers.edx >>> 0) << 32n | BigInt(eax >>> 0);
    /** @param {string} path @param {number} flags */
    const open = (path, flags)=>fns._open.handler([memory.put(path), flags, 0x180]);
    return { memory, files, errno, fns, pair, open };
}

test('_lseeki64, _telli64 and _filelengthi64 answer in EDX:EAX', ()=>{
    const { files, errno, fns, pair, open } = wide({ 'C:\\game\\data.bin': bytesOf('12345') });
    const fd = open('C:\\game\\data.bin', O_RDWR | O_BINARY);

    assert.equal(pair(fns._lseeki64.handler([fd, 3, 0, SEEK_SET])), 3n);
    assert.equal(pair(fns._telli64.handler([fd])), 3n);
    assert.equal(pair(fns._lseeki64.handler([fd, -1, -1, SEEK_END])), 4n, 'a negative offset');
    assert.equal(pair(fns._lseeki64.handler([fd, 0, 1, SEEK_SET])), 0x100000000n,
        'past 4 GiB');
    assert.equal(pair(fns._telli64.handler([fd])), 0x100000000n);
    assert.equal(pair(fns._filelengthi64.handler([fd])), 5n);
    assert.equal(pair(fns._telli64.handler([fd])), 0x100000000n, 'the position stays');

    files.stat = ()=>({ exists: true, isDirectory: false, size: 5 * 2 ** 30, modified: 0 });
    assert.equal(pair(fns._filelengthi64.handler([fd])), BigInt(5 * 2 ** 30));

    for (const call of [
        ()=>fns._lseeki64.handler([77, 0, 0, SEEK_SET]),
        ()=>fns._telli64.handler([77]),
        ()=>fns._filelengthi64.handler([77]),
    ])
    {
        assert.equal(pair(call()), 0xffffffffffffffffn, '-1 as an __int64');
    }
    assert.equal(pair(fns._lseeki64.handler([fd, -1, -1, SEEK_SET])), 0xffffffffffffffffn);
    assert.deepEqual(errno, [EBADF, EBADF, EBADF, EINVAL]);
    assert.deepEqual([fns._lseeki64.argBytes, fns._telli64.argBytes,
        fns._filelengthi64.argBytes], [16, 4, 4]);
});

test('_fstati64 answers as _fstat does, into the record with the 64-bit size', ()=>{
    const { memory, fns, open } = wide({ 'C:\\game\\data.bin': bytesOf('12345') });
    const stat = memory.allocate(STATI64.BYTES);
    memory.writeMemory(stat, new Uint8Array(STATI64.BYTES).fill(0xcc));
    const view = new DataView(memory.bytes.buffer, stat, STATI64.BYTES);

    assert.equal(fns._fstati64.handler([open('C:\\game\\data.bin', O_RDONLY), stat]), 0);
    assert.equal(view.getUint16(STATI64.MODE, true), 0x8000 | 0o666);
    assert.equal(view.getBigInt64(STATI64.SIZE, true), 5n);
    assert.equal(view.getUint32(44, true), 0, 'the whole record');
    assert.equal(fns._fstati64.handler([1, stat]), 0);
    assert.equal(view.getUint16(STATI64.MODE, true), 0x2000, 'the console');
    assert.equal(fns._fstati64.handler([77, stat]), -1);
});

test('without a register for the high half the __int64 calls are not exported', ()=>{
    const { fns } = build();
    assert.deepEqual([fns._lseeki64, fns._telli64, fns._filelengthi64],
        [undefined, undefined, undefined]);
    assert.notEqual(fns._fstati64, undefined, 'its answer is an int');
});

test('a stream\'s read folds text as the program reads it and consumes only that', ()=>{
    // Wine's msvcrt test_asciimode: CR CR LF is CR LF, and "foo" then ^Z is
    // three bytes and then the end.
    const { files, descriptors, open } = build({
        'C:\\game\\cr.txt': bytesOf('\r\r\nx'),
        'C:\\game\\z.txt': bytesOf('foo\x1abar'),
        'C:\\game\\lines.txt': bytesOf('one\r\ntwo\r\n'),
    });
    const text = (/** @type {Uint8Array} */ bytes)=>String.fromCharCode(...bytes);
    const cr = /** @type {any} */ (descriptors.get(open('C:\\game\\cr.txt', O_RDONLY)));
    assert.equal(text(/** @type {Uint8Array} */ (descriptors.pull(cr, 2, false))), '\r\n');
    assert.equal(cr.position, 3, 'three bytes of the file made the two');

    const z = /** @type {any} */ (descriptors.get(open('C:\\game\\z.txt', O_RDONLY)));
    assert.equal(text(/** @type {Uint8Array} */ (descriptors.pull(z, 64, false))), 'foo');
    assert.equal(text(/** @type {Uint8Array} */ (descriptors.pull(z, 64, false))), '');

    const lines = /** @type {any} */ (descriptors.get(open('C:\\game\\lines.txt', O_RDONLY)));
    const before = files.reads;
    assert.equal(text(/** @type {Uint8Array} */ (descriptors.pull(lines, 64, true))), 'one\n');
    assert.equal(lines.position, 5);
    assert.equal(text(/** @type {Uint8Array} */ (descriptors.pull(lines, 64, true))), 'two\n');
    assert.equal(lines.position, 10);
    assert.equal(files.reads - before, 1, 'the second line came from what the first read');
});

test('_setmode checks the mode, then the number, and answers with the mode it replaced', ()=>{
    // Wine's msvcrt test_setmode, for the two translations this runtime has.
    const { memory, files, fns, errno, open } = build();
    const fd = open('C:\\game\\empty1', O_CREAT | O_WRONLY);

    assert.equal(fns._setmode.handler([-2, 0]), -1);
    assert.equal(fns._setmode.handler([-2, O_TEXT]), -1);
    assert.equal(fns._setmode.handler([fd, 0xffffffff]), -1);
    assert.equal(fns._setmode.handler([fd, 0]), -1);
    assert.equal(fns._setmode.handler([fd, O_BINARY | O_TEXT]), -1);
    assert.equal(fns._setmode.handler([fd, O_WTEXT | O_U16TEXT]), -1);
    assert.deepEqual(errno.splice(0), [EINVAL, EBADF, EINVAL, EINVAL, EINVAL, EINVAL]);

    assert.equal(fns._setmode.handler([fd, O_BINARY]), O_TEXT);
    assert.equal(fns._write.handler([fd, memory.put('a\n'), 2]), 2);
    assert.equal(fns._setmode.handler([fd, O_TEXT]), O_BINARY);
    assert.equal(fns._write.handler([fd, memory.put('b\n'), 2]), 2);
    assert.equal(fns._setmode.handler([fd, O_TEXT]), O_TEXT);
    assert.equal(String.fromCharCode(...files.files['C:\\game\\empty1']), 'a\nb\r\n');
    assert.equal(fns._setmode.handler([1, O_BINARY]), O_TEXT, 'the console\'s too');
    assert.deepEqual(errno, []);
});

test('_setmode takes the Unicode translations and answers _O_WTEXT for any of them', ()=>{
    // Wine's msvcrt test_setmode, the rest of its sequence.
    const { errno, fns, open } = build();
    const fd = open('C:\\game\\empty1', O_CREAT | O_WRONLY);
    assert.equal(fns._setmode.handler([fd, O_BINARY]), O_TEXT);
    assert.equal(fns._setmode.handler([fd, O_WTEXT]), O_BINARY);
    assert.equal(fns._setmode.handler([fd, O_TEXT]), O_WTEXT);
    assert.equal(fns._setmode.handler([fd, O_U16TEXT]), O_TEXT);
    assert.equal(fns._setmode.handler([fd, O_U8TEXT]), O_WTEXT);
    assert.equal(fns._setmode.handler([fd, O_TEXT]), O_WTEXT);
    assert.deepEqual(errno, []);
});

/** @param {Uint8Array} bytes */
const hex = bytes=>[...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join(' ');

test('in a Unicode mode _write takes UTF-16, writes the BOM first and LF as CR LF', ()=>{
    // Wine's msvcrt test_file_write_read: an odd count is refused, and a
    // new file starts with the BOM of the translation it was opened in.
    const { memory, files, errno, fns, open } = build();
    const utf16 = open('C:\\game\\w.txt', O_CREAT | O_TRUNC | O_WRONLY | O_WTEXT);
    assert.equal(fns._write.handler([utf16, memory.put('a'), 1]), -1);
    assert.equal(fns._write.handler([utf16, memory.put('a\0\n\0\xff\xff'), 6]), 6);
    fns._close.handler([utf16]);
    assert.equal(hex(files.files['C:\\game\\w.txt']), 'ff fe 61 00 0d 00 0a 00 ff ff');

    const utf8 = open('C:\\game\\8.txt', O_CREAT | O_TRUNC | O_WRONLY | O_U8TEXT);
    assert.equal(fns._write.handler([utf8, memory.put('a'), 1]), -1);
    assert.equal(fns._write.handler([utf8, memory.put('a\0\n\0b\0'), 6]), 6);
    fns._close.handler([utf8]);
    assert.equal(hex(files.files['C:\\game\\8.txt']), 'ef bb bf 61 0d 0a 62');
    assert.deepEqual(errno, [EINVAL, EINVAL]);
});

test('in a Unicode mode _read hands back UTF-16, the file\'s BOM saying how it is kept', ()=>{
    // Wine's msvcrt test_file_write_read, reading those files back with
    // _O_WTEXT, and a UTF-8 file of its own with a stray byte in it.
    const { memory, errno, fns, open, buffer } = build({
        'C:\\game\\w.txt': Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0, 0xff, 0xff),
        'C:\\game\\8.txt': Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62),
        'C:\\game\\z.txt': Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0xc4, 0x85, 0x62, 0xc5, 0xbc,
            0x0d, 0x0d, 0x0a),
    });
    /** @param {number} fd @param {number} count */
    const read = (fd, count)=>{
        const got = fns._read.handler([fd, buffer, count]);
        return got < 0 ? got : hex(memory.bytes.subarray(buffer, buffer + got));
    };

    const utf16 = open('C:\\game\\w.txt', O_RDONLY | O_WTEXT);
    assert.equal(read(utf16, 3), -1);
    assert.deepEqual(errno.splice(0), [EINVAL]);
    assert.equal(read(utf16, 256), '61 00 0a 00 ff ff');

    const utf8 = open('C:\\game\\8.txt', O_RDONLY | O_WTEXT);
    assert.equal(read(utf8, 256), '61 00 0a 00 62 00');
    fns._lseek.handler([utf8, 6, SEEK_SET]);
    assert.equal(read(utf8, 2), '62 00');

    const mixed = open('C:\\game\\z.txt', O_RDONLY | O_WTEXT);
    assert.equal(read(mixed, 256), '61 00 05 01 62 00 7c 01 0d 00 0a 00');
    fns._lseek.handler([mixed, 5, SEEK_SET]);
    assert.equal(read(mixed, 256), 'fd ff 62 00 7c 01 0d 00 0a 00',
        'a byte that begins nothing is U+FFFD');
    assert.deepEqual(errno, []);
});

test('a file opened in a Unicode mode only to append to is added to as its mark says', ()=>{
    // "If _open is called with _O_WRONLY | _O_APPEND (append mode) and
    // _O_WTEXT, _O_U16TEXT, or _O_U8TEXT, it first tries to open the file for
    // reading and writing, read the BOM, then reopen it for writing only."
    const { memory, files, fns, open, errno } = build({
        'C:\\game\\w.txt': Uint8Array.of(0xff, 0xfe, 0x61, 0),
    });
    const fd = open('C:\\game\\w.txt', O_WRONLY | O_APPEND | O_U8TEXT);
    assert.equal(fns._write.handler([fd, memory.put('\u263a&'), 2]), 2);
    assert.equal(fns._read.handler([fd, memory.allocate(2), 2]), -1, 'still only to write');
    fns._close.handler([fd]);
    assert.equal(hex(files.files['C:\\game\\w.txt']), 'ff fe 61 00 3a 26');
    assert.deepEqual(errno, [EBADF]);
});

test('a Unicode open waits for the file\'s mark while its bytes are on their way', async()=>{
    const { fns, open, memory, buffer } = build({
        'C:\\game\\w.txt': Uint8Array.of(0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0),
    }, { late: true });
    const opening = open('C:\\game\\w.txt', O_RDONLY | O_U8TEXT);
    assert.equal(typeof opening.then, 'function', 'the caller parks on it');
    const fd = await opening;
    assert.equal(await fns._read.handler([fd, buffer, 8]), 4);
    assert.equal(hex(memory.bytes.subarray(buffer, buffer + 4)), '61 00 0a 00',
        'read the way the mark says, from past it');
});

test('a console descriptor in a Unicode mode writes the characters its UTF-16 spells', ()=>{
    const { memory, fns, console } = build();
    assert.equal(fns._setmode.handler([1, O_U16TEXT]), O_TEXT);
    assert.equal(fns._write.handler([1, memory.put('h\0\xe9\0\n\0'), 6]), 6);
    assert.deepEqual(console, [[2, 'h\xe9\n']]);
});

test('_tell is where the next byte goes, counted in the file\'s own bytes', ()=>{
    // Wine's msvcrt test__creat: "a\nb\n" is six bytes written in text mode.
    const { memory, fns, errno, open } = build();
    const text = open('C:\\game\\text.tst', O_CREAT | O_RDWR | O_TEXT);
    fns._write.handler([text, memory.put('a\nb\n'), 4]);
    assert.equal(fns._tell.handler([text]), 6);
    const binary = open('C:\\game\\binary.tst', O_CREAT | O_RDWR | O_BINARY);
    fns._write.handler([binary, memory.put('a\nb\n'), 4]);
    assert.equal(fns._tell.handler([binary]), 4);
    fns._lseek.handler([binary, 1, SEEK_SET]);
    assert.equal(fns._tell.handler([binary]), 1);

    assert.equal(fns._tell.handler([77]), -1);
    assert.deepEqual(errno, [EBADF]);
});

test('_eof is 1 at the end of the file, 0 before it, and -1 for a number not open', ()=>{
    const { fns, errno, open, read } = build({
        'C:\\game\\two.bin': bytesOf('ab'), 'C:\\game\\z.txt': bytesOf('a\x1ab'),
    });
    const fd = open('C:\\game\\two.bin', O_RDONLY | O_BINARY);
    assert.equal(fns._eof.handler([fd]), 0);
    read(fd, 1);
    assert.equal(fns._eof.handler([fd]), 0);
    read(fd, 1);
    assert.equal(fns._eof.handler([fd]), 1);
    fns._lseek.handler([fd, 10, SEEK_SET]);
    assert.equal(fns._eof.handler([fd]), 1, 'past the end is at it');

    const z = open('C:\\game\\z.txt', O_RDONLY | O_TEXT);
    assert.equal(read(z, 16), 'a');
    assert.equal(fns._eof.handler([z]), 1, 'a ^Z ends the data a read will see');

    assert.equal(fns._eof.handler([77]), -1);
    assert.deepEqual(errno, [EBADF]);
});

test('_filelength is the size of the file, and leaves the position where it was', ()=>{
    const { fns, errno, open, tell } = build({ 'C:\\game\\five.bin': bytesOf('12345') });
    const fd = open('C:\\game\\five.bin', O_RDONLY);
    fns._lseek.handler([fd, 2, SEEK_SET]);
    assert.equal(fns._filelength.handler([fd]), 5);
    assert.equal(tell(fd), 2);
    assert.equal(fns._filelength.handler([77]), -1);
    assert.deepEqual(errno, [EBADF]);
});

/** @param {Record<string, Uint8Array>} [contents] */
function withHandles(contents = {}){
    const memory = fakeMemory();
    const files = fakeVolume(contents, { directories: ['C:\\', 'C:\\game'] });
    const handles = fakeHandles(files);
    /** @type {number[]} */
    const errno = [];
    /** @type {[number, string][]} */
    const console = [];
    /** @type {string[]} */
    const divergences = [];
    const descriptors = createDescriptors({
        files, handles, errno: code=>errno.push(code),
        write: (handle, text)=>console.push([handle, text]),
    });
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({
        ...memory, files, errno: code=>errno.push(code), divergence: api=>divergences.push(api),
    }, descriptors));
    /** @param {string} path @param {number} flags */
    const open = (path, flags)=>fns._open.handler([memory.put(path), flags, 0x180]);
    /** @param {string} name */
    const text = name=>String.fromCharCode(...files.files[name]);
    return { memory, files, handles, errno, console, divergences, fns, open, text };
}

const INVALID_HANDLE_VALUE = -1;

test('_get_osfhandle hands out a kernel32 handle standing at the descriptor\'s position', ()=>{
    // Wine's msvcrt test_get_osfhandle: what is written through the handle
    // is in the file, and a descriptor closed has no handle.
    const { memory, handles, errno, fns, open, text, files } = withHandles();
    const fd = open('C:\\game\\t_get_osfhandle', O_CREAT | O_RDWR | O_BINARY);
    const handle = fns._get_osfhandle.handler([fd]);
    assert.notEqual(handle, INVALID_HANDLE_VALUE);
    assert.equal(fns._get_osfhandle.handler([fd]), handle, 'the same one every time');

    const file = handles.file(handle);
    file.position += files.write(file.node, file.position, bytesOf('bar'));
    assert.equal(text('C:\\game\\t_get_osfhandle'), 'bar');
    assert.equal(fns._tell.handler([fd]), 3, 'a write through the handle moved the descriptor');
    fns._lseek.handler([fd, 1, SEEK_SET]);
    assert.equal(file.position, 1, 'and a seek of the descriptor moves the handle');
    assert.equal(fns._write.handler([fd, memory.put('X'), 1]), 1);
    assert.equal(text('C:\\game\\t_get_osfhandle'), 'bXr');

    assert.equal(fns._close.handler([fd]), 0);
    assert.equal(handles.file(handle), null, 'closing the descriptor closed the handle');
    assert.deepEqual(files.closed, ['C:\\game\\t_get_osfhandle'], 'and the file, once');
    assert.equal(fns._get_osfhandle.handler([fd]), INVALID_HANDLE_VALUE);
    assert.deepEqual(errno, [EBADF]);
});

test('_get_osfhandle of the console\'s three is the standard handle each stands for', ()=>{
    const { fns } = withHandles();
    assert.deepEqual([0, 1, 2].map(fd=>fns._get_osfhandle.handler([fd])), [1, 2, 3]);
});

test('_open_osfhandle makes a descriptor of a handle, which _close closes', ()=>{
    // Wine's msvcrt test__open_osfhandle: INVALID_HANDLE_VALUE and a handle
    // closed already are EBADF; the descriptor is binary unless told text.
    const { memory, handles, errno, fns, text } = withHandles({
        'C:\\game\\open_osfhandle.tst': new Uint8Array(0),
    });
    assert.equal(fns._open_osfhandle.handler([INVALID_HANDLE_VALUE, 0]), -1);
    assert.deepEqual(errno.splice(0), [EBADF]);

    const handle = handles.create('C:\\game\\open_osfhandle.tst', false, true);
    const fd = fns._open_osfhandle.handler([handle, 0]);
    assert.ok(fd > 2);
    assert.equal(fns._get_osfhandle.handler([fd]), handle);
    assert.equal(fns._write.handler([fd, memory.put('a\n'), 2]), 2);
    assert.equal(text('C:\\game\\open_osfhandle.tst'), 'a\n', 'binary');
    assert.equal(handles.file(handle).position, 2, 'the handle moved with the descriptor');
    assert.equal(fns._read.handler([fd, memory.allocate(4), 1]), -1, 'the handle\'s access');
    assert.equal(fns._close.handler([fd]), 0);
    assert.equal(handles.file(handle), null);
    assert.equal(fns._open_osfhandle.handler([handle, 0]), -1);
    assert.deepEqual(errno.splice(0), [EBADF, EBADF]);

    const textual = fns._open_osfhandle.handler(
        [handles.create('C:\\game\\open_osfhandle.tst'), O_TEXT | O_APPEND]);
    assert.equal(fns._write.handler([textual, memory.put('b\n'), 2]), 2);
    assert.equal(text('C:\\game\\open_osfhandle.tst'), 'a\nb\r\n', 'text, at the end');
    assert.deepEqual(errno, []);
});

test('two descriptors on one handle: the first _close closes it, the second fails', ()=>{
    // Wine's msvcrt test_close.
    const { handles, errno, fns } = withHandles({ 'C:\\game\\fdopen.tst': new Uint8Array(0) });
    const handle = handles.create('C:\\game\\fdopen.tst');
    const fd1 = fns._open_osfhandle.handler([handle, 0]);
    const fd2 = fns._open_osfhandle.handler([handle, 0]);
    assert.notEqual(fd1, fd2);
    assert.deepEqual([fd1, fd2].map(fd=>fns._get_osfhandle.handler([fd])), [handle, handle]);
    assert.equal(fns._close.handler([fd1]), 0);
    assert.equal(handles.file(handle), null);
    assert.equal(fns._close.handler([fd2]), -1);
    assert.equal(fns._close.handler([fd1]), -1);
    assert.deepEqual(errno, [EBADF, EBADF]);
});

test('a descriptor whose handle the program closed itself answers EBADF', ()=>{
    const { memory, handles, errno, fns, open, files } = withHandles();
    const fd = open('C:\\game\\closed.bin', O_CREAT | O_RDWR);
    handles.close(fns._get_osfhandle.handler([fd]));
    assert.equal(fns._read.handler([fd, memory.allocate(4), 1]), -1);
    assert.equal(fns._write.handler([fd, memory.put('x'), 1]), -1);
    assert.equal(fns._close.handler([fd]), -1);
    assert.deepEqual(errno, [EBADF, EBADF, EBADF]);
    assert.deepEqual(files.closed, ['C:\\game\\closed.bin'], 'the file closed once, not twice');
});

test('_open_osfhandle of a standard handle is a descriptor on the console', ()=>{
    const { memory, console, fns } = withHandles();
    const fd = fns._open_osfhandle.handler([2, O_TEXT]);
    assert.ok(fd > 2);
    assert.equal(fns._write.handler([fd, memory.put('hi'), 2]), 2);
    assert.deepEqual(console, [[2, 'hi']]);
    assert.equal(fns._get_osfhandle.handler([fd]), 2);
    assert.equal(fns._close.handler([fd]), 0);
    assert.equal(fns._open_osfhandle.handler([2, 0]), fd, 'the number is free again');
});

test('_open_osfhandle takes a Unicode translation, as _setmode does', ()=>{
    const { memory, handles, errno, fns, text } = withHandles({
        'C:\\game\\u.txt': new Uint8Array(0),
    });
    const fd = fns._open_osfhandle.handler([handles.create('C:\\game\\u.txt'), O_U16TEXT]);
    assert.ok(fd > 2);
    assert.equal(fns._write.handler([fd, memory.put('a\0\n\0'), 4]), 4);
    assert.equal(text('C:\\game\\u.txt'), 'a\0\r\0\n\0', 'the handle\'s file is as it was: no BOM');
    assert.equal(fns._setmode.handler([fd, O_TEXT]), O_WTEXT);
    assert.deepEqual(errno, []);
});

test('without a handle table the two are not exported', ()=>{
    const { fns } = build();
    assert.equal(fns._get_osfhandle, undefined);
    assert.equal(fns._open_osfhandle, undefined);
    const { fns: joined } = withHandles();
    assert.deepEqual([joined._get_osfhandle.argBytes, joined._open_osfhandle.argBytes], [4, 8]);
});

test('every entry is cdecl with the argument count it reads', ()=>{
    const { fns } = build();
    const expected = {
        _open: 12, _close: 4, _read: 12, _write: 12, _lseek: 12, _fstat: 8, _stat: 8,
        _setmode: 8, _tell: 4, _eof: 4, _filelength: 4,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.deepEqual([fns[name].convention, fns[name].argBytes], ['cdecl', argBytes], name);
    }
});

test('_dup shares a file and its position; _dup2 puts one on a standard number and back', ()=>{
    // Wine's msvcrt test_std_stream_buffering: stdout sent to a file through
    // a copy of the console's descriptor, and given back to it the same way.
    const { memory, files, errno, fns, open, text, console } = withHandles();
    const fd = open('C:\\game\\dup.txt', O_CREAT | O_RDWR | O_BINARY);
    const copy = fns._dup.handler([fd]);
    assert.ok(copy > fd);
    assert.equal(fns._write.handler([fd, memory.put('ab'), 2]), 2);
    assert.equal(fns._tell.handler([copy]), 2, 'one position');
    assert.equal(fns._write.handler([copy, memory.put('c'), 1]), 1);
    assert.equal(text('C:\\game\\dup.txt'), 'abc');

    const console1 = fns._dup.handler([1]);
    assert.equal(fns._dup2.handler([fd, 1]), 0);
    assert.equal(fns._write.handler([1, memory.put('d'), 1]), 1);
    assert.equal(text('C:\\game\\dup.txt'), 'abcd', 'stdout writes to the file');
    assert.equal(fns._dup2.handler([console1, 1]), 0);
    assert.equal(fns._write.handler([1, memory.put('e'), 1]), 1);
    assert.deepEqual(console.map(([, written])=>written), ['e'], 'and to the console again');

    assert.equal(fns._close.handler([fd]), 0);
    assert.equal(fns._close.handler([copy]), 0);
    assert.equal(fns._close.handler([console1]), 0);
    assert.deepEqual(files.closed, ['C:\\game\\dup.txt'], 'closed once, by the last holder');
    assert.equal(fns._dup2.handler([0, -1]), -1, 'a target out of reach');
    assert.equal(fns._dup.handler([77]), -1, 'a number not open');
    assert.deepEqual(errno, [EBADF, EBADF]);
});

test('__pioinfo holds each descriptor of its first block as a program reads it in place', ()=>{
    // Wine's msvcrt test__open_osfhandle and test_ioinfo_flags read the
    // table directly: the handle and wxflag of a descriptor open, the
    // handle INVALID_HANDLE_VALUE and no flags once it is closed.
    const WX_OPEN = 0x01;
    const WX_TTY = 0x40;
    const WX_TEXT = 0x80;
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\game\\info.tst': new Uint8Array(0) },
        { directories: ['C:\\', 'C:\\game'] });
    const handles = fakeHandles(files);
    const TABLE = 0x80000;
    let placed = 0;
    const descriptors = createDescriptors({
        files, handles, errno: ()=>{}, writeMemory: memory.writeMemory, ioinfo: ()=>placed,
    });
    const fns = /** @type {Record<string, any>} */ (createIoFunctions({ ...memory, files },
        descriptors));
    assert.deepEqual(fns.__pioinfo.pointers, [{ at: 0, to: '__pioinfo', offset: 256 }],
        'the first pointer is to the block after the 64 of them');
    memory.writeMemory(TABLE, fns.__pioinfo.data());
    placed = TABLE;
    const view = new DataView(memory.bytes.buffer);
    /** @param {number} fd */
    const entry = fd=>({ handle: view.getInt32(TABLE + 256 + fd * 36, true),
        wxflag: memory.bytes[TABLE + 256 + fd * 36 + 4] });

    assert.deepEqual(entry(1), { handle: 2, wxflag: WX_OPEN | WX_TTY | WX_TEXT }, 'stdout');
    assert.deepEqual(entry(7), { handle: INVALID_HANDLE_VALUE, wxflag: 0 }, 'not open');

    const handle = handles.create('C:\\game\\info.tst');
    const adopted = fns._open_osfhandle.handler([handle, 0]);
    assert.deepEqual(entry(adopted), { handle, wxflag: WX_OPEN }, 'binary, on its handle');
    assert.equal(fns._close.handler([adopted]), 0);
    assert.deepEqual(entry(adopted), { handle: INVALID_HANDLE_VALUE, wxflag: 0 });

    const opened = fns._open.handler([memory.put('C:\\game\\info.tst'), O_RDWR | O_TEXT, 0]);
    assert.deepEqual(entry(opened), { handle: INVALID_HANDLE_VALUE, wxflag: WX_OPEN | WX_TEXT },
        'no handle until one is asked for');
    const asked = fns._get_osfhandle.handler([opened]);
    assert.deepEqual(entry(opened), { handle: asked, wxflag: WX_OPEN | WX_TEXT });
});
