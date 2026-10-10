/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdioFunctions } from './stdio.js';
import { createDescriptors, createIoFunctions } from './io.js';
import { fakeHandles, fakeMemory, fakeVolume } from './harness.test.js';

// The volume fake lives with the rest of the harness; other layers' tests
// import it from here.
export { fakeVolume };

/** Where the runtime's `_iob` sits, as the loader would have placed it. */
const IOB = 0x9000;

/** @param {{ late?: boolean }} [options] */
function build(options = {}){
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\data.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7]) }, options);
    /** @type {[number, string][]} */
    const console = [];
    /** @type {number[]} */
    const errno = [];
    const fns = /** @type {any} */ (createStdioFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        allocate: memory.allocate,
        free: ()=>true,
        files,
        write: (handle, text)=>console.push([handle, text]),
        iob: ()=>IOB,
        errno: code=>errno.push(code),
    }));
    return { memory, files, fns, console, errno };
}

test('a stream reads whole elements, tells its position, seeks and closes', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\data.bin');
    const mode = memory.put('rb');
    const stream = fns.fopen.handler([path, mode]);
    assert.notEqual(stream, 0);
    assert.equal(memory.bytes[stream + 16], 3,
        '_file is the first descriptor above the standard three');

    const buffer = memory.allocate(16);
    assert.equal(fns.fread.handler([buffer, 2, 2, stream]), 2, 'two elements of two');
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 4)], [1, 2, 3, 4]);
    assert.equal(fns.ftell.handler([stream]), 4);
    assert.equal(fns.fread.handler([buffer, 2, 4, stream]), 1,
        'three bytes remain: one whole element, the odd byte not counted');
    // "The file pointer ... is advanced by the number of bytes fread read":
    // the odd byte was read, so it is behind the position, not ahead of it.
    assert.equal(fns.ftell.handler([stream]), 7);

    assert.equal(fns.fseek.handler([stream, -1, 2]), 0, 'SEEK_END');
    assert.equal(fns.ftell.handler([stream]), 6);
    assert.equal(fns.fseek.handler([stream, 1, 0]), 0, 'SEEK_SET');
    assert.equal(fns.fseek.handler([stream, 2, 1]), 0, 'SEEK_CUR');
    assert.equal(fns.ftell.handler([stream]), 3);
    assert.equal(fns.fseek.handler([stream, -10, 1]), -1, 'before the start');

    assert.equal(fns.fclose.handler([stream]), 0);
    assert.deepEqual(files.closed, ['C:\\data.bin']);
    assert.equal(fns.fclose.handler([stream]), -1, 'closed twice is EOF');
    assert.equal(fns.ftell.handler([stream]), -1);
});

test('a file that is not there is null to open for reading, and made to open for writing', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\new.txt');
    assert.equal(fns.fopen.handler([path, memory.put('rb')]), 0);
    assert.equal(fns.fopen.handler([path, memory.put('x')]), 0, 'no such mode');

    const stream = fns.fopen.handler([path, memory.put('wb')]);
    assert.notEqual(stream, 0);
    const text = memory.put('hello');
    assert.equal(fns.fwrite.handler([text, 1, 5, stream]), 5);
    assert.equal(fns.fread.handler([text, 1, 5, stream]), 0, 'not open for reading');
    assert.equal(fns.fclose.handler([stream]), 0);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'hello');

    // Appending writes at the end; a second write lands after the first. The
    // position is the start until the first I/O, as ftell documents for a
    // file opened for appending.
    const again = fns.fopen.handler([path, memory.put('ab')]);
    assert.equal(fns.ftell.handler([again]), 0);
    fns.fwrite.handler([text, 5, 1, again]);
    assert.equal(fns.ftell.handler([again]), 10);
    fns.fclose.handler([again]);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'hellohello');
});

test('a read whose bytes are still on their way answers when they arrive', async()=>{
    const { memory, fns } = build({ late: true });
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('r')]);
    const buffer = memory.allocate(16);
    const answer = fns.fread.handler([buffer, 1, 3, stream]);
    assert.equal(typeof answer.then, 'function', 'the caller parks on it');
    assert.equal(await answer, 3);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 3)], [1, 2, 3]);
    assert.equal(fns.ftell.handler([stream]), 3);
});

test('every entry is cdecl with the argument count it reads', ()=>{
    const { fns } = build();
    const expected = { fopen: 8, fclose: 4, fread: 16, fwrite: 16, fseek: 12, ftell: 4 };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fns[name].convention, 'cdecl', name);
        assert.equal(fns[name].argBytes, argBytes, name);
    }
});

test('fprintf formats and writes to the stream, not to stdout', ()=>{
    const { memory, files, fns } = build();
    const path = memory.put('C:\\new.txt');
    const stream = fns.fopen.handler([path, memory.put('wb')]);
    const format = memory.put('%s scored %d%%');
    const name = memory.put('player');

    assert.equal(fns.fprintf.handler([stream, format, name, 90]), 17);
    assert.equal(fns.ftell.handler([stream]), 17);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'player scored 90%');
});

test('fprintf reads %ls as a wide string, stopping where the C locale has no byte', ()=>{
    const { memory, files, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\new.txt'), memory.put('wb')]);
    const format = memory.put('%ls|%S');
    assert.equal(fns.fprintf.handler([stream, format, memory.putWide('caf\xe9'),
        memory.putWide('ab\u263acd')]), 7);
    assert.equal(String.fromCharCode(...files.files['C:\\new.txt']), 'caf\xe9|ab');
});

test('a stream is written the bytes of the strings and format it was given', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash; fputs and fprintf
    // put them in the file as the bytes they were, and so is a %c.
    const { memory, files, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\new.txt'), memory.put('wb')]);
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = memory.allocate(bytes.length + 1);
        memory.writeMemory(at, Uint8Array.from([...bytes, 0]));
        return at;
    };
    assert.ok(fns.fputs.handler([place([0x80, 0x99]), stream]) >= 0);
    assert.equal(fns.fprintf.handler([stream, place([0x97, 0x25, 0x73, 0x25, 0x63]),
        place([0xe9, 0x80]), 0x99]), 4);
    assert.deepEqual([...files.files['C:\\new.txt']], [0x80, 0x99, 0x97, 0xe9, 0x80, 0x99]);
});

test('fprintf on a stream not open for writing is a negative count, nothing written', ()=>{
    const { memory, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    const before = fns.ftell.handler([stream]);

    assert.equal(fns.fprintf.handler([stream, memory.put('%d'), 5]), -1);
    assert.equal(fns.ftell.handler([stream]), before, 'the position did not move');
});

test('fprintf on a stream that is not one is a negative count', ()=>{
    const { memory, fns } = build();
    assert.equal(fns.fprintf.handler([0x999, memory.put('x'), 0]), -1);
});

test('setvbuf accepts a stream and a real mode, and the record says the size asked for', ()=>{
    // `_bufsiz` is what a program reads to size its own writes, Wine's
    // test_write_flush among them: msvcrt's 4096 from fopen, setvbuf's
    // size after it.
    const { memory, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    const IONBF = 0x0004;
    const IOFBF = 0x0000;
    const IOLBF = 0x0040;
    const FILE_BUFSIZ = 24;
    const bufsiz = ()=>new DataView(memory.bytes.buffer).getUint32(stream + FILE_BUFSIZ, true);
    assert.equal(bufsiz(), 4096);

    assert.equal(fns.setvbuf.handler([stream, 0, IONBF, 0]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, IOFBF, 512]), 0);
    assert.equal(bufsiz(), 512);
    assert.equal(fns.setvbuf.handler([stream, 0, IOLBF, 512]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, 0x1234, 0]), -1, 'not a mode this runtime has');
    assert.equal(fns.setvbuf.handler([0x999, 0, IONBF, 0]), -1, 'not a stream at all');
});

