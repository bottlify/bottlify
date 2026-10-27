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
import { decodeAnsi } from '../kernel32/locale.js';

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
const SPINST_REGISTRY = 0x04;
const SPINST_FILES = 0x10;

/** Where the tests put their arguments; the heap starts above them. */
const ARG = 0x1000;
const HEAP = 0x20000;

/** @param {Record<string, any>} [extra]  More of the host. */
async function machine(extra = {}){
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
        return decodeAnsi(bytes.subarray(at, end));
    };
    /** @param {number} at @param {number} max  In bytes. */
    const readWideString = (at, max)=>{
        let text = '';
        for (let index = at; index + 1 < at + max; index += 2)
        {
            const unit = view.getUint16(index, true);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };
    const fns = createSetupapiFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readCString,
        readWideString,
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
        keyHandle: path=>(hive.open(/** @type {any} */ (hive.root(0x80000002)), path) ? 0x7700 : 0),
        ...extra,
    });

    let argAt = ARG;
    /** @param {string} text */
    const str = text=>{
        const at = argAt;
        bytes.set([...text, '\0'].map(c=>c.charCodeAt(0)), at);
        argAt += text.length + 16;
        return at;
    };
    /** @param {string} text */
    const wstr = text=>{
        const at = argAt;
        [...text, '\0'].forEach((c, index)=>view.setUint16(at + index * 2, c.charCodeAt(0), true));
        argAt += text.length * 2 + 16;
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
        fns, view, errors, str, wstr, buffer, file, contents, callback, readCString,
        readWideString, volume, hive,
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
    // No device, so no interface of any class -- once the arguments pass.
    const face = m.buffer(28);
    m.view.setUint32(face, 28, true);
    assert.equal(m.fns.SetupDiEnumDeviceInterfaces.handler([set, 0, guid, 0, face]), 0);
    assert.equal(m.lastError(), ERROR_NO_MORE_ITEMS);
    assert.equal(m.fns.SetupDiEnumDeviceInterfaces.handler([set, 0, 0, 0, face]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'no interface class');
    m.view.setUint32(face, 32, true);
    assert.equal(m.fns.SetupDiEnumDeviceInterfaces.handler([set, 0, guid, 0, face]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_USER_BUFFER, 'an interface data of the wrong size');
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

test('a line\'s fields one at a time, by index: the key is field 0', async()=>{
    const m = await machine();
    m.file('C:\\src\\t.inf', [INF, '[Lone]', 'only', 'a,b'].join('\r\n'));
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\t.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const context = m.buffer(16);
    const out = m.buffer(64);
    const size = m.buffer(4);
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Section'), 0, context]), 1);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 0, out, 64, size]), 1);
    assert.equal(m.readCString(out, 64), 'Key1');
    assert.equal(m.u32(size), 5);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 3, out, 64, size]), 1);
    assert.equal(m.readCString(out, 64), 'Field3');
    assert.equal(m.u32(size), 7, 'the terminator counted');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 2, 0, 0, size]), 1,
        'a NULL buffer asks for the size');
    assert.equal(m.u32(size), 7);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 2, out, 6, size]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 4, out, 64, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'past the last field');

    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Lone'), 0, context]), 1);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 0, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'only', 'a lone field is the key as well');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 1, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'only');
    assert.equal(m.fns.SetupFindNextLine.handler([context, context]), 1);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 0, out, 64, 0]), 0,
        'several fields and no = have no key');
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 2, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'b');
});

