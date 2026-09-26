/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Setup API's calls against the real filesystem layer, with a program's
 * callbacks standing in as functions at guest addresses. The expectations
 * are the ones Wine's setupapi tests (parser, query, setupcab, install)
 * establish on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesystemModule } from '../../filesystem/module.js';
import { createVolume } from '../kernel32/vfs.js';
import { createHive, shellFolders } from '../advapi32/registry.js';
import { FILEOP, SPFILENOTIFY, createSetupapiFunctions } from './functions.js';

const INVALID_HANDLE_VALUE = 0xffffffff;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INVALID_HANDLE = 6;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_INVALID_USER_BUFFER = 1784;
const ERROR_EXPECTED_SECTION_NAME = 0xe0000000;
const ERROR_WRONG_INF_STYLE = 0xe0000100;
const ERROR_LINE_NOT_FOUND = 0xe0000102;
const ERROR_CLASS_MISMATCH = 0xe0000201;
const INF_STYLE_WIN4 = 2;
const SPINST_FILES = 0x10;

/** Where the tests put their arguments; the heap starts above them. */
const ARG = 0x1000;
const HEAP = 0x20000;

async function machine(){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    const fs = await filesystemModule.create({});
    const volume = /** @type {any} */ (createVolume(fs));
    for (const path of ['C:\\WINDOWS', 'C:\\WINDOWS\\inf', 'C:\\WINDOWS\\system32', 'C:\\src',
        'C:\\dst'])
    {
        volume.mkdir(path);
    }
    /** @type {number[]} */
    const errors = [];
    /** @type {Map<number, any>} */
    const handles = new Map();
    let nextHandle = 0x40;
    let heap = HEAP;
    /** @type {Map<number, (args: number[]) => number | Promise<number>>} */
    const callbacks = new Map();
    const hive = createHive();

    /**
     * As the memory layer reads an ANSI string: in Windows-1252, which is what
     * the Encoding standard calls latin1.
     *
     * @param {number} at @param {number} max
     */
    const readCString = (at, max)=>{
        let end = at;
        while (end < at + max && bytes[end] !== 0)
        {
            end++;
        }
        return new TextDecoder('latin1').decode(bytes.subarray(at, end));
    };
    const fns = createSetupapiFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readCString,
        setLastError: code=>errors.push(code >>> 0),
        setLastErrorFor: (_thread, code)=>errors.push(code >>> 0),
        files: volume,
        fullPath: path=>(/^[A-Za-z]:/.test(path) ? path : `C:\\${path}`),
        allocate: size=>{
            const at = heap;
            heap += (size + 15) & ~15;
            return at;
        },
        free: ()=>{},
        call: (entry, args)=>{
            const handler = callbacks.get(entry);
            assert.ok(handler, `a callback at 0x${entry.toString(16)}`);
            return handler(args);
        },
        callerThread: ()=>({ id: 1 }),
        handles: {
            open: (type, object)=>{
                handles.set(nextHandle, { type, object });
                return nextHandle++;
            },
            resolve: (handle, type)=>{
                const held = handles.get(handle);
                if (!held || (type && held.type !== type))
                {
                    throw new Error('not a handle');
                }
                return held.object;
            },
            close: handle=>handles.delete(handle),
        },
        folders: shellFolders(),
        registry: hive,
    });

    let argAt = ARG;
    /** @param {string} text */
    const str = text=>{
        const at = argAt;
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        argAt += text.length + 16;
        return at;
    };
    /** @param {number} size */
    const buffer = size=>{
        const at = argAt;
        bytes.fill(0, at, at + size);
        argAt += size + 16;
        return at;
    };
    /** @param {string} path @param {string | Uint8Array} data */
    const file = (path, data)=>{
        const node = volume.open(path, { write: true, create: true, truncate: true });
        volume.write(node, 0, typeof data === 'string'
            ? Uint8Array.from([...data].map(c=>c.charCodeAt(0))) : data);
        volume.close(node);
    };
    /** @param {string} path */
    const contents = path=>{
        const stat = volume.stat(path);
        if (!stat)
        {
            return null;
        }
        const node = volume.open(path, { read: true });
        const data = String.fromCharCode(...volume.read(node, 0, stat.size));
        volume.close(node);
        return data;
    };
    let nextCallback = 0x7f0000;
    /** @param {(args: number[]) => number | Promise<number>} handler */
    const callback = handler=>{
        const at = nextCallback;
        nextCallback += 0x10;
        callbacks.set(at, handler);
        return at;
    };
    return {
        fns, view, errors, str, buffer, file, contents, callback, readCString, volume,
        u32: (/** @type {number} */ at)=>view.getUint32(at, true),
        lastError: ()=>errors.at(-1),
    };
}