test('_iob is the records themselves, the standard three first, each naming its descriptor', ()=>{
    const { fns } = build();
    const bytes = fns._iob.data();
    const view = new DataView(bytes.buffer);

    assert.equal(bytes.length, 20 * 32, 'twenty records');
    assert.deepEqual([0, 1, 2].map(index=>view.getUint32(index * 32 + 16, true)), [0, 1, 2]);
    assert.deepEqual([0, 1, 2].map(index=>view.getUint32(index * 32 + 12, true)),
        [0x1, 0x2, 0x2], 'stdin reads, stdout and stderr write');
    assert.equal(fns.__iob_func.handler([]), IOB);
    assert.equal(fns.__p__iob.handler([]), IOB);
});

test('stdout and stderr write to the console; stdin is at its end', ()=>{
    const { memory, fns, console } = build();
    const text = memory.put('%s=%d');
    const name = memory.put('x');
    const bytes = memory.put('hey');

    assert.equal(fns.fprintf.handler([IOB + 32, text, name, 3]), 3);
    assert.equal(fns.fwrite.handler([bytes, 1, 3, IOB + 64]), 3);
    assert.deepEqual(console, [[2, 'x=3'], [3, 'hey']], 'the standard handles, 2 and 3');

    const buffer = memory.allocate(4);
    assert.equal(fns.fread.handler([buffer, 1, 1, IOB]), 0);
    assert.equal(fns.fseek.handler([IOB + 32, 0, 0]), -1, 'the console does not seek');
    assert.equal(fns.fclose.handler([IOB + 32]), 0, 'and is not the program\'s to free');
    assert.equal(fns.fprintf.handler([IOB + 96, text, name, 3]), -1,
        'the fourth record is no stream until something opens one');
});

test('putchar writes to stdout and getchar reads stdin, through their records', ()=>{
    const { fns, console, memory } = build();
    assert.equal(fns.putchar.handler([0x78]), 0x78);
    assert.equal(fns.putchar.handler([0x141]), 0x41, 'the byte, as an unsigned char');
    assert.deepEqual(console, [[2, 'x'], [2, 'A']]);

    assert.equal(fns.getchar.handler([]), -1, 'the console has nothing to type');
    assert.equal(memory.u32(IOB + 12) & 0x10, 0x10, 'and stdin\'s record says it is at its end');
    assert.deepEqual([fns.getchar.argBytes, fns.putchar.argBytes], [0, 4]);
});

test('getchar and putchar are EOF before the runtime\'s streams are placed', ()=>{
    const memory = fakeMemory();
    const fns = /** @type {any} */ (createStdioFunctions({
        ...memory, free: ()=>true, files: fakeVolume({}), write: ()=>{}, iob: ()=>0,
    }));
    assert.equal(fns.getchar.handler([]), -1);
    assert.equal(fns.putchar.handler([0x78]), -1);
});

test('fopen and fclose say why they failed in errno', ()=>{
    // fopen: a missing file is ENOENT; a null or empty name and a mode that is
    // not one are invalid parameters. fclose: a null stream is EINVAL, a
    // stream closed already fails without touching errno (Wine's msvcrt file
    // tests, test_fopen_fclose_fcloseall).
    const { memory, fns, errno } = build();
    const ENOENT = 2;
    const EINVAL = 22;

    assert.equal(fns.fopen.handler([memory.put('C:\\none.txt'), memory.put('r')]), 0);
    assert.deepEqual(errno.splice(0), [ENOENT]);
    assert.equal(fns.fopen.handler([memory.put(''), memory.put('w+')]), 0);
    assert.equal(fns.fopen.handler([0, memory.put('w+')]), 0);
    assert.equal(fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('x')]), 0);
    assert.equal(fns.fopen.handler([memory.put('C:\\data.bin'), 0]), 0);
    assert.deepEqual(errno.splice(0), [EINVAL, EINVAL, EINVAL, EINVAL]);

    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    assert.equal(fns.fclose.handler([stream]), 0);
    assert.equal(fns.fclose.handler([stream]), -1);
    assert.deepEqual(errno, [], 'a second close leaves errno alone');
    assert.equal(fns.fclose.handler([0]), -1);
    assert.deepEqual(errno, [EINVAL]);
});

/** `_flag` bits and the record's fields a macro reads. */
const IOEOF = 0x10;
const IOERR = 0x20;
const CNT = 4;
const FLAG = 12;
const EOF = -1;

/** @param {string} text */
const bytesOf = text=>Uint8Array.from(text, character=>character.charCodeAt(0));

/**
 * The streams and the low-level calls over one descriptor table, as the
 * runtime assembles them, on a volume holding `contents`.
 *
 * @param {Record<string, string>} contents
 * @param {{ fmode?: number }} [options]
 */
function runtime(contents, { fmode = 0 } = {}){
    const memory = fakeMemory();
    const files = fakeVolume(Object.fromEntries(Object.entries(contents).map(([name, value])=>
        [name, bytesOf(value)])));
    /** @type {number[]} */
    const errno = [];
    /** @param {number} code */
    const record = code=>{
        errno.push(code);
    };
    /** @type {[number, string][]} */
    const console = [];
    const descriptors = createDescriptors({
        files, errno: record, fmode: ()=>fmode, write: (handle, text)=>console.push([handle, text]),
    });
    /** @type {number[]} */
    const freed = [];
    const host = {
        ...memory, free: (/** @type {number} */ at)=>freed.push(at) > 0, files, iob: ()=>IOB,
        errno: record,
        varargs: (/** @type {number} */ list)=>
            Array.from({ length: 8 }, (_, slot)=>memory.u32(list + slot * 4)),
    };
    const fns = /** @type {Record<string, any>} */ ({
        ...createIoFunctions(host, descriptors),
        ...createStdioFunctions({ ...host, descriptors }),
    });
    /** @param {string} name @param {string} mode */
    const open = (name, mode)=>fns.fopen.handler([memory.put(name), memory.put(mode)]);
    const line = memory.allocate(512);
    /** @param {number} stream @param {number} [count] */
    const gets = (stream, count = 512)=>{
        const got = fns.fgets.handler([line, count, stream]);
        return got === 0 ? null : memory.text(line);
    };
    /** @param {number} stream */
    const flag = stream=>memory.u32(stream + FLAG);
    /** @param {string} name */
    const text = name=>String.fromCharCode(...files.files[name]);
    return { memory, files, fns, errno, open, gets, flag, text, console, freed };
}

test('the end of the file and an error reach the record\'s _flag, where the macros read them', ()=>{
    // feof and ferror are macros over _flag as much as they are functions:
    // `while (!feof(f))` compiled against the header never calls us.
    const { memory, fns, open, flag } = runtime({ 'C:\\five.bin': 'abcde' });
    const stream = open('C:\\five.bin', 'rb');
    const buffer = memory.allocate(64);

    assert.equal(fns.fread.handler([buffer, 1, 5, stream]), 5);
    assert.equal(flag(stream) & IOEOF, 0, 'all five read, and nothing past them yet');
    assert.equal(fns.fread.handler([buffer, 1, 64, stream]), 0);
    assert.equal(flag(stream) & IOEOF, IOEOF);
    assert.notEqual(fns.feof.handler([stream]), 0);

    fns.clearerr.handler([stream]);
    assert.equal(flag(stream) & IOEOF, 0, 'clearerr clears it in the record');
    fns.fread.handler([buffer, 1, 64, stream]);
    assert.equal(fns.fseek.handler([stream, 0, 0]), 0);
    assert.equal(flag(stream) & IOEOF, 0, 'and so does a seek');

    assert.equal(fns.fputc.handler([0x41, stream]), EOF, 'not open for writing');
    assert.equal(flag(stream) & IOERR, IOERR);
    assert.notEqual(fns.ferror.handler([stream]), 0);
    fns.rewind.handler([stream]);
    assert.equal(flag(stream) & (IOERR | IOEOF), 0, 'rewind clears both');
    assert.equal(flag(stream) & 0x1, 0x1, 'and the mode bits stay');
});

