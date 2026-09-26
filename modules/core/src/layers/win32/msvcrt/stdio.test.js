/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStdioFunctions } from './stdio.js';
import { createDescriptors, createIoFunctions } from './io.js';
import { fakeMemory, fakeVolume } from './harness.test.js';

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

test('setvbuf accepts a stream and a real mode, and does nothing observable', ()=>{
    const { memory, fns } = build();
    const stream = fns.fopen.handler([memory.put('C:\\data.bin'), memory.put('rb')]);
    const IONBF = 0x0004;
    const IOFBF = 0x0000;
    const IOLBF = 0x0040;

    assert.equal(fns.setvbuf.handler([stream, 0, IONBF, 0]), 0);
    assert.equal(fns.setvbuf.handler([stream, 0, IOFBF, 512]), 0);
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
    const descriptors = createDescriptors({ files, errno: record, fmode: ()=>fmode });
    const host = { ...memory, free: ()=>true, files, iob: ()=>IOB, errno: record };
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
    return { memory, files, fns, errno, open, gets, flag, text };
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

test('the stream calls are cdecl with the argument count each reads', ()=>{
    const { fns } = runtime({});
    const expected = {
        fflush: 4, feof: 4, ferror: 4, clearerr: 4, fgetc: 4, getc: 4, _filbuf: 4,
        fgets: 12, fputc: 8, putc: 8, _flsbuf: 8, fputs: 8, ungetc: 8, rewind: 4, _fileno: 4,
        fgetpos: 8, fsetpos: 8,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.deepEqual([fns[name].convention, fns[name].argBytes], ['cdecl', argBytes], name);
    }
});
