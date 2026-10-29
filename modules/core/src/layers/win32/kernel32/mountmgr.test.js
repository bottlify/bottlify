/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IOCTL_MOUNTMGR_QUERY_POINTS, mountManagerControl } from './mountmgr.js';
import { mountPointsOf, volumeName } from './drives.js';

const points = mountPointsOf({ drives: ()=>['C', 'E'] });

/** @param {string} text */
const utf16 = text=>new Uint8Array(new Uint16Array([...text].map(c=>c.charCodeAt(0))).buffer);

/**
 * A MOUNTMGR_MOUNT_POINT naming one field, the name after it.
 *
 * @param {number} field 0 the link, 8 the unique ID, 16 the device
 * @param {Uint8Array} bytes
 */
const asking = (field, bytes)=>{
    const input = new Uint8Array(24 + bytes.length);
    const view = new DataView(input.buffer);
    view.setUint32(field, 24, true);
    view.setUint16(field + 4, bytes.length, true);
    input.set(bytes, 24);
    return input;
};

test('each drive is mounted by its letter and its volume name, one ID for both', ()=>{
    assert.deepEqual(points.map(point=>point.link), ['\\DosDevices\\C:',
        `\\??\\${volumeName('C').slice(4, -1)}`, '\\DosDevices\\E:',
        `\\??\\${volumeName('E').slice(4, -1)}`]);
    assert.deepEqual(points[0].id, points[1].id);
    assert.notDeepEqual(points[0].id, points[2].id);
    assert.equal(points[2].device, '\\Device\\HarddiskVolume2');
});

test('an input naming a field narrows the list to what matches it', ()=>{
    const all = mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS, new Uint8Array(24), 4096);
    assert.equal(all.status, 0);
    assert.equal(new DataView(/** @type {Uint8Array} */ (all.output).buffer).getUint32(4, true), 4);

    const byLetter = mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS,
        asking(0, utf16('\\dosdevices\\e:')), 4096);
    const view = new DataView(/** @type {Uint8Array} */ (byLetter.output).buffer);
    assert.equal(view.getUint32(4, true), 1, 'a name matches whatever its case');
    assert.equal(view.getUint32(0, true), byLetter.information);

    const byId = mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS,
        asking(8, points[0].id), 4096);
    assert.equal(new DataView(/** @type {Uint8Array} */ (byId.output).buffer).getUint32(4, true),
        2, 'both links of the volume');

    const none = mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS,
        asking(16, utf16('\\Device\\Nothing')), 4096);
    assert.equal(none.status >>> 0, 0xc0000034, 'STATUS_OBJECT_NAME_NOT_FOUND');

    const outside = new Uint8Array(24);
    new DataView(outside.buffer).setUint32(0, 20, true);
    new DataView(outside.buffer).setUint16(4, 8, true);
    assert.equal(mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS, outside, 4096).status
        >>> 0, 0xc000000d, 'a name past the input');
});

test('every offset lands inside the output, each name on a UTF-16 boundary', ()=>{
    const { output, information } = mountManagerControl(points, IOCTL_MOUNTMGR_QUERY_POINTS,
        new Uint8Array(24), 4096);
    const bytes = /** @type {Uint8Array} */ (output);
    const view = new DataView(bytes.buffer);
    assert.equal(bytes.length, information);
    for (let index = 0; index < 4; index++)
    {
        for (const field of [0, 8, 16])
        {
            const offset = view.getUint32(8 + index * 24 + field, true);
            const length = view.getUint16(8 + index * 24 + field + 4, true);
            assert.ok(offset >= 8 + 4 * 24 && offset + length <= bytes.length);
            assert.equal(offset % 2, 0);
        }
    }
    assert.equal(mountManagerControl(points, 0x6d0004, new Uint8Array(24), 4096).status >>> 0,
        0xc0000010, 'a code the manager does not answer');
});
