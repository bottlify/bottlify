/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceOpfsRejections } from './opfs-trace.js';

test('a failed file system call names itself, its entry and its caller', async()=>{
    class FileSystemDirectoryHandle
    {
        name = 'cache';
        /** @param {string} name */
        async getFileHandle(name){
            // As OPFS rejects: a DOMException with no stack of the caller.
            throw Object.assign(new DOMException(`${name} is gone`, 'NotFoundError'),
                { stack: undefined });
        }
    }
    const scope = { FileSystemDirectoryHandle };
    assert.equal(traceOpfsRejections(scope), 1);
    assert.equal(traceOpfsRejections(scope), 0, 'wrapped once');
    const callerOfTheCall = ()=>new FileSystemDirectoryHandle().getFileHandle('a.bin');
    const e = await callerOfTheCall().catch(error=>error);
    assert.equal(e.name, 'NotFoundError', 'the kind of failure is kept');
    assert.match(e.message, /a\.bin is gone -- FileSystemDirectoryHandle\.getFileHandle\("a\.bin"\) on "cache"/);
    assert.match(e.stack, /callerOfTheCall/, 'and where it was called from');
});