test('a line by its index in a section', async()=>{
    const m = await machine();
    m.file('C:\\src\\t.inf', INF);
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\t.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const context = m.buffer(16);
    const out = m.buffer(64);
    assert.equal(m.fns.SetupGetLineByIndexA.handler([inf, m.str('section'), 1, context]), 1);
    assert.equal(m.lastError(), 0);
    assert.equal(m.fns.SetupGetLineTextA.handler([context, 0, 0, 0, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'Field4,Field5');
    assert.equal(m.fns.SetupGetLineByIndexA.handler([inf, m.str('Section'), 2, context]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND, 'past the end');
    assert.equal(m.fns.SetupGetLineByIndexA.handler([inf, m.str('Nowhere'), 0, context]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND, 'no such section');
    assert.equal(m.fns.SetupGetLineByIndexA.handler([0x999, m.str('Section'), 0, context]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});

test('user DIRIDs are the INF\'s own, in its text and where its files go', async()=>{
    const m = await machine();
    m.file('C:\\src\\ids.inf', ['[Version]', 'Signature="$Chicago$"', '[Install]',
        'CopyFiles=Files', '[Paths]', 'Where=%32768%\\sub,%32769%,%10%',
        '[SourceDisksNames]', '1="The disk"', '[SourceDisksFiles]', 'a.dll=1',
        '[DestinationDirs]', 'Files=32768,bin', '[Files]', 'a.dll', ''].join('\r\n'));
    m.file('C:\\src\\a.dll', 'A');
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\ids.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const out = m.buffer(128);
    const context = m.buffer(16);

    assert.equal(m.fns.SetupSetDirectoryIdA.handler([inf, 0x7fff, m.str('C:\\x')]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'below DIRID_USER');
    assert.equal(m.fns.SetupSetDirectoryIdA.handler([0x999, 0x8000, m.str('C:\\x')]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
    assert.equal(m.fns.SetupSetDirectoryIdA.handler([inf, 0x8000, m.str('C:\\App\\')]), 1);
    assert.equal(m.fns.SetupSetDirectoryIdA.handler([inf, 0x8001, m.str('C:\\Other')]), 1);

    assert.equal(m.fns.SetupGetLineTextA.handler([0, inf, m.str('Paths'), m.str('Where'), out,
        128, 0]), 1);
    assert.equal(m.readCString(out, 128), 'C:\\App\\sub,C:\\Other,C:\\WINDOWS');
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Paths'), 0, context]), 1);
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 2, out, 128, 0]), 1);
    assert.equal(m.readCString(out, 128), 'C:\\Other');

    assert.equal(m.fns.SetupSetDirectoryIdA.handler([inf, 0x8001, 0]), 1, 'NULL unassigns');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 2, out, 128, 0]), 1);
    assert.equal(m.readCString(out, 128), '%32769%', 'left as written');

    const forward = m.callback(([given, message, param1, param2])=>
        m.fns.SetupDefaultQueueCallbackA.handler([given, message, param1, param2]));
    assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, inf, m.str('Install'),
        SPINST_FILES, 0, m.str('C:\\src'), 0, forward, 0, 0, 0]), 1);
    assert.equal(m.contents('C:\\App\\bin\\a.dll'), 'A', 'DestinationDirs by a user DIRID');

    assert.equal(m.fns.SetupSetDirectoryIdA.handler([inf, 0, 0]), 1, 'id 0 clears them all');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 1, out, 128, 0]), 1);
    assert.equal(m.readCString(out, 128), '%32768%\\sub');
});

