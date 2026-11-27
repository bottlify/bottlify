/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FSCTL_DELETE_REPARSE_POINT, FSCTL_GET_REPARSE_POINT, FSCTL_SET_REPARSE_POINT,
    IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK, mountPointBuffer, namesDirectory,
    reparseRequest, reparseTarget,
} from './reparse.js';

const STATUS_SUCCESS = 0;
const STATUS_BUFFER_OVERFLOW = 0x80000005;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_INVALID_USER_BUFFER = 0xc00000e8;
const STATUS_INVALID_BUFFER_SIZE = 0xc0000206;
const STATUS_NOT_A_REPARSE_POINT = 0xc0000275;
const STATUS_IO_REPARSE_TAG_INVALID = 0xc0000276;
const STATUS_IO_REPARSE_TAG_MISMATCH = 0xc0000277;
const STATUS_IO_REPARSE_DATA_INVALID = 0xc0000278;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
const STATUS_DIRECTORY_NOT_EMPTY = 0xc0000101;

/**
 * A mount point's or a symbolic link's buffer as Wine's test builds one: the
 * substitute name at offset 0, the printed name "bogus" right after it.
 *
 * @param {number} tag @param {string} target @param {number} [flags]
 */
function linkBuffer(tag, target, flags = 0){
    const names = [...target, '\0', ...'bogus', '\0'];
    const head = 8 + 8 + (tag === IO_REPARSE_TAG_SYMLINK ? 4 : 0);
    const data = new Uint8Array(head + names.length * 2);
    const view = new DataView(data.buffer);
    view.setUint32(0, tag, true);
    view.setUint16(4, data.length - 8, true);
    view.setUint16(10, target.length * 2, true);
    view.setUint16(12, (target.length + 1) * 2, true);
    view.setUint16(14, 10, true);
    if (tag === IO_REPARSE_TAG_SYMLINK)
    {
        view.setUint32(16, flags, true);
    }
    names.forEach((character, at)=>view.setUint16(head + at * 2, character.charCodeAt(0), true));
    return data;
}

/** A volume of one directory and one file, keeping what is set on them. */
function volume(){
    /** @type {Map<string, { tag: number, data: Uint8Array | null, target: string | null }>} */
    const points = new Map();
    const entries = new Map([['C:\\T\\DIR', { isDirectory: true, size: 0 }],
        ['C:\\T\\FULL', { isDirectory: true, size: 0 }],
        ['C:\\T\\FILE', { isDirectory: false, size: 5 }],
        ['C:\\T\\EMPTY', { isDirectory: false, size: 0 }]]);
    return {
        points,
        /** @param {string} path */
        stat: path=>entries.get(path) ?? null,
        /** @param {string} path */
        reparseOf: path=>{
            const point = points.get(path);
            return point ? { tag: point.tag, data: point.data } : null;
        },
        /** @param {string} path @param {any} point */
        setReparse: (path, point)=>{
            if (path === 'C:\\T\\FULL' && point)
            {
                return 'DIRECTORY_NOT_EMPTY';
            }
            if (point)
            {
                points.set(path, point);
            }
            else
            {
                points.delete(path);
            }
            return null;
        },
    };
}

test('a reparse point is read back as it was set, cut to the room given', ()=>{
    const v = volume();
    const data = linkBuffer(IO_REPARSE_TAG_MOUNT_POINT, '\\??\\C:\\T\\FILE2');
    assert.equal(reparseRequest(v, 'C:\\T\\DIR', FSCTL_SET_REPARSE_POINT, data, false, 0).status,
        STATUS_SUCCESS);
    assert.equal(v.points.get('C:\\T\\DIR')?.target, 'C:\\T\\FILE2');
    const get = (/** @type {boolean} */ out, /** @type {number} */ room)=>
        reparseRequest(v, 'C:\\T\\DIR', FSCTL_GET_REPARSE_POINT, null, out, room);
    assert.equal(get(false, 0).status, STATUS_INVALID_USER_BUFFER, 'no buffer');
    assert.equal(get(true, 0).status, STATUS_INVALID_USER_BUFFER, 'no room');
    assert.equal(get(true, 27).status, STATUS_BUFFER_TOO_SMALL,
        'less than a REPARSE_GUID_DATA_BUFFER');
    assert.deepEqual(get(true, 28), { status: STATUS_BUFFER_OVERFLOW,
        output: data.subarray(0, 28), information: 28 });
    assert.deepEqual(get(true, data.length + 1),
        { status: STATUS_SUCCESS, output: data, information: data.length });
    assert.equal(reparseRequest(v, 'C:\\T\\FILE', FSCTL_GET_REPARSE_POINT, null, true, 1).status,
        STATUS_NOT_A_REPARSE_POINT);
});