test('_filbuf and _flsbuf answer the getc and putc macros and put _cnt back at zero', ()=>{
    // The macros count _cnt down first and call these at -1; Wine's msvcrt
    // test_flsbuf pins the answers, including 0xff for 0xffffffff.
    const { memory, fns, open, flag, text } = runtime({ 'C:\\in.bin': 'hi' });
    const input = open('C:\\in.bin', 'rb');
    memory.setU32(input + CNT, -1);
    assert.equal(fns._filbuf.handler([input]), 0x68);
    assert.equal(memory.i32(input + CNT), 0);
    memory.setU32(input + CNT, -1);
    assert.equal(fns._filbuf.handler([input]), 0x69);
    assert.equal(fns._filbuf.handler([input]), EOF);
    assert.equal(flag(input) & IOEOF, IOEOF);

    const output = open('C:\\out.bin', 'wb');
    memory.setU32(output + CNT, 1234);
    assert.equal(fns._flsbuf.handler([0, output]), 0);
    assert.equal(memory.i32(output + CNT), 0);
    assert.equal(fns._flsbuf.handler([0xff, output]), 0xff);
    assert.equal(fns._flsbuf.handler([0xffffffff, output]), 0xff);
    assert.equal(fns.putc.handler([0x51, output]), 0x51);
    fns.fclose.handler([output]);
    assert.equal(text('C:\\out.bin'), '\x00\xff\xffQ');

    assert.equal(fns._flsbuf.handler([0, input]), EOF, 'a stream opened for reading');
    assert.equal(flag(input) & IOERR, IOERR);
});

test('fgetc reads to EOF, and ungetc gives a byte back but never EOF', ()=>{
    // Wine's msvcrt test_fileops.
    const outbuffer = '0,1,2,3,4,5,6,7,8,9\0';
    const { fns, open } = runtime({ 'C:\\ops.tst': outbuffer });
    const file = open('C:\\ops.tst', 'rb');

    let read = '';
    for (let at = 0; at < outbuffer.length; at++)
    {
        read += String.fromCharCode(fns.fgetc.handler([file]));
    }
    assert.equal(read, outbuffer);
    const c = fns.getc.handler([file]);
    assert.equal(c, EOF);
    assert.notEqual(fns.feof.handler([file]), 0);
    assert.equal(fns.ungetc.handler([c, file]), EOF, 'EOF cannot be given back');
    assert.notEqual(fns.feof.handler([file]), 0, 'and giving it back changes nothing');
    assert.equal(fns.fgetc.handler([file]), EOF);

    assert.equal(fns.ungetc.handler([0x39, file]), 0x39);
    assert.equal(fns.feof.handler([file]), 0, 'a byte given back is not the end');
    assert.equal(fns.ftell.handler([file]), outbuffer.length - 1);
    assert.equal(fns.fgetc.handler([file]), 0x39);
    assert.equal(fns.feof.handler([file]), 0);
    assert.equal(fns.fgetc.handler([file]), EOF);
    assert.notEqual(fns.feof.handler([file]), 0);

    fns.ungetc.handler([0x39, file]);
    assert.equal(fns.fflush.handler([file]), 0);
    assert.equal(fns.fgetc.handler([file]), EOF, 'fflush forgets what ungetc gave back');
    assert.equal(fns.fflush.handler([0]), 0, 'every stream');
});

test('fgets stops after a line feed or at count - 1, and NULL is the end', ()=>{
    // Wine's msvcrt test_fileops: a file without a line feed, NUL-terminated.
    const outbuffer = '0,1,2,3,4,5,6,7,8,9\0';
    const { fns, open, gets } = runtime({ 'C:\\ops.tst': outbuffer, 'C:\\lines.txt': 'ab\ncd' });
    const file = open('C:\\ops.tst', 'rb');

    assert.equal(gets(file), outbuffer.slice(0, -1));
    assert.equal(gets(file), null);
    assert.notEqual(fns.feof.handler([file]), 0);
    fns.rewind.handler([file]);
    assert.equal(gets(file, outbuffer.length - 1)?.length, outbuffer.length - 2);
    assert.equal(gets(file, outbuffer.length), '9', 'the last digit, then the NUL');

    const lines = open('C:\\lines.txt', 'rb');
    assert.equal(gets(lines), 'ab\n');
    assert.equal(fns.feof.handler([lines]), 0, 'a line that ends in a line feed is not the end');
    assert.equal(gets(lines), 'cd');
    assert.notEqual(fns.feof.handler([lines]), 0, 'one that runs into the end is');
    assert.equal(gets(lines, 1), '', 'room for the terminator alone reads nothing');
});

test('text mode reads CR LF as LF and stops at ^Z; binary mode reads what is there', ()=>{
    // Wine's msvcrt test_asciimode and test_ctrlz.
    const { memory, fns, open, gets } = runtime({
        'C:\\crcrlf.tst': '\r\r\n',
        'C:\\foo.tst': 'foo\x1a' + '\0'.repeat(65536) + 'bar',
        'C:\\ctrlz.tst': 'This is test_ctrlz\x1a\r\na',
    });
    const buffer = memory.allocate(64);

    const crlf = open('C:\\crcrlf.tst', 'rt');
    assert.equal(gets(crlf), '\r\n');
    fns.rewind.handler([crlf]);
    assert.equal(fns.fread.handler([buffer, 1, 64, crlf]), 2);
    assert.equal(memory.text(buffer).slice(0, 2), '\r\n');

    const foo = open('C:\\foo.tst', 'rt');
    assert.equal(gets(foo), 'foo');
    assert.equal(gets(foo), null, 'nothing after the ^Z');
    fns.rewind.handler([foo]);
    assert.equal(fns.fread.handler([buffer, 1, 64, foo]), 3);
    assert.equal(fns.fread.handler([buffer, 1, 64, foo]), 0);

    const ctrlz = open('C:\\ctrlz.tst', 'rt');
    assert.equal(gets(ctrlz), 'This is test_ctrlz');
    assert.equal(fns.ftell.handler([ctrlz]), 22, 'the true end of the file');
    assert.notEqual(fns.feof.handler([ctrlz]), 0);
    const binary = open('C:\\ctrlz.tst', 'rb');
    assert.equal(gets(binary), 'This is test_ctrlz\x1a\r\n');
    assert.equal(fns.ftell.handler([binary]), 21);
    assert.equal(gets(binary), 'a');
    assert.notEqual(fns.feof.handler([binary]), 0);
});

test('in text mode ftell and fseek count the bytes of the file', ()=>{
    // Wine's msvcrt test_asciimode: ten "n\r\n" lines, read with "r".
    const lines = [...'0123456789'].map(digit=>`${digit}\r\n`).join('');
    const { fns, open } = runtime({ 'C:\\ascii.tst': lines });
    const fp = open('C:\\ascii.tst', 'r');
    assert.equal(fns.fgetc.handler([fp]), 0x30);
    assert.equal(fns.fgetc.handler([fp]), 0x0a);
    for (let i = 1; i < 10; i++)
    {
        assert.equal(fns.ftell.handler([fp]), i * 3);
        fns.fseek.handler([fp, 0, 1]);
        assert.equal(fns.fgetc.handler([fp]), 0x30 + i);
        assert.equal(fns.fgetc.handler([fp]), 0x0a);
    }
    fns.rewind.handler([fp]);
    assert.equal(fns.fgetc.handler([fp]), 0x30);
    fns.fseek.handler([fp, 2, 1]);
    assert.equal(fns.fgetc.handler([fp]), 0x31, 'fseek does not skip a CR');
    fns.fseek.handler([fp, 9 * 3, 0]);
    assert.equal(fns.fgetc.handler([fp]), 0x39);
    fns.fseek.handler([fp, -4, 1]);
    assert.equal(fns.fgetc.handler([fp]), 0x38);
});