test('another INF appended to an open one, by name or as its LayoutFile', async()=>{
    const m = await machine();
    m.file('C:\\src\\main.inf', ['[Version]', 'Signature="$Chicago$"',
        'LayoutFile=lay.inf', '[Section]', 'Key1=one', ''].join('\r\n'));
    m.file('C:\\WINDOWS\\inf\\lay.inf', ['[Version]', 'Signature="$Chicago$"',
        '[SourceDisksNames]', '1=%Disk%', '[Strings]', 'Disk="Layout disk"', ''].join('\r\n'));
    m.file('C:\\src\\more.inf', ['[Version]', 'Signature="$Chicago$"', '[Section]', 'Key2=two',
        '[Extra]', 'Key3=three', ''].join('\r\n'));
    m.file('C:\\src\\broken.inf', ['[Version]', 'Signature="$Chicago$"', '[Bad', ''].join('\r\n'));
    m.file('C:\\src\\plain.inf', ['[Version]', 'Signature="$Chicago$"', ''].join('\r\n'));
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\main.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const out = m.buffer(64);
    const context = m.buffer(16);
    const line = m.buffer(4);

    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([m.str('C:\\src\\more.inf'), inf,
        0]), 1);
    assert.equal(m.fns.SetupGetLineByIndexA.handler([inf, m.str('Section'), 1, context]), 1,
        'a section of the same name gets the lines');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 1, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'two');
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Extra'), 0, context]), 1,
        'a new section is found');
    assert.equal(m.fns.SetupGetStringFieldA.handler([context, 1, out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'three');

    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([0, inf, 0]), 1,
        'NULL appends the LayoutFile, a bare name from the inf directory');
    assert.equal(m.fns.SetupGetLineTextA.handler([0, inf, m.str('SourceDisksNames'), m.str('1'),
        out, 64, 0]), 1);
    assert.equal(m.readCString(out, 64), 'Layout disk');

    const plain = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\plain.inf'), 0,
        INF_STYLE_WIN4, 0]);
    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([0, plain, 0]), 0);
    assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND, 'no LayoutFile to append');
    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([m.str('C:\\src\\none.inf'), inf,
        0]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([m.str('C:\\src\\broken.inf'), inf,
        line]), 0);
    assert.equal(m.lastError(), 0xe0000001, 'ERROR_BAD_SECTION_NAME_LINE');
    assert.equal(m.u32(line), 3);
    assert.equal(await m.fns.SetupOpenAppendInfFileA.handler([m.str('C:\\src\\more.inf'), 0x999,
        0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});

test('the default callback\'s context is a block of its own, given back once', async()=>{
    const m = await machine();
    const one = m.fns.SetupInitDefaultQueueCallback.handler([0x1234]);
    const two = m.fns.SetupInitDefaultQueueCallbackEx.handler([0x1234, 0, 0, 0, 0]);
    assert.notEqual(one, 0);
    assert.notEqual(two, 0);
    assert.notEqual(one, two);
    assert.equal(m.fns.SetupInitDefaultQueueCallbackEx.argBytes, 20);
    m.fns.SetupTermDefaultQueueCallback.handler([one]);
    m.fns.SetupTermDefaultQueueCallback.handler([two]);
    m.fns.SetupTermDefaultQueueCallback.handler([0]);
});

test('copies queued one by one, then committed through the callback', async()=>{
    const m = await machine();
    m.volume.mkdir('C:\\src\\disk');
    m.file('C:\\src\\disk\\one.dll', 'ONE');
    m.file('C:\\src\\two.dll', 'TWO');
    const queue = m.fns.SetupOpenFileQueue.handler();
    assert.equal(m.fns.SetupQueueCopyA.handler([queue, m.str('C:\\src'), m.str('disk'),
        m.str('one.dll'), m.str('Disk'), 0, m.str('C:\\dst\\lib'), 0, 0]), 1);
    assert.equal(m.fns.SetupQueueCopyA.handler([queue, m.str('C:\\src'), 0, m.str('two.dll'), 0,
        0, m.str('C:\\dst'), m.str('renamed.dll'), 0]), 1);
    assert.equal(m.fns.SetupQueueCopyA.handler([queue, m.str('C:\\src'), 0, 0, 0, 0,
        m.str('C:\\dst'), 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'no source name');
    assert.equal(m.fns.SetupQueueCopyA.handler([queue, m.str('C:\\src'), 0, m.str('two.dll'), 0,
        0, 0, 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'no target directory');
    assert.equal(m.fns.SetupQueueCopyA.handler([0x999, m.str('C:\\src'), 0, m.str('two.dll'), 0,
        0, m.str('C:\\dst'), 0, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);

    /** @type {any[]} */
    const heard = [];
    const forward = m.callback(([context, message, param1, param2])=>{
        if (message === SPFILENOTIFY.STARTCOPY)
        {
            heard.push([m.readCString(m.u32(param1 + 4), 260), m.readCString(m.u32(param1), 260)]);
        }
        assert.equal(context, 0x55);
        return m.fns.SetupDefaultQueueCallbackA.handler([context, message, param1, param2]);
    });
    assert.equal(await m.fns.SetupCommitFileQueueA.handler([0, queue, forward, 0x55]), 1);
    assert.equal(m.lastError(), 0);
    assert.deepEqual(heard, [['C:\\src\\disk\\one.dll', 'C:\\dst\\lib\\one.dll'],
        ['C:\\src\\two.dll', 'C:\\dst\\renamed.dll']]);
    assert.equal(m.contents('C:\\dst\\lib\\one.dll'), 'ONE');
    assert.equal(m.contents('C:\\dst\\renamed.dll'), 'TWO');

    const missing = m.fns.SetupOpenFileQueue.handler();
    m.fns.SetupQueueCopyA.handler([missing, m.str('C:\\src'), 0, m.str('none.dll'), 0, 0,
        m.str('C:\\dst'), 0, 0]);
    assert.equal(await m.fns.SetupCommitFileQueueA.handler([0, missing, forward, 0x55]), 0);
    assert.equal(m.lastError(), ERROR_FILE_NOT_FOUND);
    assert.equal(m.fns.SetupCommitFileQueueA.handler([0, 0x999, forward, 0]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});

test('a line\'s fields from an index on, as one hexadecimal byte each', async()=>{
    const m = await machine();
    m.file('C:\\src\\t.inf', [INF, '[Bytes]', 'Data=001,ff,0x7A', 'Bad=1,100', 'Odd=1,zz']
        .join('\r\n'));
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\t.inf'), 0,
        INF_STYLE_WIN4, 0]);
    const context = m.buffer(16);
    const out = m.buffer(8);
    const size = m.buffer(4);
    assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Bytes'), m.str('Data'), context]),
        1);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 1, out, 8, size]), 1);
    assert.deepEqual([...new Uint8Array(m.view.buffer, out, 3)], [0x01, 0xff, 0x7a]);
    assert.equal(m.u32(size), 3);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 2, 0, 0, size]), 1,
        'a NULL buffer asks for the size');
    assert.equal(m.u32(size), 2);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 1, out, 2, size]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 0, out, 8, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'field 0 is not data');
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 4, out, 8, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_PARAMETER, 'past the last field');
    assert.equal(m.fns.SetupFindNextLine.handler([context, context]), 1);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 1, out, 8, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_DATA, 'more than a byte');
    assert.equal(m.fns.SetupFindNextLine.handler([context, context]), 1);
    assert.equal(m.fns.SetupGetBinaryField.handler([context, 1, out, 8, size]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_DATA, 'not hexadecimal');
});

test('a section\'s line count, -1 for a section that is not there', async()=>{
    // Wine's setupapi test_GLE: a missing section is ERROR_SECTION_NOT_FOUND
    // here, where the line calls say ERROR_LINE_NOT_FOUND.
    const m = await machine();
    m.file('C:\\src\\t.inf', [INF, '[Empty]', ''].join('\r\n'));
    const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\t.inf'), 0,
        INF_STYLE_WIN4, 0]);
    assert.equal(m.fns.SetupGetLineCountA.handler([inf, m.str('section')]), 2);
    assert.equal(m.lastError(), 0);
    assert.equal(m.fns.SetupGetLineCountA.handler([inf, m.str('Empty')]), 0);
    assert.equal(m.fns.SetupGetLineCountA.handler([inf, m.str('Section.NT5')]), -1);
    assert.equal(m.lastError(), 0xe0000101);
    assert.equal(m.fns.SetupGetLineCountA.handler([0x999, m.str('Section')]), -1);
    assert.equal(m.lastError(), ERROR_INVALID_HANDLE);
});