const INF = [
    '[Version]',
    'Signature="$Windows NT$"',
    'Class=Media',
    '[Section]',
    'Key1=Field1,Field2,Field3',
    '',
    'Key2=Field4,Field5',
    '',
].join('\r\n');

test('an INF is opened by path, or by a bare name from the inf or system directory', async()=>{
    const m = await machine();
    m.file('C:\\WINDOWS\\system32\\sys.inf', INF);
    m.file('C:\\src\\here.inf', INF);
    const line = m.buffer(4);
    const byName = m.fns.SetupOpenInfFileA.handler([m.str('sys.inf'), 0, INF_STYLE_WIN4, line]);
    assert.notEqual(byName, INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), 0, 'success clears the last error');
    assert.notEqual(m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\here.inf'), 0,
        INF_STYLE_WIN4, 0]), INVALID_HANDLE_VALUE);
    assert.notEqual(m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\here.inf'),
        m.str('media'), INF_STYLE_WIN4, 0]), INVALID_HANDLE_VALUE, 'the class, case aside');

    assert.equal(m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\here.inf'), m.str('Net'),
        INF_STYLE_WIN4, 0]), INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_CLASS_MISMATCH);
    assert.equal(m.fns.SetupOpenInfFileA.handler([m.str('none.inf'), 0, INF_STYLE_WIN4, 0]),
        INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);

    m.file('C:\\src\\old.inf', '[Setup]\r\nx=1\r\n');
    assert.equal(m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\old.inf'), 0, INF_STYLE_WIN4,
        0]), INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_WRONG_INF_STYLE);

    m.file('C:\\src\\bad.inf', `;\r\nstray\r\n${INF}`);
    assert.equal(m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\bad.inf'), 0, INF_STYLE_WIN4,
        line]), INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_EXPECTED_SECTION_NAME);
    assert.equal(m.u32(line), 2, 'ErrorLine is the 1-based line');
});