test('text mode writes LF as CR LF; binary mode leaves it alone', ()=>{
    // Wine's msvcrt test_file_put_get.
    const mytext = 'This is a test_file_put_get\n';
    const dostext = 'This is a test_file_put_get\r\n';
    const { fns, open, gets, text, memory } = runtime({});

    const wt = open('C:\\put.tst', 'wt');
    assert.equal(fns.fputs.handler([memory.put(mytext), wt]), 0);
    fns.fclose.handler([wt]);
    assert.equal(text('C:\\put.tst'), dostext);
    assert.equal(gets(open('C:\\put.tst', 'rb')), dostext);
    assert.equal(gets(open('C:\\put.tst', 'rt')), mytext);

    const wb = open('C:\\put.tst', 'wb');
    fns.fputs.handler([memory.put(mytext), wb]);
    fns.fputc.handler([0x0a, wb]);
    fns.fclose.handler([wb]);
    assert.equal(text('C:\\put.tst'), mytext + '\n');

    const w = open('C:\\put.tst', 'w');
    assert.equal(fns.fprintf.handler([w, memory.put('%d\n'), 7]), 2, 'the characters formatted');
    assert.equal(fns.fwrite.handler([memory.put('a\nb'), 1, 3, w]), 3);
    fns.fclose.handler([w]);
    assert.equal(text('C:\\put.tst'), '7\r\na\r\nb');
});

test('a mode naming neither text nor binary follows _fmode', ()=>{
    const O_BINARY = 0x8000;
    const dostext = 'line\r\n';
    const text = runtime({ 'C:\\a.txt': dostext });
    assert.equal(text.gets(text.open('C:\\a.txt', 'r')), 'line\n');
    const binary = runtime({ 'C:\\a.txt': dostext }, { fmode: O_BINARY });
    assert.equal(binary.gets(binary.open('C:\\a.txt', 'r')), dostext);
    assert.equal(binary.gets(binary.open('C:\\a.txt', 'rt')), 'line\n');
});

test('_fileno is the descriptor the low-level calls take, at one position', ()=>{
    // Wine's msvcrt test_flsbuf reads a stream's position with
    // _lseek(_fileno(f), 0, SEEK_CUR).
    const { memory, fns, open } = runtime({ 'C:\\data.bin': 'abcdef' });
    const stream = open('C:\\data.bin', 'rb');
    const fd = fns._fileno.handler([stream]);
    assert.equal(fd, 3);
    assert.equal(memory.u32(stream + 16), fd, 'the record\'s _file says the same');
    fns.fgetc.handler([stream]);
    fns.fgetc.handler([stream]);
    assert.equal(fns._lseek.handler([fd, 0, 1]), 2);
    assert.equal(fns._lseek.handler([fd, 4, 0]), 4);
    assert.equal(fns.fgetc.handler([stream]), 0x65, 'the stream reads on from there');
    assert.equal(fns._fileno.handler([IOB + 32]), 1, 'stdout');

    const other = fns._open.handler([memory.put('C:\\data.bin'), 0, 0]);
    assert.equal(other, 4, 'fopen and _open number from one table');
});

test('stdin is at its end for getc, and the record says so', ()=>{
    const { fns, flag } = runtime({});
    assert.equal(fns.getc.handler([IOB]), EOF);
    assert.equal(flag(IOB) & IOEOF, IOEOF);
});

test('fgetpos stores the position as an fpos_t, and fsetpos goes back to it', ()=>{
    // Wine's msvcrt test_fileops: a position read and set again, and a
    // stream at its end no longer at it once fsetpos has moved it.
    const outbuffer = '0,1,2,3,4,5,6,7,8,9\0';
    const { memory, fns, open, flag } = runtime({ 'C:\\ops.tst': outbuffer });
    const file = open('C:\\ops.tst', 'rb');
    const pos = memory.allocate(8);
    const view = new DataView(memory.bytes.buffer, pos, 8);
    memory.writeMemory(pos, new Uint8Array(8).fill(0xcc));

    assert.equal(fns.fgetpos.handler([file, pos]), 0);
    assert.equal(view.getBigInt64(0, true), 0n, 'all eight bytes');
    view.setBigInt64(0, BigInt(outbuffer.length), true);
    assert.equal(fns.fsetpos.handler([file, pos]), 0);
    assert.equal(fns.fgetpos.handler([file, pos]), 0);
    assert.equal(view.getBigInt64(0, true), BigInt(outbuffer.length));
    assert.equal(fns.ftell.handler([file]), outbuffer.length);

    fns.rewind.handler([file]);
    const buffer = memory.allocate(256);
    fns.fread.handler([buffer, 256, 1, file]);
    assert.equal(flag(file) & IOEOF, IOEOF);
    fns.fgetpos.handler([file, pos]);
    assert.equal(fns.fsetpos.handler([file, pos]), 0);
    assert.equal(flag(file) & IOEOF, 0, 'fsetpos clears the end of the file');

    view.setBigInt64(0, 4n, true);
    fns.ungetc.handler([0x41, file]);
    fns.fsetpos.handler([file, pos]);
    assert.equal(fns.fgetc.handler([file]), 0x32, 'and forgets what ungetc gave back');
});

test('fgetpos and fsetpos refuse a null argument, and fsetpos a position before the start', ()=>{
    const { memory, fns, open, errno } = runtime({ 'C:\\data.bin': 'abc' });
    const file = open('C:\\data.bin', 'rb');
    const pos = memory.allocate(8);
    const EINVAL = 22;

    assert.notEqual(fns.fgetpos.handler([file, 0]), 0);
    assert.notEqual(fns.fgetpos.handler([0, pos]), 0);
    assert.notEqual(fns.fsetpos.handler([file, 0]), 0);
    assert.notEqual(fns.fsetpos.handler([0, pos]), 0);
    new DataView(memory.bytes.buffer, pos, 8).setBigInt64(0, -1n, true);
    assert.notEqual(fns.fsetpos.handler([file, pos]), 0);
    assert.deepEqual(errno, [EINVAL, EINVAL, EINVAL, EINVAL, EINVAL]);
    assert.equal(fns.ftell.handler([file]), 0, 'the position did not move');
});

test('freopen closes the stream\'s file and opens another in the same record', ()=>{
    // Wine's msvcrt test_freopen.
    const { memory, fns, open, errno, freed } = runtime({ 'C:\\A': '1', 'C:\\B': '2' });
    const buffer = memory.allocate(4);
    /** @param {string} name @param {string} mode @param {number} stream */
    const reopen = (name, mode, stream)=>
        fns.freopen.handler([memory.put(name), memory.put(mode), stream]);

    const file = open('C:\\A', 'rt');
    assert.equal(reopen('C:\\B', 'rt', file), file);
    assert.equal(fns.fread.handler([buffer, 1, 1, file]), 1);
    assert.equal(memory.bytes[buffer], 0x32);
    assert.equal(fns.fclose.handler([file]), 0);

    const appending = open('C:\\A', 'at');
    assert.equal(reopen('C:\\A', 'rt', appending), appending);
    assert.equal(fns.ftell.handler([appending]), 0);
    assert.equal(fns.fgetc.handler([appending]), 0x31, 'open for reading now');
    fns.fclose.handler([appending]);

    const failing = open('C:\\A', 'rt');
    const fd = fns._fileno.handler([failing]);
    freed.length = 0;
    assert.equal(reopen('C:\\none\\x', 'rt', failing), 0);
    assert.equal(fns._read.handler([fd, buffer, 1]), -1, 'the old file is closed either way');
    assert.deepEqual(errno.splice(0), [2, 9]);
    assert.deepEqual(freed, [failing], 'and the stream with it');
    assert.equal(fns.fclose.handler([failing]), -1);
    assert.deepEqual(errno, [], 'a stream closed already leaves errno alone');

    const closedUnder = open('C:\\A', 'rb');
    fns._close.handler([fns._fileno.handler([closedUnder])]);
    assert.equal(reopen('C:\\B', 'rb', closedUnder), closedUnder,
        'a stream whose descriptor was closed under it is still reopened');
    assert.equal(fns.fgetc.handler([closedUnder]), 0x32);
    assert.equal(memory.u32(closedUnder + 16), fns._fileno.handler([closedUnder]));
});