test('SPINST_REGISTRY carries out a section\'s DelReg and AddReg, HKR the predefined key named',
    async()=>{
        const m = await machine();
        m.file('C:\\src\\reg.inf', [
            '[Version]', 'Signature="$Chicago$"',
            '[Install]', 'DelReg=Old', 'AddReg=New', 'UpdateInis=Ini',
            '[Old]', 'HKLM,Software\\Product,Stale',
            '[New]', 'HKLM,Software\\Product,Path,,"%11%\\product.dll"',
            'HKR,Software\\Product,Relative,0x00010001,7', '',
        ].join('\r\n'));
        const machineRoot = m.hive.root(0x80000002);
        const product = m.hive.create(/** @type {any} */ (machineRoot), 'Software\\Product').key;
        m.hive.setValue(product, 'Stale', 1, Uint8Array.of(0x78, 0));
        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\reg.inf'), 0,
            INF_STYLE_WIN4, 0]);
        assert.equal(await m.fns.SetupInstallFromInfSectionA.handler([0, inf, m.str('Install'),
            SPINST_REGISTRY, 0x80000001, 0, 0, 0, 0, 0, 0]), 1);
        assert.equal(m.hive.getValue(product, 'Stale'), null);
        assert.equal(new TextDecoder().decode(m.hive.getValue(product, 'Path')?.data),
            'C:\\WINDOWS\\system32\\product.dll\0');
        const user = m.hive.open(/** @type {any} */ (m.hive.root(0x80000001)),
            'Software\\Product');
        assert.deepEqual([...(user ? m.hive.getValue(user, 'Relative')?.data ?? [] : [])],
            [7, 0, 0, 0], 'HKR is HKEY_CURRENT_USER here');
    });

test('a line\'s fields are counted, read as integers, and its section\'s next match found',
    async()=>{
        // Wine's setupapi test_SetupGetIntField and test_GLE.
        const m = await machine();
        m.file('C:\\src\\n.inf', [
            '[Version]', 'Signature="$Chicago$"', '[Section]',
            'Key=48,0x4,Field1,,-12,017', '123=x', 'Other=1', 'Key2=a', 'Key=last',
        ].join('\r\n'));
        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\n.inf'), 0,
            INF_STYLE_WIN4, 0]);
        const context = m.buffer(16);
        const value = m.buffer(4);
        assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Section'), 0, context]), 1);
        assert.equal(m.fns.SetupGetFieldCount.handler([context]), 6, 'the key not counted');
        /** @param {number} index */
        const int = index=>{
            m.view.setInt32(value, -1, true);
            const ok = m.fns.SetupGetIntField.handler([context, index, value]);
            return ok ? m.view.getInt32(value, true) : `error ${m.lastError()}`;
        };
        assert.equal(int(1), 48);
        assert.equal(int(2), 4, 'hexadecimal by its prefix');
        assert.equal(int(3), `error ${ERROR_INVALID_DATA}`);
        assert.equal(int(4), 0, 'an empty field is 0');
        assert.equal(int(5), -12);
        assert.equal(int(6), 15, 'octal by its leading zero');
        assert.equal(int(0), `error ${ERROR_INVALID_DATA}`, 'the key, which is no number');
        assert.equal(int(7), `error ${ERROR_INVALID_PARAMETER}`);

        assert.equal(m.fns.SetupFindNextMatchLineA.handler([context, m.str('KEY'), context]), 1);
        assert.equal(m.view.getUint32(context + 12, true), 4, 'the next Key, case aside');
        assert.equal(m.fns.SetupFindNextMatchLineA.handler([context, m.str('Other'), context]),
            0, 'only after the line given');
        assert.equal(m.lastError(), ERROR_LINE_NOT_FOUND);
        assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Section'), m.str('123'),
            context]), 1);
        assert.equal(m.fns.SetupFindNextMatchLineA.handler([context, 0, context]), 1,
            'no key, the next line');
        assert.equal(m.view.getUint32(context + 12, true), 2);
    });