test('lines are found by section and key, walked, and read back as text', async()=>{
    // Wine's setupapi test_GLE: every miss is ERROR_LINE_NOT_FOUND.
    const m = await machine();
    m.file('C:\\src\\t.inf', INF);
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\t.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const context = m.buffer(16);

    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('ImNotThere'), 0, context]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND);
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Section'), m.str('Nope'),
        context]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND);
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('section'), 0, context]), 1);
    assert.equal(m.lastError(), 0);

    const out = m.buffer(64);
    const size = m.buffer(4);
    assert.equal(m.fns.SetupGetLineTextA.handler([context, 0, 0, 0, out, 64, size]), 1);
    assert.equal(m.readCString(out, 64), 'Field1,Field2,Field3');
    assert.equal(m.u32(size), 21, 'the terminator counted');
    assert.equal(m.fns.SetupGetLineTextA.handler([context, 0, 0, 0, out, 5, size]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(m.fns.SetupGetLineTextA.handler([context, 0, 0, 0, 0, 0, size]), 1,
        'a NULL buffer asks for the size');

    const next = m.buffer(16);
    assert.equal(m.fns.SetupFindNextLine.handler([context, next]), 1);
    assert.equal(m.fns.SetupGetLineTextA.handler([next, 0, 0, 0, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'Field4,Field5');
    assert.equal(m.fns.SetupFindNextLine.handler([next, next]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND);

    assert.equal(m.fns.SetupGetLineTextA.handler([0, inf, m.str('Section'), m.str('key2'), out,
        64, 0]), 1, 'or by section and key');
    assert.equal(m.readCString(out, 64), 'Field4,Field5');
    assert.equal(m.fns.SetupGetLineTextA.handler([0, inf, m.str('Section'), m.str('none'), out,
        64, 0]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND);

    m.fns.SetupCloseInfFile.handler([inf]);
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Section'), 0, context]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
    m.fns.SetupCloseInfFile.handler([INVALID_HANDLE_VALUE]);
});

test('an INF\'s information: its style, and the size asked for before the buffer', async()=>{
    // Wine's setupapi test_SetupGetInfInformation.
    const m = await machine();
    m.file('C:\\src\\t.inf', INF);
    const size = m.buffer(4);
    const name = m.str('C:\\src\\t.inf');
    assert.equal(m.fns.SetupGetInfInformationA.handler([0, 1, 0, 0, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
    assert.equal(m.fns.SetupGetInfInformationA.handler([0, 2, 0, 0, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.SetupGetInfInformationA.handler([name, -1, 0, 0, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.SetupGetInfInformationA.handler([m.str('C:\\none.inf'), 2, 0, 0, size]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);

    assert.equal(m.fns.SetupGetInfInformationA.handler([name, 2, 0, 0, size]), 1);
    const needed = m.u32(size);
    assert.ok(needed > 8);
    assert.equal(m.fns.SetupGetInfInformationA.handler([name, 2, 0, needed, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.SetupGetInfInformationA.handler([name, 2, 0, needed - 1, size]), 1);
    const out = m.buffer(needed);
    assert.equal(m.fns.SetupGetInfInformationA.handler([name, 2, out, needed - 1, size]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(m.fns.SetupGetInfInformationA.handler([name, 2, out, needed, size]), 1);
    assert.equal(m.u32(out), INF_STYLE_WIN4);
    assert.equal(m.u32(out + 4), 1, 'one INF');

    const inf = await m.fns.SetupOpenInfFileA.handler([name, 0, INF_STYLE_WIN4, 0]);
    assert.equal(m.fns.SetupGetInfInformationA.handler([inf, 1, out, needed, size]), 1);
    m.file('C:\\WINDOWS\\inf\\found.inf', INF);
    assert.equal(m.fns.SetupGetInfInformationA.handler([m.str('found.inf'), 3, 0, 0, size]), 1);
});

/**
 * A cabinet of stored files, laid out as the format describes.
 *
 * @param {[string, string][]} entries  Name and contents.
 */
function storedCabinet(entries){
    const data = entries.map(([, text])=>text).join('');
    const names = entries.map(([name])=>[...name, '\0'].map(c=>c.charCodeAt(0)));
    const filesAt = 36 + 8;
    const dataAt = filesAt + names.reduce((sum, name)=>sum + 16 + name.length, 0);
    const out = new Uint8Array(dataAt + 8 + data.length);
    const view = new DataView(out.buffer);
    out.set([0x4d, 0x53, 0x43, 0x46]);
    view.setUint32(8, out.length, true);
    view.setUint32(16, filesAt, true);
    out[24] = 3;
    out[25] = 1;
    view.setUint16(26, 1, true);
    view.setUint16(28, entries.length, true);
    view.setUint16(32, 0x1234, true);
    view.setUint32(36, dataAt, true);
    view.setUint16(40, 1, true);
    let at = filesAt;
    let offset = 0;
    entries.forEach(([, text], i)=>{
        view.setUint32(at, text.length, true);
        view.setUint32(at + 4, offset, true);
        view.setUint16(at + 10, 14545, true);
        view.setUint16(at + 12, 18672, true);
        view.setUint16(at + 14, 0x20, true);
        out.set(names[i], at + 16);
        at += 16 + names[i].length;
        offset += text.length;
    });
    view.setUint16(dataAt + 4, data.length, true);
    view.setUint16(dataAt + 6, data.length, true);
    out.set([...data].map(c=>c.charCodeAt(0)), dataAt + 8);
    return out;
}

test('SetupIterateCabinet refuses what it cannot walk, with the codes Windows gives', async()=>{
    const m = await machine();
    const noop = m.callback(()=>0);
    assert.equal(m.fns.SetupIterateCabinetA.handler([0, 0, noop, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.SetupIterateCabinetA.handler([m.str(''), 0, noop, 0]), 0);
    assert.equal(m.lastError(), ERROR_NOT_ENOUGH_MEMORY);
    assert.equal(m.fns.SetupIterateCabinetA.handler([m.str('C:\\none.cab'), 0, noop, 0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
    m.file('C:\\src\\empty.cab', '');
    assert.equal(await m.fns.SetupIterateCabinetA.handler([m.str('C:\\src\\empty.cab'), 0, noop,
        0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_DATA);
    m.file('C:\\src\\a.cab', storedCabinet([['a', 'x']]));
    assert.equal(await m.fns.SetupIterateCabinetA.handler([m.str('C:\\src\\a.cab'), 0, 0, 0]), 0,
        'a cabinet with nowhere to report to');
    assert.equal(m.lastError(), ERROR_INVALID_DATA);
});

test('SetupIterateCabinet reports the cabinet, then each file, and extracts where told', async()=>{
    const m = await machine();
    m.file('C:\\src\\test.cab', storedCabinet([['tristram', 'tristram\n'], ['wine', 'wine!\n'],
        ['shandy', 'shandy\n']]));
    const path = m.str('C:\\src\\test.cab');
    const context = 0xc0de;
    /** @type {any[]} */
    const seen = [];
    const handler = m.callback(([given, message, param1, param2])=>{
        assert.equal(given, context);
        if (message === SPFILENOTIFY.CABINETINFO)
        {
            seen.push(['info', m.readCString(m.u32(param1), 260), m.readCString(m.u32(param1 + 4),
                260), m.view.getUint16(param1 + 12, true), param2]);
            return 0;
        }
        if (message === SPFILENOTIFY.FILEINCABINET)
        {
            const name = m.readCString(m.u32(param1), 260);
            seen.push(['file', name, m.u32(param1 + 4), m.u32(param1 + 8),
                m.view.getUint16(param1 + 12, true), m.view.getUint16(param1 + 14, true),
                m.view.getUint16(param1 + 16, true), param2 === path]);
            if (name === 'wine')
            {
                return FILEOP.SKIP;
            }
            const target = `C:\\dst\\${name}.out\0`;
            target.split('').forEach((c, i)=>m.view.setUint8(param1 + 18 + i, c.charCodeAt(0)));
            return FILEOP.DOIT;
        }
        assert.equal(message, SPFILENOTIFY.FILEEXTRACTED);
        seen.push(['done', m.readCString(m.u32(param1), 260), m.readCString(m.u32(param1 + 4), 260),
            m.u32(param1 + 8), param2]);
        return 0;
    });
    assert.equal(await m.fns.SetupIterateCabinetA.handler([path, 0, handler, context]), 1);
    assert.deepEqual(seen, [
        ['info', 'C:\\src\\', '', 0x1234, 0],
        ['file', 'tristram', 9, 0, 14545, 18672, 0x20, true],
        ['done', 'C:\\dst\\tristram.out', 'C:\\src\\test.cab', 0, 0],
        ['file', 'wine', 6, 0, 14545, 18672, 0x20, true],
        ['file', 'shandy', 7, 0, 14545, 18672, 0x20, true],
        ['done', 'C:\\dst\\shandy.out', 'C:\\src\\test.cab', 0, 0],
    ]);
    assert.equal(m.contents('C:\\dst\\tristram.out'), 'tristram\n');
    assert.equal(m.contents('C:\\dst\\wine.out'), null, 'skipped');
    assert.equal(m.contents('C:\\dst\\shandy.out'), 'shandy\n');
});

test('a callback that aborts, or refuses an extraction, ends the walk with its error', async()=>{
    const m = await machine();
    m.file('C:\\src\\test.cab', storedCabinet([['one', '1'], ['two', '2']]));
    const aborts = m.callback(([, message, param1])=>{
        if (message === SPFILENOTIFY.FILEINCABINET)
        {
            m.view.setUint32(param1 + 8, 1234, true);
            return FILEOP.ABORT;
        }
        return 0;
    });
    assert.equal(await m.fns.SetupIterateCabinetA.handler([m.str('C:\\src\\test.cab'), 0, aborts,
        0]), 0);
    assert.equal(m.lastError(), 1234, 'the error the callback put in Win32Error');

    const nowhere = m.callback(([, message, param1])=>{
        if (message === SPFILENOTIFY.FILEINCABINET)
        {
            'C:\\missing\\one\0'.split('').forEach((c, i)=>
                m.view.setUint8(param1 + 18 + i, c.charCodeAt(0)));
            return FILEOP.DOIT;
        }
        return message === SPFILENOTIFY.FILEEXTRACTED ? m.u32(param1 + 8) : 0;
    });
    assert.equal(await m.fns.SetupIterateCabinetA.handler([m.str('C:\\src\\test.cab'), 0, nowhere,
        0]), 0);
    assert.equal(m.lastError(), 3, 'ERROR_PATH_NOT_FOUND, handed back by the callback');
});

const INSTALL = [
    '[Version]',
    'Signature="$Windows NT$"',
    'AdvancedINF=2.0',
    '[Install]',
    'CopyFiles=System, Other',
    'DelFiles=Gone',
    'RenFiles=Moved',
    '[CopyOnly]',
    'CopyFiles=System',
    '[SourceDisksNames]',
    '1=%Disk%,,,loose',
    '99=%Disk%,"PACKED.cab",0,,-1',
    '[SourceDisksFiles]',
    'loose.dll=1',
    'packed.dll=99',
    '[DestinationDirs]',
    'DefaultDestDir=11',
    'Other=10,Sub',
    'Gone=11',
    'Moved=11',
    '[System]',
    'packed.dll',
    '[Other]',
    'loose.dll',
    'renamed.txt,loose.dll',
    '[Gone]',
    'old.dll',
    '[Moved]',
    'new.dll,prior.dll',
    '[Strings]',
    'Disk="The disk"',
    '',
].join('\r\n');

test('an install section\'s files are queued, and committed through the callback', async()=>{
    const m = await machine();
    m.file('C:\\src\\install.inf', INSTALL);
    m.volume.mkdir('C:\\src\\loose');
    m.file('C:\\src\\loose\\loose.dll', 'LOOSE');
    m.file('C:\\src\\packed.cab', storedCabinet([['packed.dll', 'PACKED']]));
    m.file('C:\\WINDOWS\\system32\\old.dll', 'old');
    m.file('C:\\WINDOWS\\system32\\prior.dll', 'prior');
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\install.inf'), 0,
        INF_STYLE_WIN4, 0]);

    /** @type {any[]} */
    const heard = [];
    const forward = m.callback(async([context, message, param1, param2])=>{
        if (message === SPFILENOTIFY.NEEDMEDIA)
        {
            heard.push(['media', m.readCString(m.u32(param1 + 4), 260),
                m.readCString(m.u32(param1 + 8), 260), m.readCString(m.u32(param1 + 12), 260),
                m.readCString(m.u32(param1 + 16), 260)]);
        }
        else if (message === SPFILENOTIFY.STARTCOPY || message === SPFILENOTIFY.STARTDELETE
            || message === SPFILENOTIFY.STARTRENAME)
        {
            heard.push([message, m.readCString(m.u32(param1), 260)]);
        }
        else
        {
            heard.push([message, param1]);
        }
        return m.fns.SetupDefaultQueueCallbackA.handler([context, message, param1, param2]);
    });
    assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, inf, m.str('Install'),
        SPINST_FILES, 0, 0, 0, forward, 0x77, 0, 0]), 1);
    assert.equal(m.contents('C:\\WINDOWS\\system32\\packed.dll'), 'PACKED',
        'out of the cabinet the disk\'s tag file names');
    assert.equal(m.contents('C:\\WINDOWS\\Sub\\loose.dll'), 'LOOSE');
    assert.equal(m.contents('C:\\WINDOWS\\Sub\\renamed.txt'), 'LOOSE');
    assert.equal(m.contents('C:\\WINDOWS\\system32\\old.dll'), null);
    assert.equal(m.contents('C:\\WINDOWS\\system32\\new.dll'), 'prior');
    assert.deepEqual(heard, [
        [SPFILENOTIFY.STARTQUEUE, 0],
        [SPFILENOTIFY.STARTSUBQUEUE, 2], // deletions
        [SPFILENOTIFY.STARTDELETE, 'C:\\WINDOWS\\system32\\old.dll'],
        [SPFILENOTIFY.ENDDELETE, heard[3][1]],
        [SPFILENOTIFY.ENDSUBQUEUE, 2],
        [SPFILENOTIFY.STARTSUBQUEUE, 1], // renames
        [SPFILENOTIFY.STARTRENAME, 'C:\\WINDOWS\\system32\\new.dll'],
        [SPFILENOTIFY.ENDRENAME, heard[7][1]],
        [SPFILENOTIFY.ENDSUBQUEUE, 1],
        [SPFILENOTIFY.STARTSUBQUEUE, 0], // copies
        ['media', 'PACKED.cab', 'The disk', 'C:\\src', 'packed.dll'],
        [SPFILENOTIFY.STARTCOPY, 'C:\\WINDOWS\\system32\\packed.dll'],
        [SPFILENOTIFY.ENDCOPY, heard[12][1]],
        ['media', '', 'The disk', 'C:\\src\\loose', 'loose.dll'],
        [SPFILENOTIFY.STARTCOPY, 'C:\\WINDOWS\\Sub\\loose.dll'],
        [SPFILENOTIFY.ENDCOPY, heard[15][1]],
        [SPFILENOTIFY.STARTCOPY, 'C:\\WINDOWS\\Sub\\renamed.txt'],
        [SPFILENOTIFY.ENDCOPY, heard[17][1]],
        [SPFILENOTIFY.ENDSUBQUEUE, 0],
        [SPFILENOTIFY.ENDQUEUE, 1],
    ]);
});

test('a source that is nowhere is a copy error, which the default callback aborts on', async()=>{
    const m = await machine();
    m.file('C:\\src\\install.inf', INSTALL);
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\install.inf'), 0,
        INF_STYLE_WIN4, 0]);
    /** @type {number[]} */
    const messages = [];
    const forward = m.callback(([context, message, param1, param2])=>{
        messages.push(message);
        return m.fns.SetupDefaultQueueCallbackA.handler([context, message, param1, param2]);
    });
    assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, inf, m.str('CopyOnly'),
        SPINST_FILES, 0, m.str('C:\\src'), 0, forward, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
    assert.ok(messages.includes(SPFILENOTIFY.COPYERROR));
    assert.equal(messages.at(-1), SPFILENOTIFY.ENDQUEUE);
});

test('an INF\'s text and the paths it names are the ANSI page\'s', async()=>{
    // An ANSI INF is in the ANSI page, where 0x80 is the euro sign and 0x99
    // the trade mark, as a program's own strings are read: a file it names by
    // 0x80 is the file CreateFileA would open by those bytes, a Unicode INF's
    // euro sign is 0x80 when handed to an ANSI caller, and so is a path the
    // default callback copies.
    const m = await machine();
    const unicode = '[Version]\r\nSignature="$Windows NT$"\r\n[Section]\r\nKey=\u20ac\u2122\r\n';
    m.file('C:\\src\\u.inf', Uint8Array.from([0xff, 0xfe,
        ...[...unicode].flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8])]));
    const wide = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\u.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const out = m.buffer(16);
    assert.equal(m.fns.SetupGetLineTextA.handler([0, wide, m.str('Section'), m.str('Key'), out,
        16, 0]), 1);
    assert.deepEqual([...new Uint8Array(m.view.buffer, out, 3)], [0x80, 0x99, 0]);

    m.file('C:\\src\\euro.inf', ['[Version]', 'Signature="$Windows NT$"', '[Install]',
        'CopyFiles=Files', '[SourceDisksNames]', '1="The disk"', '[SourceDisksFiles]',
        '\x80.dll=1', '[DestinationDirs]', 'DefaultDestDir=11', '[Files]', '\x80.dll', '']
        .join('\r\n'));
    m.file('C:\\src\\\u20ac.dll', 'EURO');
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\euro.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const forward = m.callback(([context, message, param1, param2])=>
        m.fns.SetupDefaultQueueCallbackA.handler([context, message, param1, param2]));
    assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, inf, m.str('Install'),
        SPINST_FILES, 0, m.str('C:\\src'), 0, forward, 0, 0, 0]), 1);
    assert.equal(m.contents('C:\\WINDOWS\\system32\\\u20ac.dll'), 'EURO');

    // A cabinet keeps its names in the same page, so the INF's name finds the
    // cabinet's file, and a walk hands the name over as its bytes.
    m.file('C:\\src\\packed.inf', ['[Version]', 'Signature="$Windows NT$"', '[Install]',
        'CopyFiles=Files', '[SourceDisksNames]', '99="The disk","PACKED.cab",0,,-1',
        '[SourceDisksFiles]', '\x99.dll=99', '[DestinationDirs]', 'DefaultDestDir=11',
        '[Files]', '\x99.dll', ''].join('\r\n'));
    m.file('C:\\src\\packed.cab', storedCabinet([['\x99.dll', 'PACKED']]));
    const packed = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\packed.inf'), 0,
        INF_STYLE_WIN4, 0]);
    assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, packed, m.str('Install'),
        SPINST_FILES, 0, m.str('C:\\src'), 0, forward, 0, 0, 0]), 1);
    assert.equal(m.contents('C:\\WINDOWS\\system32\\\u2122.dll'), 'PACKED');
    /** @type {number[][]} */
    const named = [];
    const walk = m.callback(([, message, param1])=>{
        if (message === SPFILENOTIFY.FILEINCABINET)
        {
            const at = m.u32(param1);
            named.push([...new Uint8Array(m.view.buffer, at, 6)]);
            return FILEOP.SKIP;
        }
        return 0;
    });
    assert.equal(await m.fns.SetupIterateCabinetA.handler([m.str('C:\\src\\packed.cab'), 0,
        walk, 0]), 1);
    assert.deepEqual(named, [[0x99, 0x2e, 0x64, 0x6c, 0x6c, 0]]);

    const media = m.buffer(24);
    m.view.setUint32(media + 12, m.str('C:\\\x80'), true);
    const path = m.buffer(260);
    assert.equal(m.fns.SetupDefaultQueueCallbackA.handler([0, SPFILENOTIFY.NEEDMEDIA, media,
        path]), FILEOP.DOIT);
    assert.deepEqual([...new Uint8Array(m.view.buffer, path, 5)], [0x43, 0x3a, 0x5c, 0x80, 0]);
});

test('the default callback: go on with everything, and where the media is', async()=>{
    const m = await machine();
    const answer = (/** @type {number} */ message, param1 = 0, param2 = 0)=>
        m.fns.SetupDefaultQueueCallbackA.handler([0, message, param1, param2]);
    assert.equal(answer(SPFILENOTIFY.STARTQUEUE), 1);
    assert.equal(answer(SPFILENOTIFY.STARTSUBQUEUE), 1);
    assert.equal(answer(SPFILENOTIFY.STARTCOPY), FILEOP.DOIT);
    assert.equal(answer(SPFILENOTIFY.ENDCOPY), 0);
    assert.equal(answer(SPFILENOTIFY.ENDQUEUE), 0);
    assert.equal(answer(SPFILENOTIFY.COPYERROR), FILEOP.ABORT);
    const media = m.buffer(24);
    m.view.setUint32(media + 12, m.str('C:\\disk'), true);
    const path = m.buffer(260);
    assert.equal(answer(SPFILENOTIFY.NEEDMEDIA, media, path), FILEOP.DOIT);
    assert.equal(m.readCString(path, 260), 'C:\\disk');
    assert.equal(m.fns.SetupDefaultQueueCallbackA.argBytes, 16);
});

test('a file queue is a handle, closed once', async()=>{
    const m = await machine();
    const queue = m.fns.SetupOpenFileQueue.handler();
    assert.notEqual(queue, INVALID_HANDLE_VALUE);
    assert.equal(m.fns.SetupCloseFileQueue.handler([queue]), 1);
    assert.equal(m.fns.SetupCloseFileQueue.handler([queue]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});

test('an OS component is registered, found and forgotten by its GUID', async()=>{
    const m = await machine();
    const DATA = 0xdc;
    const EXCEPTION = 0x454;
    const guid = m.buffer(16);
    [0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x78, 0x56, 1, 2, 3, 4, 5, 6, 7, 8]
        .forEach((b, i)=>m.view.setUint8(guid + i, b));
    const data = m.buffer(DATA);
    const exception = m.buffer(EXCEPTION);
    m.view.setUint32(data, DATA, true);
    m.view.setUint32(exception, EXCEPTION, true);

    assert.equal(m.fns.SetupQueryRegisteredOsComponent.handler([guid, data, exception]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND, 'the code a caller tests for');

    for (let i = 0; i < 16; i++)
    {
        m.view.setUint8(data + 4 + i, m.view.getUint8(guid + i));
    }
    m.view.setUint16(data + 100, 0x4321, true);
    m.view.setUint16(exception + 50, 0x1234, true);
    assert.equal(m.fns.SetupRegisterOsComponent.handler([data, exception]), 1);

    const readData = m.buffer(DATA);
    const readException = m.buffer(EXCEPTION);
    m.view.setUint32(readData, DATA, true);
    m.view.setUint32(readException, EXCEPTION, true);
    assert.equal(m.fns.SetupQueryRegisteredOsComponent.handler([guid, readData, readException]), 1);
    assert.equal(m.view.getUint16(readData + 100, true), 0x4321);
    assert.equal(m.view.getUint16(readException + 50, true), 0x1234);
    m.view.setUint32(readData, DATA - 4, true);
    assert.equal(m.fns.SetupQueryRegisteredOsComponent.handler([guid, readData, readException]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_USER_BUFFER, 'a structure of another size');

    assert.equal(m.fns.SetupUnRegisterOsComponent.handler([guid]), 1);
    assert.equal(m.fns.SetupUnRegisterOsComponent.handler([guid]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
});

test('SetupCopyOEMInf puts an INF in the INF directory as oemN.inf, once', async()=>{
    // Wine's setupapi test_copy_oem_inf.
    const m = await machine();
    const ERROR_FILE_EXISTS = 80;
    const SP_COPY_REPLACEONLY = 0x2;
    const SP_COPY_NOOVERWRITE = 0x8;
    const copy = (/** @type {number[]} */ args)=>m.fns.SetupCopyOEMInfA.handler(args);
    assert.equal(copy([0, 0, 0, SP_COPY_NOOVERWRITE, 0, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(copy([m.str(''), 0, 0, SP_COPY_NOOVERWRITE, 0, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
    assert.equal(copy([m.str('C:\\src\\none.inf'), 0, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);

    m.file('C:\\src\\driver.inf',
        '[Version]\r\nSignature="$Chicago$"\r\nCatalogFile=driver.cat\r\n');
    m.file('C:\\src\\driver.cat', 'catalog');
    m.file('C:\\WINDOWS\\inf\\oem0.inf', 'someone else\'s');
    const inf = m.str('C:\\src\\driver.inf');
    assert.equal(copy([inf, 0, 1, SP_COPY_REPLACEONLY, 0, 0, 0, 0]), 0,
        'replace-only with nothing to replace');
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);

    const dest = m.buffer(260);
    const size = m.buffer(4);
    const part = m.buffer(4);
    assert.equal(copy([inf, 0, 1, 0, dest, 260, size, part]), 1);
    assert.equal(m.lastError(), 0);
    assert.equal(m.readCString(dest, 260), 'C:\\WINDOWS\\inf\\oem1.inf', 'the first free number');
    assert.equal(m.u32(size), 24, 'the terminator counted');
    assert.equal(m.u32(part), dest + 15, 'the file part');
    assert.match(m.contents('C:\\WINDOWS\\inf\\oem1.inf') ?? '', /CatalogFile=driver.cat/);
    assert.equal(m.contents(
        'C:\\WINDOWS\\system32\\CatRoot\\{F750E6C3-38EE-11D1-85E5-00C04FC295EE}\\oem1.CAT'),
    'catalog', 'the catalog goes into the catalog store under the same number');

    assert.equal(copy([inf, 0, 1, 0, dest, 260, 0, 0]), 1, 'already there');
    assert.equal(m.readCString(dest, 260), 'C:\\WINDOWS\\inf\\oem1.inf');
    assert.equal(m.contents('C:\\WINDOWS\\inf\\oem2.inf'), null, 'and not copied twice');
    assert.equal(copy([inf, 0, 1, SP_COPY_REPLACEONLY, dest, 260, 0, 0]), 1);
    assert.equal(copy([inf, 0, 1, SP_COPY_NOOVERWRITE, dest, 260, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_EXISTS);
    assert.equal(m.readCString(dest, 260), 'C:\\WINDOWS\\inf\\oem1.inf', 'naming the one there');
    assert.equal(copy([inf, 0, 1, 0, dest, 5, size, 0]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(m.fns.SetupCopyOEMInfA.argBytes, 32);
});

test('this machine\'s device tree has no devices to enumerate or change', async()=>{
    // Wine's setupapi test_get_class_devs for the arguments; every class is
    // empty here, so a set enumerates nothing.
    const m = await machine();
    const ERROR_NO_MORE_ITEMS = 259;
    const ERROR_NO_SUCH_DEVINST = 0xe000020b;
    const DIGCF_PRESENT = 0x2;
    const DIGCF_ALLCLASSES = 0x4;
    const guid = m.buffer(16);
    assert.equal(m.fns.SetupDiGetClassDevsA.handler([0, 0, 0, 0]), INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'no class, and not all of them');
    assert.equal(m.fns.SetupDiGetClassDevsA.handler([0, m.str(''), 0, DIGCF_ALLCLASSES]),
        INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_INVALID_DATA);
    assert.equal(m.fns.SetupDiGetClassDevsA.handler([0, m.str('ROOT\\'), 0, DIGCF_ALLCLASSES]),
        INVALID_HANDLE_VALUE);
    assert.equal(m.lastError(), ERROR_INVALID_DATA);

    const set = m.fns.SetupDiGetClassDevsA.handler([guid, 0, 0, DIGCF_PRESENT]);
    assert.notEqual(set, INVALID_HANDLE_VALUE);
    const device = m.buffer(28);
    m.view.setUint32(device, 28, true);
    assert.equal(m.fns.SetupDiEnumDeviceInfo.handler([set, 0, device]), 0);
    assert.equal(m.lastError(), ERROR_NO_MORE_ITEMS);
    m.view.setUint32(device, 20, true);
    assert.equal(m.fns.SetupDiEnumDeviceInfo.handler([set, 0, device]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_USER_BUFFER, 'an SP_DEVINFO_DATA of the wrong size');
    m.view.setUint32(device, 28, true);
    assert.equal(m.fns.SetupDiGetDeviceRegistryPropertyA.handler([set, device, 0, 0, 0, 0, 0]),
        0);
    assert.equal(m.lastError(), ERROR_NO_SUCH_DEVINST);
    assert.equal(m.fns.SetupDiSetDeviceRegistryPropertyA.handler([set, device, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_NO_SUCH_DEVINST);
    assert.equal(m.fns.SetupDiDestroyDeviceInfoList.handler([set]), 1);
    assert.equal(m.fns.SetupDiDestroyDeviceInfoList.handler([set]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
    assert.equal(m.fns.SetupDiEnumDeviceInfo.handler([set, 0, device]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});