test('freopen refuses a null or empty name, a null stream and a mode that is not one', ()=>{
    const { memory, fns, open, errno } = runtime({ 'C:\\A': '1' });
    const file = open('C:\\A', 'r');
    assert.equal(fns.freopen.handler([0, memory.put('r'), file]), 0);
    assert.equal(fns.freopen.handler([memory.put(''), memory.put('r'), file]), 0);
    assert.equal(fns.freopen.handler([memory.put('C:\\A'), memory.put('x'), file]), 0);
    assert.equal(fns.freopen.handler([memory.put('C:\\A'), 0, file]), 0);
    assert.equal(fns.freopen.handler([memory.put('C:\\A'), memory.put('r'), 0]), 0);
    assert.deepEqual(errno, Array(5).fill(22));
    assert.equal(fns.fgetc.handler([file]), 0x31, 'and leaves the stream as it was');
});

test('freopen moves stdout to a file, and fclose puts it back on the console', ()=>{
    const { memory, fns, text, console } = runtime({});
    const stdout = IOB + 32;
    assert.equal(fns.freopen.handler([memory.put('C:\\log.txt'), memory.put('w'), stdout]),
        stdout);
    fns.fprintf.handler([stdout, memory.put('%d\n'), 7]);
    fns.putchar.handler([0x21]);
    assert.equal(text('C:\\log.txt'), '7\r\n!');
    assert.deepEqual(console, []);
    assert.equal(memory.u32(stdout + 16), 1,
        'the stream keeps its number, which the file now holds, as on Windows');

    assert.equal(fns.fclose.handler([stdout]), 0);
    fns.putchar.handler([0x3f]);
    assert.deepEqual(console, [[2, '?']]);
    assert.equal(memory.u32(stdout + 16), 1);
    assert.equal(text('C:\\log.txt'), '7\r\n!', 'the file was closed with what it had');
});

test('_fdopen puts a stream on a descriptor, which fclose then closes', ()=>{
    // Wine's msvcrt test_fdopen: the stream reads on from where the
    // descriptor already was.
    const { memory, files, fns, errno } = runtime({
        'C:\\fdopen.tst': '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09',
    });
    const fd = fns._open.handler([memory.put('C:\\fdopen.tst'), 0x8000, 0]);
    fns._lseek.handler([fd, 5, 0]);
    const file = fns._fdopen.handler([fd, memory.put('rb')]);
    assert.notEqual(file, 0);
    assert.equal(memory.u32(file + 16), fd);
    const buffer = memory.allocate(16);
    assert.equal(fns.fread.handler([buffer, 1, 10, file]), 5);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 5)], [5, 6, 7, 8, 9]);
    assert.equal(fns.fclose.handler([file]), 0);
    assert.deepEqual(files.closed, ['C:\\fdopen.tst']);
    assert.equal(fns._close.handler([fd]), -1, 'the descriptor went with the stream');
    errno.length = 0;

    assert.equal(fns._fdopen.handler([77, memory.put('r')]), 0);
    assert.equal(fns._fdopen.handler([1, memory.put('x')]), 0);
    assert.equal(fns._fdopen.handler([1, 0]), 0);
    assert.deepEqual(errno, [9, 22, 22]);
});

test('_fdopen keeps the descriptor\'s own translation, whatever the mode says', ()=>{
    const { memory, fns } = runtime({ 'C:\\t.txt': 'a\r\nb' });
    const text = fns._open.handler([memory.put('C:\\t.txt'), 0x4000, 0]);
    const stream = fns._fdopen.handler([text, memory.put('rb')]);
    const buffer = memory.allocate(16);
    assert.equal(fns.fread.handler([buffer, 1, 16, stream]), 3);
    assert.equal(memory.text(buffer).slice(0, 3), 'a\nb');
});

test('a file fopen opened with D in its mode is removed when the stream closes', ()=>{
    const { memory, files, fns, open, gets } = runtime({ 'C:\\keep.txt': 'k' });
    const scratch = open('C:\\scratch.tmp', 'w+D');
    assert.equal(fns.fputs.handler([memory.put('line\n'), scratch]), 0);
    fns.rewind.handler([scratch]);
    assert.equal(gets(scratch), 'line\n', 'it reads and writes like any other');
    assert.equal(fns.fclose.handler([scratch]), 0);
    assert.equal(files.files['C:\\scratch.tmp'], undefined);

    const another = open('C:\\another.tmp', 'wbD');
    const kept = open('C:\\keep.txt', 'r');
    assert.equal(fns._fcloseall.handler([]), 2);
    assert.equal(files.files['C:\\another.tmp'], undefined, '_fcloseall removes one too');
    assert.ok(files.files['C:\\keep.txt']);
    assert.notEqual(another, kept);
});

test('_fcloseall closes every stream but the standard three and counts them', ()=>{
    // Wine's msvcrt test_fopen_fclose_fcloseall.
    const { memory, fns, open, files, console } = runtime({});
    const stream1 = open('C:\\empty1', 'w+');
    const stream2 = open('C:\\empty2', 'w ');
    const stream3 = open('C:\\empty3', 'w+');
    assert.equal(fns.fclose.handler([stream2]), 0);
    assert.equal(fns.fclose.handler([stream3]), 0);
    fns.fputc.handler([0x61, IOB + 32]);
    const log = fns.freopen.handler([memory.put('C:\\log'), memory.put('w'), IOB + 64]);

    assert.equal(fns._fcloseall.handler([]), 1);
    assert.equal(fns._fcloseall.handler([]), 0);
    assert.deepEqual(files.closed, ['C:\\empty2', 'C:\\empty3', 'C:\\empty1']);
    assert.equal(fns.fputc.handler([0x62, stream1]), -1, 'the one left open is closed');
    assert.equal(fns.fputc.handler([0x63, IOB + 32]), 0x63, 'stdout is not');
    assert.equal(fns.fputc.handler([0x64, log]), 0x64, 'nor stderr, wherever it was moved');
    assert.deepEqual(console, [[2, 'a'], [2, 'c']]);
});

test('_flushall forgets what ungetc gave back and counts the streams open', ()=>{
    // Wine's msvcrt test_fflush: _flushall clears what a stream holds for
    // reading, so the next read comes from where the descriptor now is.
    const { memory, fns, open } = runtime({ 'C:\\a.bin': 'abc', 'C:\\b.bin': 'xyz' });
    const a = open('C:\\a.bin', 'rb');
    const b = open('C:\\b.bin', 'rb');
    fns.fgetc.handler([a]);
    fns.ungetc.handler([0x5a, a]);
    fns.ungetc.handler([0x5a, b]);
    assert.equal(fns._flushall.handler([]), 5, 'the standard three and the two opened');
    assert.equal(fns.fgetc.handler([a]), 0x62);
    assert.equal(fns.fgetc.handler([b]), 0x78);

    fns.fclose.handler([b]);
    assert.equal(fns._flushall.handler([]), 4);
    fns.fputs.handler([memory.put('still open'), IOB + 32]);
    assert.equal(fns._flushall.handler([]), 4);
});

test('a stream on a descriptor on a handle: fclose closes all three', ()=>{
    // The way a program puts stdio over a file it opened with CreateFile, or
    // over the console handle AllocConsole gave it.
    const memory = fakeMemory();
    const files = fakeVolume({ 'C:\\save.dat': new Uint8Array(0) });
    const handles = fakeHandles(files);
    /** @type {[number, string][]} */
    const console = [];
    const descriptors = createDescriptors({
        files, handles, write: (handle, text)=>console.push([handle, text]),
    });
    const host = { ...memory, free: ()=>true, files, iob: ()=>IOB };
    const fns = /** @type {Record<string, any>} */ ({
        ...createIoFunctions(host, descriptors),
        ...createStdioFunctions({ ...host, descriptors }),
    });

    const handle = handles.create('C:\\save.dat');
    const stream = fns._fdopen.handler([fns._open_osfhandle.handler([handle, 0]), memory.put('w')]);
    assert.equal(fns.fputs.handler([memory.put('level 3\n'), stream]), 0);
    assert.equal(handles.file(handle).position, 8, 'the handle is where the stream is');
    assert.equal(fns.fclose.handler([stream]), 0);
    assert.equal(handles.file(handle), null);
    assert.equal(String.fromCharCode(...files.files['C:\\save.dat']), 'level 3\n');

    const STD_OUTPUT = 2;
    const O_TEXT = 0x4000;
    const out = fns._fdopen.handler([fns._open_osfhandle.handler([STD_OUTPUT, O_TEXT]),
        memory.put('w')]);
    fns.fprintf.handler([out, memory.put('%d'), 42]);
    assert.deepEqual(console, [[2, '42']]);
});