test('sections enumerate in file order, and the W forms count WCHARs', async()=>{
    // Wine's setupapi test_enum_sections.
    const ERROR_NO_MORE_ITEMS = 259;
    const m = await machine();
    m.file('C:\\src\\e.inf', ['[Version]', 'Signature="$Chicago$"', '[s1]', 'foo=bar',
        '[Strings]', 'a=b'].join('\r\n'));
    const inf = await m.fns.SetupOpenInfFileW.handler([m.wstr('C:\\src\\e.inf'), 0,
        INF_STYLE_WIN4, 0]);
    assert.notEqual(inf, INVALID_HANDLE_VALUE, 'opened by its wide name');
    const needed = m.buffer(4);
    const out = m.buffer(64);
    assert.equal(m.fns.SetupEnumInfSectionsA.handler([inf, 1, 0, 0, needed]), 1);
    assert.equal(m.u32(needed), 3);
    assert.equal(m.fns.SetupEnumInfSectionsA.handler([inf, 1, 0, 64, needed]), 0);
    assert.equal(m.lastError(), ERROR_INVALID_USER_BUFFER, 'a size and no buffer');
    assert.equal(m.fns.SetupEnumInfSectionsA.handler([inf, 2, out, 64, needed]), 1);
    assert.equal(m.readCString(out, 64), 'Strings');
    assert.equal(m.fns.SetupEnumInfSectionsW.handler([inf, 0, out, 64, needed]), 1);
    assert.equal(m.readWideString(out, 64), 'Version');
    assert.equal(m.u32(needed), 8, 'characters, not bytes');
    assert.equal(m.fns.SetupEnumInfSectionsA.handler([inf, 3, out, 64, needed]), 0);
    assert.equal(m.lastError(), ERROR_NO_MORE_ITEMS);

    const context = m.buffer(16);
    assert.equal(m.fns.SetupFindFirstLineW.handler([inf, m.wstr('s1'), m.wstr('FOO'),
        context]), 1);
    assert.equal(m.fns.SetupGetLineTextW.handler([context, 0, 0, 0, out, 3, needed]), 0);
    assert.equal(m.lastError(), ERROR_INSUFFICIENT_BUFFER, 'three WCHARs are too few for four');
    assert.equal(m.fns.SetupGetLineTextW.handler([context, 0, 0, 0, out, 4, needed]), 1);
    assert.equal(m.readWideString(out, 64), 'bar');
    assert.equal(m.u32(needed), 4);
});

test('pSetupGetField hands out the field itself, wide, for as long as the INF is open',
    async()=>{
        // Wine's setupapi test_pSetupGetField: a field is kept to 4096 characters.
        const m = await machine();
        m.file('C:\\src\\f.inf', ['[Version]', 'Signature="$Windows NT$"', '[Branch]',
            `RTMQFE="%RTMGFE_NAME%",SP1RTM,${'a'.repeat(4097)}`, '[Strings]',
            'RTMQFE_NAME = "RTMQFE"'].join('\r\n'));
        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\f.inf'), 0,
            INF_STYLE_WIN4, 0]);
        const context = m.buffer(16);
        assert.equal(m.fns.SetupFindFirstLineA.handler([inf, m.str('Branch'), 0, context]), 1);
        const fields = [0, 1, 2, 3].map(index=>m.fns.pSetupGetField.handler([context, index]));
        assert.deepEqual(fields.slice(0, 3).map(at=>m.readWideString(at, 64)),
            ['RTMQFE', '%RTMGFE_NAME%', 'SP1RTM']);
        assert.equal(m.readWideString(fields[3], 10000).length, 4096);
        assert.equal(m.fns.pSetupGetField.handler([context, 1]), fields[1],
            'the same field, the same string');
        assert.equal(m.fns.pSetupGetField.handler([context, 4]), 0);
        assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    });

test('a file\'s source disk, the disk\'s details and a list\'s target are read from the INF',
    async()=>{
        // Wine's setupapi query tests.
        const m = await machine();
        m.file('C:\\src\\q.inf', [
            '[Version]', 'Signature="$Chicago$"', '[copy_section]', 'one.txt,,2', 'two.txt',
            'four.txt,five.txt', '[SourceDisksNames]',
            '2 = %SrcDiskName%, LANCOM\\LANtools\\lanconf.cab', '4=,,,here',
            '[SourceDisksFiles]', 'one.txt=2', 'two.txt=4,there', '[DestinationDirs]',
            'DefaultDestDir = 24, %DefaultDest%', 'copy_section = 10', '[Strings]',
            'DefaultDest = LANCOM', 'SrcDiskName = "LANCOM Software CD"',
        ].join('\r\n'));
        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\q.inf'), 0,
            INF_STYLE_WIN4, 0]);
        const id = m.buffer(4);
        const out = m.buffer(260);
        const needed = m.buffer(4);
        const ask = (/** @type {number} */ context, /** @type {string} */ name)=>
            (m.fns.SetupGetSourceFileLocationA.handler([inf, context, m.str(name), id, out, 260,
                needed]) ? [m.u32(id), m.readCString(out, 260)] : m.lastError());
        assert.deepEqual(ask(0, 'one.txt'), [2, '']);
        assert.equal(m.u32(needed), 1);
        assert.deepEqual(ask(0, 'two.txt'), [4, 'there']);
        assert.equal(ask(0, 'four.txt'), ERROR_LINE_NOT_FOUND);
        const context = m.buffer(16);
        m.fns.SetupFindFirstLineA.handler([inf, m.str('copy_section'), 0, context]);
        assert.deepEqual(ask(context, 'two.txt'), [2, ''],
            'with a context, the file its line copies, whatever the name');

        /** @param {number} what */
        const info = what=>(m.fns.SetupGetSourceInfoA.handler([inf, 2, what, out, 260, needed])
            ? [m.readCString(out, 260), m.u32(needed)] : m.lastError());
        assert.deepEqual(info(1), ['', 1], 'SRCINFO_PATH');
        assert.deepEqual(info(2), ['LANCOM\\LANtools\\lanconf.cab', 28], 'SRCINFO_TAGFILE');
        assert.deepEqual(info(3), ['LANCOM Software CD', 19], 'SRCINFO_DESCRIPTION');
        assert.equal(info(9), ERROR_INVALID_PARAMETER);

        /** @param {number} at @param {string | null} section */
        const target = (at, section)=>(m.fns.SetupGetTargetPathA.handler([inf, at,
            section === null ? 0 : m.str(section), out, 260, needed])
            ? m.readCString(out, 260) : m.lastError());
        assert.equal(target(0, 'copy_section'), 'C:\\WINDOWS', 'its own DestinationDirs entry');
        assert.equal(target(0, 'other'), 'C:\\LANCOM', 'the DefaultDestDir');
        m.view.setUint32(context + 8, 7, true);
        assert.equal(target(context, null), 'C:\\LANCOM', 'a context in no section: the default');

        const information = m.buffer(1024);
        assert.equal(m.fns.SetupGetInfInformationA.handler([m.str('C:\\src\\q.inf'), 2,
            information, 1024, needed]), 1);
        assert.equal(m.fns.SetupQueryInfFileInformationA.handler([information, 0, out, 260,
            needed]), 1);
        assert.equal(m.readCString(out, 260), 'C:\\src\\q.inf');
        assert.equal(m.fns.SetupQueryInfFileInformationA.handler([information, 1, out, 260,
            needed]), 0, 'one INF in it');
        assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
    });