test('a set takes a buffer exactly as long as it says, of a tag a point may have', ()=>{
    const v = volume();
    const set = (/** @type {string} */ path, /** @type {Uint8Array} */ data)=>
        reparseRequest(v, path, FSCTL_SET_REPARSE_POINT, data, false, 0).status;
    const mount = linkBuffer(IO_REPARSE_TAG_MOUNT_POINT, 'foobar');
    assert.equal(set('C:\\T\\FILE', mount), STATUS_NOT_A_DIRECTORY, 'a mount point on a file');
    assert.equal(set('C:\\T\\FULL', mount), STATUS_DIRECTORY_NOT_EMPTY);
    assert.equal(set('C:\\T\\DIR', mount.subarray(0, mount.length - 2)),
        STATUS_IO_REPARSE_DATA_INVALID, 'shorter than it says');
    assert.equal(set('C:\\T\\DIR', new Uint8Array(8)), STATUS_IO_REPARSE_TAG_INVALID, 'tag 0');
    assert.equal(set('C:\\T\\DIR', mount), STATUS_SUCCESS);
    assert.equal(v.points.get('C:\\T\\DIR')?.target, null,
        'a substitute name that is no NT path stands for nothing');

    // A tag of a program's own carries a GUID: 24 bytes of header.
    const custom = new Uint8Array(24 + 5);
    new DataView(custom.buffer).setUint32(0, 0xbeef, true);
    new DataView(custom.buffer).setUint16(4, 5, true);
    assert.equal(set('C:\\T\\FILE', custom), STATUS_SUCCESS);
    assert.deepEqual(v.points.get('C:\\T\\FILE'), { tag: 0xbeef, data: custom, target: null });

    const link = linkBuffer(IO_REPARSE_TAG_SYMLINK, 'x', 1);
    assert.equal(set('C:\\T\\FILE', link), STATUS_IO_REPARSE_DATA_INVALID,
        'a file holding data cannot become a link');
    assert.equal(set('C:\\T\\EMPTY', link), STATUS_SUCCESS);
});

test('a delete hands a bare header of the tag set, at the GUID buffer\'s head size', ()=>{
    const v = volume();
    reparseRequest(v, 'C:\\T\\DIR', FSCTL_SET_REPARSE_POINT,
        linkBuffer(IO_REPARSE_TAG_MOUNT_POINT, '\\??\\C:\\X'), false, 0);
    const del = (/** @type {Uint8Array | null} */ data)=>
        reparseRequest(v, 'C:\\T\\DIR', FSCTL_DELETE_REPARSE_POINT, data, false, 0).status;
    /** @param {number} tag @param {number} length @param {number} size */
    const header = (tag, length, size)=>{
        const data = new Uint8Array(size);
        new DataView(data.buffer).setUint32(0, tag, true);
        new DataView(data.buffer).setUint16(4, length, true);
        return data;
    };
    assert.equal(del(null), STATUS_INVALID_BUFFER_SIZE);
    assert.equal(del(new Uint8Array(1)), STATUS_IO_REPARSE_DATA_INVALID);
    assert.equal(del(header(IO_REPARSE_TAG_MOUNT_POINT, 8, 24)), STATUS_IO_REPARSE_DATA_INVALID,
        'with data');
    assert.equal(del(header(IO_REPARSE_TAG_MOUNT_POINT, 0, 28)), STATUS_IO_REPARSE_DATA_INVALID,
        'at another size');
    assert.equal(del(header(0, 0, 24)), STATUS_IO_REPARSE_TAG_INVALID);
    assert.equal(del(header(3, 0, 24)), STATUS_IO_REPARSE_TAG_MISMATCH);
    assert.equal(del(header(IO_REPARSE_TAG_MOUNT_POINT, 0, 24)), STATUS_SUCCESS);
    assert.equal(del(header(IO_REPARSE_TAG_MOUNT_POINT, 0, 24)), STATUS_NOT_A_REPARSE_POINT);
});

test('a link names a DOS path, a relative one beside it, a device nothing here', ()=>{
    const at = 'C:\\T\\LINK';
    assert.equal(reparseTarget(IO_REPARSE_TAG_MOUNT_POINT,
        linkBuffer(IO_REPARSE_TAG_MOUNT_POINT, '\\??\\C:\\T\\DIR\\'), at), 'C:\\T\\DIR');
    assert.equal(reparseTarget(IO_REPARSE_TAG_SYMLINK,
        linkBuffer(IO_REPARSE_TAG_SYMLINK, '.\\DIR\\..\\.\\DIR2\\.', 1), at), 'C:\\T\\DIR2');
    assert.equal(reparseTarget(IO_REPARSE_TAG_SYMLINK,
        linkBuffer(IO_REPARSE_TAG_SYMLINK, '\\Device\\NamedPipe\\', 0), at), null);
    assert.equal(reparseTarget(IO_REPARSE_TAG_MOUNT_POINT, new Uint8Array(10), at), undefined,
        'too short to name anything');
    // A junction kept without its buffer reads back as the mount point it is.
    const kept = mountPointBuffer('C:\\T\\DIR');
    assert.equal(reparseTarget(IO_REPARSE_TAG_MOUNT_POINT, kept, at), 'C:\\T\\DIR');
});

test('a junction kept without its buffer keeps a character past U+FFFF whole', ()=>{
    // Both of its surrogates, in each name: a buffer made by code point kept
    // the first alone and read back another path.
    const target = 'C:\\\u{1F4C1}x';
    const kept = mountPointBuffer(target);
    const view = new DataView(kept.buffer);
    assert.equal(view.getUint16(10, true), (4 + target.length) * 2, 'the substitute name');
    assert.equal(view.getUint16(14, true), target.length * 2, 'the printed name');
    assert.equal(reparseTarget(IO_REPARSE_TAG_MOUNT_POINT, kept, 'C:\\T\\LINK'), target);
});

test('a link names a directory when its substitute name ends in a separator', ()=>{
    assert.equal(namesDirectory(linkBuffer(IO_REPARSE_TAG_SYMLINK, 'testreparse_file\\', 1)), true);
    assert.equal(namesDirectory(linkBuffer(IO_REPARSE_TAG_SYMLINK, 'testreparse_file', 1)), false);
    assert.equal(namesDirectory(null), false);
});