test('the narrow stream calls refuse a stream whose descriptor is in a Unicode mode', ()=>{
    // "Use of a narrow print function on a Unicode mode stream triggers an
    // assert": an error on the stream and EINVAL, and nothing written.
    const O_U16TEXT = 0x20000;
    const { memory, fns, open, flag, errno, files } = runtime({ 'C:\\u.txt': 'ab' });
    const out = open('C:\\n.txt', 'w');
    fns._setmode.handler([fns._fileno.handler([out]), O_U16TEXT]);
    assert.equal(fns.fputs.handler([memory.put('x'), out]), EOF);
    assert.equal(flag(out) & IOERR, IOERR);
    assert.equal(files.files['C:\\n.txt'].length, 0);

    const input = open('C:\\u.txt', 'r');
    fns._setmode.handler([fns._fileno.handler([input]), O_U16TEXT]);
    assert.equal(fns.fgetc.handler([input]), EOF);
    assert.equal(flag(input) & IOERR, IOERR);
    assert.deepEqual(errno, [22, 22]);
});

test('fwrite and fread on a stream in a Unicode mode carry UTF-16 through the translation', ()=>{
    // fwrite's buffer "is interpreted as a pointer to an array of wchar_t
    // that contains UTF-16 data", an odd count a parameter validation error;
    // fread reads it back folded (Wine's msvcrt test_fopen_s).
    const O_U16TEXT = 0x20000;
    const { memory, fns, open, errno, files } = runtime({});
    const out = open('C:\\u.txt', 'w');
    fns._setmode.handler([fns._fileno.handler([out]), O_U16TEXT]);
    assert.equal(fns.fwrite.handler([memory.put('a\0\n\0'), 1, 4, out]), 4);
    assert.equal(fns.fwrite.handler([memory.put('b'), 1, 1, out]), 0);
    assert.deepEqual(errno.splice(0), [22]);
    fns.fclose.handler([out]);
    assert.deepEqual([...files.files['C:\\u.txt']], [0x61, 0, 0x0d, 0, 0x0a, 0]);

    const input = open('C:\\u.txt', 'r');
    fns._setmode.handler([fns._fileno.handler([input]), O_U16TEXT]);
    const buffer = memory.allocate(16);
    assert.equal(fns.fread.handler([buffer, 1, 16, input]), 4);
    assert.deepEqual([...memory.bytes.subarray(buffer, buffer + 4)], [0x61, 0, 0x0a, 0]);
    assert.deepEqual(errno, []);
});

test('vfprintf is fprintf from a va_list', ()=>{
    const { memory, fns, open, text } = runtime({});
    const out = open('C:\\log.txt', 'w');
    const list = memory.allocate(8);
    memory.setU32(list, memory.put('level'));
    memory.setU32(list + 4, 3);
    assert.equal(fns.vfprintf.handler([out, memory.put('%s %d\n'), list]), 8);
    assert.equal(fns.vfprintf.handler([0, memory.put('x'), list]), EOF);
    fns.fclose.handler([out]);
    assert.equal(text('C:\\log.txt'), 'level 3\r\n');
});

test('_wfopen is fopen with a wide name and a wide mode', ()=>{
    const { memory, fns, errno, text } = runtime({ 'C:\\in.txt': 'a\r\nb' });
    /** @param {string} name @param {string} mode */
    const open = (name, mode)=>fns._wfopen.handler([memory.putWide(name), memory.putWide(mode)]);
    const out = open('C:\\caf\u00e9.txt', 'w');
    assert.notEqual(out, 0);
    assert.equal(fns.fputs.handler([memory.put('x\n'), out]), 0);
    fns.fclose.handler([out]);
    assert.equal(text('C:\\caf\u00e9.txt'), 'x\r\n', 'a name past ASCII kept whole');

    const input = open('C:\\in.txt', 'rb');
    assert.equal(fns.fgetc.handler([input]), 0x61);
    assert.equal(fns.fgetc.handler([input]), 0x0d, 'the mode read from the wide string');

    assert.equal(open('C:\\none.txt', 'r'), 0);
    assert.equal(fns._wfopen.handler([0, memory.putWide('r')]), 0);
    assert.equal(fns._wfopen.handler([memory.putWide('C:\\in.txt'), 0]), 0);
    const ENOENT = 2;
    assert.deepEqual(errno, [ENOENT, 22, 22]);
});

test('fopen\'s ccs= opens a file in a Unicode translation, and b overrides it', ()=>{
    // Wine's msvcrt test_fopen_s: each ccs= writes the mark of its encoding
    // into a new file; read back, the mark is skipped and says how the rest
    // is kept whatever ccs= names; with b the bytes are what they are.
    const { memory, fns, open, files } = runtime({});
    const name = 'C:\\empty1';
    const buffer = memory.allocate(16);
    /** @param {string} mode @param {number} count */
    const read = (mode, count)=>{
        const stream = open(name, mode);
        const got = fns.fread.handler([buffer, 1, count, stream]);
        fns.fclose.handler([stream]);
        return [...memory.bytes.subarray(buffer, buffer + got)];
    };

    const stream = open(name, 'w,  ccs=UNIcode');
    assert.equal(fns.fwrite.handler([memory.put('a'), 1, 2, stream]), 2);
    fns.fclose.handler([stream]);
    assert.ok(files.files[name], 'the D in UNICODE does not make the file temporary');
    assert.deepEqual(read('r', 2), [0xff, 0xfe]);
    assert.deepEqual(read('r,ccs=unicode', 2), [0x61, 0]);
    assert.deepEqual(read('rb,ccs=unicode', 2), [0xff, 0xfe]);
    assert.deepEqual(read('r,ccs=utf-16le', 2), [0x61, 0]);
    assert.deepEqual(read('r,ccs=utf-8', 2), [0x61, 0], 'the mark over what ccs= names');

    fns.fclose.handler([open(name, 'w,ccs=utf-16le')]);
    assert.deepEqual(read('r', 3), [0xff, 0xfe]);
    fns.fclose.handler([open(name, 'w,ccs=utf-8')]);
    assert.deepEqual(read('r', 4), [0xef, 0xbb, 0xbf]);
    const binary = open(name, 'wb, ccs=utf-8');
    fns.fwrite.handler([memory.put('test'), 1, 4, binary]);
    fns.fclose.handler([binary]);
    assert.deepEqual(read('rb', 16), [...'test'].map(character=>character.charCodeAt(0)));
});

test('fopen refuses a ccs= that names no encoding, and anything else after a comma', ()=>{
    const { fns, open, errno } = runtime({ 'C:\\in.txt': 'x' });
    assert.equal(open('C:\\in.txt', 'r,ccs=latin1'), 0);
    assert.equal(open('C:\\in.txt', 'r,shared'), 0);
    assert.deepEqual(errno, [22, 22]);
    assert.notEqual(open('C:\\in.txt', 'r, ccs=UTF-8'), 0);
    assert.equal(fns._fcloseall.handler([]), 1);
});

const WEOF = 0xffff;
const EILSEQ = 42;