test('a device set makes phantoms, registers them, and enumerates devices and interfaces',
    async()=>{
        // Wine's setupapi test_device_info, test_device_iface and test_get_class_devs.
        const ERROR_INVALID_DEVINST_NAME = 0xe0000205;
        const ERROR_DEVINST_ALREADY_EXISTS = 0xe0000207;
        const ERROR_NO_SUCH_DEVINST = 0xe000020b;
        const ERROR_NO_MORE_ITEMS = 259;
        const m = await machine();
        const guid = m.buffer(16);
        m.view.setUint32(guid, 0x6a55b5a4, true);
        const set = m.fns.SetupDiCreateDeviceInfoList.handler([guid, 0]);
        const device = m.buffer(28);
        m.view.setUint32(device, 28, true);
        assert.equal(m.fns.SetupDiCreateDeviceInfoA.handler([set, 0, guid, 0, 0, 0, device]), 0);
        assert.equal(m.lastError(), ERROR_INVALID_DEVINST_NAME, 'the name is checked first');
        assert.equal(m.fns.SetupDiCreateDeviceInfoA.handler([set, m.str('Root\\LEGACY_BOGUS\\0000'),
            guid, 0, 0, 0, device]), 1);
        assert.equal(m.fns.SetupDiCreateDeviceInfoA.handler([set, m.str('ROOT\\legacy_bogus\\0000'),
            guid, 0, 0, 0, 0]), 0);
        assert.equal(m.lastError(), ERROR_DEVINST_ALREADY_EXISTS);

        const id = m.buffer(64);
        const needed = m.buffer(4);
        assert.equal(m.fns.SetupDiGetDeviceInstanceIdA.handler([set, device, 0, 0, needed]), 0);
        assert.equal(m.u32(needed), 23, 'no buffer is too small a one');
        assert.equal(m.fns.SetupDiGetDeviceInstanceIdA.handler([set, device, id, 64, 0]), 1);
        assert.equal(m.readCString(id, 64), 'ROOT\\LEGACY_BOGUS\\0000');

        const face = m.buffer(28);
        m.view.setUint32(face, 28, true);
        assert.equal(m.fns.SetupDiCreateDeviceInterfaceA.handler([set, device, guid,
            m.str('Oogah'), 0, face]), 1);
        const detail = m.buffer(200);
        m.view.setUint32(detail, 5, true);
        assert.equal(m.fns.SetupDiGetDeviceInterfaceDetailA.handler([set, face, detail, 200, needed,
            0]), 1);
        const path = '\\\\?\\root#legacy_bogus#0000#{6a55b5a4-0000-0000-0000-000000000000}\\oogah';
        assert.equal(m.readCString(detail + 4, 196), path);
        assert.equal(m.u32(needed), 4 + path.length + 1, 'cbSize, the path and its terminator');

        const other = m.fns.SetupDiGetClassDevsA.handler([guid, 0, 0, 0]);
        const listed = m.buffer(28);
        m.view.setUint32(listed, 28, true);
        assert.equal(m.fns.SetupDiEnumDeviceInfo.handler([other, 0, listed]), 0,
            'a phantom is no other set\'s');
        assert.equal(m.lastError(), ERROR_NO_MORE_ITEMS);
        assert.equal(m.fns.SetupDiRegisterDeviceInfo.handler([set, device, 0, 0, 0, 0]), 1);
        const again = m.fns.SetupDiGetClassDevsA.handler([guid, 0, 0, 0]);
        assert.equal(m.fns.SetupDiEnumDeviceInfo.handler([again, 0, listed]), 1,
            'a registered device is every set\'s');
        assert.equal(m.u32(listed + 20), m.u32(device + 20), 'the same device node');

        assert.equal(m.fns.SetupDiRemoveDevice.handler([set, device]), 1);
        assert.equal(m.fns.SetupDiGetDeviceInstanceIdA.handler([set, device, id, 64, 0]), 0);
        assert.equal(m.lastError(), ERROR_NO_SUCH_DEVINST, 'removed, it has no id');
        assert.equal(m.fns.SetupDiEnumDeviceInterfaces.handler([set, 0, guid, 0, face]), 1);
        assert.equal(m.u32(face + 20), 4, 'its interfaces marked removed');
        for (const handle of [set, other, again])
        {
            assert.equal(m.fns.SetupDiDestroyDeviceInfoList.handler([handle]), 1);
        }
    });

test('a class installs from an INF and describes itself, and an install section is decorated',
    async()=>{
        // Wine's setupapi test_install_class, test_open_class_key and test_get_actual_section.
        const ERROR_INVALID_CLASS = 0xe0000206;
        const m = await machine();
        m.file('C:\\src\\class.inf', ['[Version]', 'Signature="$Chicago$"', 'Class=Bogus',
            'ClassGUID={6a55b5a4-3f65-11db-b704-0011955c2bdb}', '[ClassInstall32]',
            'AddReg=BogusClass.NT.AddReg', '[BogusClass.NT.AddReg]', 'HKR,,,,"Wine test devices"',
            '[section2]', '[section2.nt]'].join('\r\n'));
        const guid = m.buffer(16);
        m.view.setUint32(guid, 0x6a55b5a4, true);
        m.view.setUint16(guid + 4, 0x3f65, true);
        m.view.setUint16(guid + 6, 0x11db, true);
        [0xb7, 0x04, 0x00, 0x11, 0x95, 0x5c, 0x2b, 0xdb].forEach((byte, at)=>
            m.view.setUint8(guid + 8 + at, byte));
        const out = m.buffer(64);
        const needed = m.buffer(4);
        m.view.setUint32(needed, 123, true);
        assert.equal(m.fns.SetupDiGetClassDescriptionA.handler([guid, out, 64, needed]), 0);
        assert.equal(m.lastError(), ERROR_INVALID_CLASS);
        assert.equal(m.u32(needed), 123, 'the size untouched');
        assert.equal(m.fns.SetupDiOpenClassRegKeyExA.handler([guid, 0, 1, 0, 0]),
            INVALID_HANDLE_VALUE);

        assert.equal(m.fns.SetupDiInstallClassA.handler([0, m.str('C:\\src\\class.inf'), 8, 0]),
            0, 'DI_NOVCP and no queue');
        assert.equal(m.lastError(), ERROR_INVALID_PARAMETER);
        assert.equal(await m.fns.SetupDiInstallClassA.handler([0, m.str('C:\\src\\class.inf'), 0,
            0]), 1);
        assert.equal(m.fns.SetupDiGetClassDescriptionA.handler([guid, out, 64, needed]), 1);
        assert.equal(m.readCString(out, 64), 'Wine test devices');
        assert.equal(m.u32(needed), 18);
        assert.notEqual(m.fns.SetupDiOpenClassRegKeyExA.handler([guid, 0, 1, 0, 0]),
            INVALID_HANDLE_VALUE, 'the class key is there now');

        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\class.inf'), 0,
            INF_STYLE_WIN4, 0]);
        const extension = m.buffer(4);
        assert.equal(m.fns.SetupDiGetActualSectionToInstallA.handler([inf, m.str('section2'), out,
            64, needed, extension]), 1);
        assert.equal(m.readCString(out, 64), 'section2.NT');
        assert.equal(m.u32(extension), out + 8, 'the decoration in the caller\'s buffer');
        assert.equal(m.fns.SetupDiGetActualSectionToInstallA.handler([inf, m.str('other'), out,
            64, needed, extension]), 1);
        assert.equal(m.u32(extension), 0, 'none, no extension');
    });

test('SetupIterateCabinetW hands its callback the W structures: wide names, a WCHAR target',
    async()=>{
        // Wine's setupapi setupcab test of the W form.
        const m = await machine();
        m.file('C:\\src\\test.cab', storedCabinet([['tristram', 'tristram\n']]));
        const path = m.wstr('C:\\src\\test.cab');
        /** @type {string[]} */
        const seen = [];
        const handler = m.callback(([, message, param1])=>{
            if (message === SPFILENOTIFY.CABINETINFO)
            {
                seen.push(`info ${m.readWideString(m.u32(param1), 520)}`);
                return 0;
            }
            if (message === SPFILENOTIFY.FILEINCABINET)
            {
                seen.push(`file ${m.readWideString(m.u32(param1), 520)}`);
                [...'C:\\dst\\wide.out', '\0'].forEach((c, i)=>
                    m.view.setUint16(param1 + 18 + i * 2, c.charCodeAt(0), true));
                return FILEOP.DOIT;
            }
            seen.push(`done ${m.readWideString(m.u32(param1), 520)}`);
            return 0;
        });
        assert.equal(await m.fns.SetupIterateCabinetW.handler([path, 0, handler, 0]), 1);
        assert.deepEqual(seen, ['info C:\\src\\', 'file tristram', 'done C:\\dst\\wide.out']);
        assert.equal(m.contents('C:\\dst\\wide.out'), 'tristram\n');
    });