test('fputwc writes a byte in text mode, and UTF-16 or UTF-8 after the mark under ccs=', ()=>{
    // Wine's msvcrt test_fputwc, and test_fopen_s's b over ccs=: in binary
    // mode the character goes out as the two bytes it is.
    const { memory, fns, open, files } = runtime({});
    const name = 'C:\\put.txt';
    for (const [mode, expected] of /** @type {[string, number[]][]} */ ([
        ['w', [0x61, 0x0d, 0x0a]],
        ['w,ccs=unicode', [0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0]],
        ['w,ccs=utf-8', [0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]],
        ['wb, ccs=utf-8', [0x61, 0, 0x0a, 0]],
    ]))
    {
        const stream = open(name, mode);
        assert.equal(fns.fputwc.handler([0x61, stream]), 0x61, mode);
        assert.equal(fns.putwc.handler([0x0a, stream]), 0x0a, mode);
        fns.fclose.handler([stream]);
        assert.deepEqual([...files.files[name]], expected, mode);
    }
    assert.equal(fns.fputwc.handler([0x61, 0]), WEOF);
    const input = fns.fopen.handler([memory.put(name), memory.put('r')]);
    assert.equal(fns.fputwc.handler([0x61, input]), WEOF, 'not open for writing');
});

test('fgetws reads a byte a character in text mode and UTF-16 in binary mode', ()=>{
    // Wine's msvcrt test_fgetwc, with the runtime's BUFSIZ of 512: in text
    // mode CR LF is one LF, in binary mode it is two characters, and ftell
    // counts the bytes of the file either way.
    const BUFSIZ = 512;
    const LLEN = 512;
    const mytext = 'This is test_fgetwc\r\n';
    const { memory, fns, open, files } = runtime({});
    const name = 'C:\\wne';
    files.files[name] = bytesOf(`${'a'.repeat(BUFSIZ - 4)}\r\n${mytext}`);
    const line = memory.allocate((BUFSIZ + LLEN + 1) * 2);

    let stream = open(name, 'rt');
    assert.equal(fns.fgetws.handler([line, LLEN, stream]), line);
    assert.equal(fns.ftell.handler([stream]), BUFSIZ - 2);
    fns.fgetws.handler([line, LLEN, stream]);
    assert.equal(fns.ftell.handler([stream]), BUFSIZ - 2 + mytext.length);
    assert.equal(memory.wide(line), 'This is test_fgetwc\n', 'the carriage return skipped');
    fns.fclose.handler([stream]);

    stream = open(name, 'wb');
    for (let count = 0; count < BUFSIZ - 3 - mytext.length * 2; count++)
    {
        fns.fputc.handler([0x61, stream]);
    }
    fns.fputwc.handler([0x0d, stream]);
    fns.fputwc.handler([0x0a, stream]);
    assert.equal(fns.fputws.handler([line, stream]), 0);
    fns.fputws.handler([line, stream]);
    fns.fclose.handler([stream]);

    stream = open(name, 'rb');
    let j = (BUFSIZ - 2) / 2 - mytext.length;
    fns.fgetws.handler([line, j, stream]);
    j = (j - 1) * 2;
    assert.equal(fns.ftell.handler([stream]), j);
    assert.equal(fns.fgetc.handler([stream]), 0x61);
    assert.equal(fns.ftell.handler([stream]), ++j);
    fns.fgetws.handler([line, 3, stream]);
    assert.equal(memory.wide(line), '\r\n');
    j += 4;
    assert.equal(fns.ftell.handler([stream]), j);
    fns.fgetws.handler([line, LLEN, stream]);
    j += (mytext.length - 1) * 2;
    assert.equal(fns.ftell.handler([stream]), j);
    assert.equal(memory.wide(line), 'This is test_fgetwc\n');
    fns.fgetws.handler([line, LLEN, stream]);
    assert.equal(memory.wide(line), 'This is test_fgetwc\n', 'the second copy, to the end');
    assert.equal(fns.fgetws.handler([line, LLEN, stream]), 0, 'nothing left');
});

test('fgetwc reads a stream in a Unicode mode the way its mark, or else its ccs=, says', ()=>{
    // Wine's msvcrt test_fgetwc_unicode.
    const { fns, open, files } = runtime({});
    const name = 'C:\\u.txt';
    /** @param {string} mode */
    const units = mode=>{
        const stream = open(name, mode);
        /** @type {number[]} */
        const got = [];
        while (got.at(-1) !== WEOF && got.length < 8)
        {
            got.push(fns.fgetwc.handler([stream]));
        }
        fns.fclose.handler([stream]);
        return got;
    };
    files.files[name] = Uint8Array.of(0xff, 0xfe, 0x1f, 0xff, 0x21, 0);
    assert.deepEqual(units('rt,ccs=unicode'), [0xff1f, 0x21, WEOF]);
    assert.deepEqual(units('r,ccs=utf-8'), [0xff1f, 0x21, WEOF]);
    const append = open(name, 'a,ccs=utf-16le');
    assert.equal(fns.fputwc.handler([0x61, append]), 0x61);
    fns.fclose.handler([append]);
    assert.deepEqual(units('a+,ccs=utf-8'), [0xff1f, 0x21, 0x61, WEOF]);

    files.files[name] = Uint8Array.of(0xef, 0xbb, 0xbf, 0xef, 0xbc, 0x9f, 0x21);
    assert.deepEqual(units('rt, ccs=UTF-8'), [0xff1f, 0x21, WEOF]);
    files.files[name] = Uint8Array.of(0x1f, 0xff, 0x21, 0, 0);
    assert.deepEqual(units('rt,ccs=utf-16le'), [0xff1f, 0x21, WEOF]);
    files.files[name] = Uint8Array.of(0xef, 0xbc, 0x9f, 0x21);
    assert.deepEqual(units('rt, ccs=UTF-8'), [0xff1f, 0x21, WEOF]);
    assert.deepEqual(units('rt, ccs=unicode'), [0xef, 0xbc, 0x9f, 0x21, WEOF],
        'with no mark, UNICODE reads a byte to a character');
});

test('the wide calls take a character to a byte in text mode, and none past U+00FF', ()=>{
    // Under the C locale a character past U+00FF has no multibyte form:
    // Wine's msvcrt test__wcstombs_s_l finds L"\xfffd" EILSEQ there.
    const { memory, fns, open, text, errno } = runtime({ 'C:\\in.txt': 'r\xe9\r\n' });
    const out = open('C:\\t.txt', 'w');
    assert.equal(fns.fputwc.handler([0xe9, out]), 0xe9);
    assert.equal(fns.fputwc.handler([0x263a, out]), WEOF);
    assert.equal(fns.fputws.handler([memory.putWide('ok\n'), out]), 0);
    assert.equal(fns.fputws.handler([memory.putWide('a\u263ab'), out]), EOF);
    fns.fclose.handler([out]);
    assert.equal(text('C:\\t.txt'), '\xe9ok\r\na', 'what came before the character is written');
    assert.deepEqual(errno.splice(0), [EILSEQ, EILSEQ]);

    const input = open('C:\\in.txt', 'r');
    assert.deepEqual([0, 1, 2, 3].map(()=>fns.getwc.handler([input])), [0x72, 0xe9, 0x0a, WEOF]);
    assert.notEqual(fns.feof.handler([input]), 0);
});

test('ungetwc gives a character back to be read again, WEOF never', ()=>{
    const { memory, fns, open, files, errno } = runtime({ 'C:\\n.txt': 'yz' });
    files.files['C:\\u.txt'] = Uint8Array.of(0xef, 0xbb, 0xbf, 0xe2, 0x98, 0xba, 0x0d, 0x0a);
    const stream = open('C:\\u.txt', 'r,ccs=utf-8');
    const line = memory.allocate(16);
    assert.equal(fns.fgetwc.handler([stream]), 0x263a);
    assert.equal(fns.ungetwc.handler([0x263a, stream]), 0x263a);
    assert.equal(fns.ungetwc.handler([WEOF, stream]), WEOF);
    assert.equal(fns.fgetws.handler([line, 8, stream]), line);
    assert.equal(memory.wide(line), '\u263a\n');
    assert.equal(fns.fgetwc.handler([stream]), WEOF);
    assert.notEqual(fns.feof.handler([stream]), 0);
    assert.equal(fns.ungetwc.handler([0x41, stream]), 0x41);
    assert.equal(fns.feof.handler([stream]), 0, 'the end of the file cleared');

    const narrow = open('C:\\n.txt', 'r');
    assert.equal(fns.ungetwc.handler([0x263a, narrow]), WEOF, 'no byte for it');
    assert.equal(fns.ungetwc.handler([0x78, narrow]), 0x78);
    assert.equal(fns.fgetc.handler([narrow]), 0x78);
    assert.equal(fns.fgetc.handler([narrow]), 0x79);

    assert.equal(fns.fgetws.handler([0, 8, narrow]), 0);
    assert.equal(fns.fgetws.handler([line, 0, narrow]), 0);
    assert.equal(fns.fputws.handler([0, narrow]), EOF);
    assert.deepEqual(errno, [22, 22, 22]);
});

test('fwprintf, wprintf, their va_list forms and _putws write wide text to the stream', ()=>{
    // "fwprintf returns the number of wide characters written"; in the wide
    // family %s is a wide string and %S a narrow one.
    const { memory, fns, open, files, console, errno } = runtime({});
    const out = open('C:\\w.txt', 'w,ccs=utf-8');
    const format = memory.putWide('%s \u263a %d\n');
    assert.equal(fns.fwprintf.handler([out, format, memory.putWide('x'), 7]), 6);
    const list = memory.allocate(8);
    memory.setU32(list, memory.putWide('y'));
    memory.setU32(list + 4, 8);
    assert.equal(fns.vfwprintf.handler([out, memory.putWide('%s=%d'), list]), 3);
    fns.fclose.handler([out]);
    assert.deepEqual([...files.files['C:\\w.txt']], [0xef, 0xbb, 0xbf,
        0x78, 0x20, 0xe2, 0x98, 0xba, 0x20, 0x37, 0x0d, 0x0a, 0x79, 0x3d, 0x38]);

    assert.equal(fns.wprintf.handler([memory.putWide('%S!\n'), memory.put('hi')]), 4);
    assert.equal(fns.vwprintf.handler([memory.putWide('%d'), list + 4]), 1);
    assert.equal(fns._putws.handler([memory.putWide('end')]), 0);
    assert.equal(fns.wprintf.handler([memory.putWide('\u263a')]), -1, 'no byte for it');
    assert.deepEqual(console, [[2, 'hi!\n'], [2, '8'], [2, 'end\n']]);

    const stdout = IOB + 32;
    assert.equal(fns.fwprintf.handler([stdout, 0]), -1);
    assert.equal(fns._putws.handler([0]), WEOF);
    assert.deepEqual(errno, [EILSEQ, 22, 22]);
});

test('getwchar and putwchar are fgetwc on stdin and fputwc on stdout', ()=>{
    // "putwc and putwchar are wide-character versions of putc and putchar";
    // getwchar reads stdin and answers WEOF at its end.
    const { memory, fns, console, errno } = runtime({ 'C:\\in.txt': 'a\r\n' });
    assert.equal(fns.putwchar.handler([0xe9]), 0xe9);
    assert.equal(fns.putwchar.handler([0x263a]), WEOF, 'the C locale has no byte for it');
    assert.deepEqual(console, [[2, '\xe9']]);
    assert.deepEqual(errno.splice(0), [EILSEQ]);

    assert.equal(fns.getwchar.handler([]), WEOF, 'the console\'s stdin is at its end');
    const stdin = IOB;
    fns.freopen.handler([memory.put('C:\\in.txt'), memory.put('r'), stdin]);
    assert.deepEqual([0, 1, 2].map(()=>fns.getwchar.handler([])), [0x61, 0x0a, WEOF]);
    assert.deepEqual([fns.getwchar.argBytes, fns.putwchar.argBytes], [0, 4]);
});

test('the stream calls are cdecl with the argument count each reads', ()=>{
    const { fns } = runtime({});
    const expected = {
        fflush: 4, feof: 4, ferror: 4, clearerr: 4, fgetc: 4, getc: 4, _filbuf: 4,
        fgets: 12, fputc: 8, putc: 8, _flsbuf: 8, fputs: 8, ungetc: 8, rewind: 4, _fileno: 4,
        fgetpos: 8, fsetpos: 8, freopen: 12, _fdopen: 8, _fcloseall: 0, _flushall: 0,
        vfprintf: 12, _wfopen: 8, fgetwc: 4, getwc: 4, fputwc: 8, putwc: 8, ungetwc: 8,
        fgetws: 12, fputws: 8, _putws: 4, vfwprintf: 12, vwprintf: 8,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.deepEqual([fns[name].convention, fns[name].argBytes], ['cdecl', argBytes], name);
    }
});

test('fscanf consumes what its scan reads and leaves the rest for the next read', ()=>{
    // Wine's msvcrt test_fscanf and test_fprintf: a string per call, EOF at
    // the end, and the stream's position after the scan where the scan stopped.
    const { memory, fns } = build();
    const path = memory.put('C:\\scan.txt');
    const writer = fns.fopen.handler([path, memory.put('wb')]);
    fns.fwrite.handler([memory.put('line1\nline2 \n12 34'), 1, 18, writer]);
    fns.fclose.handler([writer]);
    const stream = fns.fopen.handler([path, memory.put('rb')]);
    const buffer = memory.allocate(64);
    const format = memory.put('%s');
    assert.equal(fns.fscanf.handler([stream, format, buffer]), 1);
    assert.equal(memory.text(buffer), 'line1');
    assert.equal(fns.ftell.handler([stream]), 5, 'the line feed after it is not consumed');
    assert.equal(fns.fscanf.handler([stream, format, buffer]), 1);
    assert.equal(memory.text(buffer), 'line2');
    const numbers = memory.allocate(8);
    assert.equal(fns.fscanf.handler([stream, memory.put('%d%d'), numbers, numbers + 4]), 2,
        'a scan that needs the next line reads it');
    assert.deepEqual([memory.i32(numbers), memory.i32(numbers + 4)], [12, 34]);
    assert.equal(fns.fscanf.handler([stream, format, buffer]), -1, 'EOF at the end');
});

test('_fsopen and _wfsopen are fopen and _wfopen with a share flag that changes nothing', ()=>{
    const { memory, fns, text } = runtime({ 'C:\\in.txt': 'abc' });
    const input = fns._fsopen.handler([memory.put('C:\\in.txt'), memory.put('rb'), 0x40]);
    assert.notEqual(input, 0);
    assert.equal(fns.fgetc.handler([input]), 0x61);
    const out = fns._wfsopen.handler([memory.putWide('C:\\out.txt'), memory.putWide('wb'), 0x40]);
    assert.notEqual(out, 0);
    fns.fputs.handler([memory.put('hi'), out]);
    fns.fclose.handler([out]);
    assert.equal(text('C:\\out.txt'), 'hi');
    assert.equal(fns._fsopen.handler([memory.put('C:\\none.txt'), memory.put('r'), 0x40]), 0);
    assert.deepEqual([fns._fsopen.argBytes, fns._wfsopen.argBytes], [12, 12]);
});

test('tmpfile opens a new file for update in binary, each its own, removed when it closes', ()=>{
    const { memory, files, fns } = build();
    const first = fns.tmpfile.handler([]);
    const second = fns.tmpfile.handler([]);
    assert.notEqual(first, 0);
    assert.notEqual(second, 0);
    assert.notEqual(first, second);

    const buffer = memory.allocate(8);
    memory.bytes.set([7, 0x0a, 9], buffer);
    assert.equal(fns.fwrite.handler([buffer, 1, 3, first]), 3);
    assert.equal(fns.fseek.handler([first, 0, 0]), 0);
    const back = memory.allocate(8);
    assert.equal(fns.fread.handler([back, 1, 8, first]), 3, 'read back: opened for update');
    assert.deepEqual([...memory.bytes.subarray(back, back + 3)], [7, 0x0a, 9],
        'binary: the line feed is not widened');

    assert.equal(fns.fclose.handler([first]), 0);
    assert.equal(fns.fclose.handler([second]), 0);
    for (const name of files.closed)
    {
        assert.equal(files.stat(name)?.exists === true, false, `${name} is gone once closed`);
    }
});