test('SetupPromptForDisk answers with the path when the file is already there, and asks no one',
    async()=>{
        // Wine's setupapi dialog tests.
        const m = await machine();
        m.file('C:\\src\\needed.dll', 'x');
        const IDF_CHECKFIRST = 0x100;
        const out = m.buffer(64);
        const length = m.buffer(4);
        /** @param {number} buffer @param {number} size @param {number} style */
        const prompt = (buffer, size, style = IDF_CHECKFIRST)=>m.fns.SetupPromptForDiskA.handler([
            0, 0, 0, m.str('C:\\src'), m.str('needed.dll'), 0, style, buffer, size, length]);
        assert.equal(prompt(out, 63), 0, 'DPROMPT_SUCCESS');
        assert.equal(m.readCString(out, 64), 'C:\\src');
        assert.equal(m.u32(length), 7);
        assert.equal(prompt(0, 0), 0, 'no buffer: the size alone');
        assert.equal(prompt(out, 6), 3, 'DPROMPT_BUFFERTOOSMALL');
        assert.equal(prompt(out, 63, 0), 1, 'asked for the disk: no one answers, cancelled');
    });

test('services are made from an install section\'s AddService lines, all four values wanted',
    async()=>{
        // Wine's setupapi install test_install_svc_from and test_driver_install.
        /** @type {any[]} */
        const made = [];
        const m = await machine({ createService: (/** @type {any} */ service)=>{
            made.push(service);
            return made.length > 1 ? 1073 : 0;
        } });
        m.file('C:\\src\\svc.inf', [
            '[Version]', 'Signature="$Chicago$"',
            '[Empty]',
            '[Short]', 'AddService=Winetest,,ShortSvc',
            '[ShortSvc]', 'ServiceType=1', 'StartType=4', 'ErrorControl=1',
            '[Good]', 'AddService=,2', 'AddService=Winetest,,GoodSvc',
            'AddService=Winetest,,GoodSvc',
            '[GoodSvc]', 'DisplayName="Wine test"', 'ServiceType=1', 'StartType=4',
            'ErrorControl=1', 'ServiceBinary=%12%\\winetest.sys', '',
        ].join('\r\n'));
        const inf = await m.fns.SetupOpenInfFileA.handler([m.str('C:\\src\\svc.inf'), 0,
            INF_STYLE_WIN4, 0]);
        for (const [section, error] of /** @type {[string, number][]} */ ([
            ['Missing', 0xe0000101], ['Empty', 0xe0000101], ['Short', 0xe0000217]]))
        {
            assert.equal(m.fns.SetupInstallServicesFromInfSectionA.handler([inf, m.str(section),
                0]), 0, section);
            assert.equal(m.lastError(), error, section);
        }
        assert.equal(made.length, 0);
        assert.equal(m.fns.SetupInstallServicesFromInfSectionW.handler([inf, m.wstr('Good'), 0]),
            1, 'a service already there is the one asked for');
        assert.equal(m.lastError(), 0);
        assert.deepEqual(made[0], { name: 'Winetest', displayName: 'Wine test',
            binary: 'C:\\WINDOWS\\system32\\drivers\\winetest.sys', type: 1, start: 4,
            errorControl: 1, startName: null });
        assert.equal(made.length, 2, 'a line with no name makes none');
    });

test('InstallHinfSection installs the decorated section, then its services', async()=>{
    /** @type {string[]} */
    const made = [];
    const m = await machine({ createService: (/** @type {any} */ service)=>{
        made.push(service.name);
        return 0;
    } });
    m.file('C:\\src\\hinf.inf', [
        '[Version]', 'Signature="$Chicago$"',
        '[Install.NT]', 'AddReg=Reg',
        '[Install.NT.Services]', 'AddService=Hinf,,HinfSvc',
        '[HinfSvc]', 'ServiceType=1', 'StartType=4', 'ErrorControl=1', 'ServiceBinary=%11%\\h.sys',
        '[Reg]', 'HKLM,Software\\Hinf,Done,0x00010001,1', '',
    ].join('\r\n'));
    assert.equal(await m.fns.InstallHinfSectionA.handler([0, 0,
        m.str('Install 128 C:\\src\\hinf.inf'), 0]), 0);
    const key = m.hive.open(/** @type {any} */ (m.hive.root(0x80000002)), 'Software\\Hinf');
    assert.ok(key && m.hive.getValue(key, 'Done'), 'the .NT section, its AddReg done');
    assert.deepEqual(made, ['Hinf']);
});

test('DIRID 0 is empty, an unknown standard one the system directory\'s unknown', async()=>{
    const { standardDirids } = await import('./dirids.js');
    const dirid = standardDirids({ Windows: 'C:\\WINDOWS', System: 'C:\\WINDOWS\\system32' });
    assert.equal(dirid(0), '');
    assert.equal(dirid(99), 'C:\\WINDOWS\\system32\\unknown');
    assert.equal(dirid(0x8000), null, 'a user DIRID is the INF\'s own');
});
