/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNamedSecurityFunctions } from './named-security.js';
import { createRegistryService } from './registry-service.js';
import { createHive } from './registry.js';
import { createTokenFunctions } from './tokens.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INVALID_ACL = 1336;
const ERROR_INVALID_SID = 1337;

const SE_FILE_OBJECT = 1;
const SE_SERVICE = 2;
const SE_REGISTRY_KEY = 4;
const OWNER = 0x1;
const GROUP = 0x2;
const DACL = 0x4;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const NAME = 0x100;
const OWNER_OUT = 0x400;
const GROUP_OUT = 0x404;
const DACL_OUT = 0x408;
const SD_OUT = 0x410;
const PART = 0x500;

const ADMINISTRATORS = [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x20, 2, 0, 0];
const SYSTEM = [1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];

function setup(){
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    /** @type {Set<string>} */
    const directories = new Set(['c:\\', 'c:\\windows', 'c:\\program files']);
    /** @type {Set<string>} */
    const files = new Set(['c:\\windows\\win.ini']);
    /** @type {[string, string][]} */
    const divergences = [];
    let heap = 0x1000;
    const host = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        /** @param {number} size */
        allocate: size=>{
            const at = heap;
            heap += size + 7 & ~7;
            return at;
        },
        files: {
            /** @param {string} path */
            stat(path){
                const key = path.toLowerCase().replace(/\\$/, '') || 'c:\\';
                const folded = /^[a-z]:$/.test(key) ? `${key}\\` : key;
                if (directories.has(folded))
                {
                    return { exists: true, isDirectory: true, size: 0 };
                }
                return files.has(folded) ? { exists: true, isDirectory: false, size: 1 } : null;
            },
        },
        hive: createRegistryService(createHive()),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>divergences.push([api, detail]),
    };
    const fns = createNamedSecurityFunctions(host);
    /** @param {number} at */
    const dword = at=>view.getUint32(at, true);
    /** @param {string} text */
    const narrow = text=>{
        bytes.set([...text, '\0'].map(unit=>unit.charCodeAt(0)), NAME);
        return NAME;
    };
    /** @param {string} text */
    const wide = text=>{
        [...text, '\0'].forEach((unit, index)=>view.setUint16(NAME + index * 2,
            unit.charCodeAt(0), true));
        return NAME;
    };
    const clearOuts = ()=>bytes.fill(0xcc, OWNER_OUT, SD_OUT + 4);
    return { bytes, view, host, fns, dword, narrow, wide, clearOuts, divergences };
}

test('a directory that had none set has the NTFS DACL: full control, inheritable', ()=>{
    const { bytes, fns, dword, narrow, clearOuts } = setup();
    assert.equal(fns.GetNamedSecurityInfoA.argBytes, 32);
    assert.equal(fns.GetNamedSecurityInfoW.argBytes, 32);

    clearOuts();
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\WINDOWS'), SE_FILE_OBJECT,
        OWNER | GROUP | DACL, OWNER_OUT, GROUP_OUT, DACL_OUT, 0, SD_OUT]), 0);
    const sd = dword(SD_OUT);
    assert.ok(sd >= 0x1000, 'in a block of its own, for LocalFree');
    assert.equal(bytes[sd], 1, 'SECURITY_DESCRIPTOR_REVISION');
    assert.equal(bytes[sd + 2] | bytes[sd + 3] << 8, SE_SELF_RELATIVE | SE_DACL_PRESENT);
    assert.deepEqual([...bytes.subarray(sd + dword(sd + 4), sd + dword(sd + 4) + 16)],
        ADMINISTRATORS, 'owned by the administrators');
    assert.deepEqual([...bytes.subarray(sd + dword(sd + 8), sd + dword(sd + 8) + 12)],
        SYSTEM, 'its group the system');
    const acl = dword(DACL_OUT);
    assert.equal(acl, sd + dword(sd + 16), 'the DACL pointer points into it');
    assert.equal(view0(bytes, acl + 4), 3, 'three ACEs: administrators, system, creator owner');
    // The first ACE: allowed, inheritable, full control to the administrators.
    assert.equal(bytes[acl + 8], 0, 'an allowed ACE');
    assert.equal(bytes[acl + 9], 0x3, 'OBJECT_INHERIT | CONTAINER_INHERIT on a directory');
    assert.equal(view0(bytes, acl + 8 + 4), 0x1f01ff, 'FILE_ALL_ACCESS');

    clearOuts();
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\WINDOWS\\win.ini'),
        SE_FILE_OBJECT, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), 0, 'a file: its ACEs are inherited');
    const fileAcl = dword(DACL_OUT);
    assert.equal(bytes[fileAcl + 8 + 1], 0x10, 'INHERITED_ACE');
});

/** @param {Uint8Array} bytes @param {number} at */
function view0(bytes, at){
    return (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
}

test('what a read needs to be given, and a name that is not there', ()=>{
    // advapi32's security tests (test_GetNamedSecurityInfoA): no descriptor
    // pointer and no part pointers is ERROR_INVALID_PARAMETER, and so is a
    // part asked for with nowhere to put it.
    const { fns, dword, narrow, clearOuts } = setup();
    const name = narrow('C:\\WINDOWS');
    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, 0, 0, 0]), ERROR_INVALID_PARAMETER);
    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, OWNER,
        0, 0, DACL_OUT, 0, 0]), ERROR_INVALID_PARAMETER);
    clearOuts();
    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, DACL_OUT, 0, SD_OUT]), 0);
    assert.notEqual(dword(DACL_OUT), 0, 'the DACL the volume gives a directory');
    clearOuts();
    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, DACL_OUT, 0, 0]), 0, 'the part alone, when it has a pointer');
    assert.equal(dword(SD_OUT), 0xcccccccc, 'and no descriptor pointer is written');

    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\WINDOWS\\nothing.ini'),
        SE_FILE_OBJECT, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), ERROR_FILE_NOT_FOUND);
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\Nowhere\\nothing.ini'),
        SE_FILE_OBJECT, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), ERROR_PATH_NOT_FOUND);
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('\\an invalid file path'),
        SE_FILE_OBJECT, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), ERROR_FILE_NOT_FOUND,
    'a name in the root of the drive');
    assert.equal(fns.GetNamedSecurityInfoA.handler([0, SE_FILE_OBJECT, DACL,
        0, 0, DACL_OUT, 0, SD_OUT]), ERROR_INVALID_PARAMETER, 'no name');
});

test('a registry key is owned by the administrators and lets the users read', ()=>{
    // advapi32's security tests: MACHINE\Software's owner is Administrators
    // or the system, its group the system before Windows 7, its DACL valid
    // and naming both Users and Administrators.
    const { bytes, fns, dword, narrow, wide } = setup();
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('MACHINE\\Software'),
        SE_REGISTRY_KEY, OWNER | GROUP | DACL, OWNER_OUT, GROUP_OUT, DACL_OUT, 0, SD_OUT]), 0);
    assert.deepEqual([...bytes.subarray(dword(OWNER_OUT), dword(OWNER_OUT) + 16)],
        ADMINISTRATORS);
    assert.deepEqual([...bytes.subarray(dword(GROUP_OUT), dword(GROUP_OUT) + 12)], SYSTEM);
    const acl = dword(DACL_OUT);
    assert.notEqual(acl, 0);
    assert.equal(bytes[acl], 2, 'ACL_REVISION');
    assert.equal(bytes[acl + 4], 3, 'three ACEs');
    const users = acl + 8;
    assert.deepEqual([bytes[users], bytes[users + 1], dword(users + 4)], [0, 2, 0x20019],
        'the users may read, and so may every subkey\'s');
    assert.deepEqual([...bytes.subarray(users + 8, users + 24)],
        [1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x21, 2, 0, 0]);
    const admins = users + 24;
    assert.deepEqual([...bytes.subarray(admins + 8, admins + 24)], ADMINISTRATORS);
    assert.equal(dword(admins + 4), 0xf003f, 'KEY_ALL_ACCESS');

    assert.equal(fns.GetNamedSecurityInfoW.handler([wide('classes_root\\CLSID'),
        SE_REGISTRY_KEY, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), 0, 'any root, any case, wide');
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('MACHINE\\Software\\No Such Key'),
        SE_REGISTRY_KEY, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), ERROR_FILE_NOT_FOUND);
    assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('HKEY_LOCAL_MACHINE\\Software'),
        SE_REGISTRY_KEY, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), ERROR_INVALID_PARAMETER,
    'not a root these calls spell');
});

test('an object kind with no security by name here says so, and an unknown kind is refused',
    ()=>{
        const { fns, narrow, divergences } = setup();
        assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('Spooler'), SE_SERVICE, DACL,
            0, 0, DACL_OUT, 0, SD_OUT]), ERROR_CALL_NOT_IMPLEMENTED);
        assert.equal(divergences.length, 1);
        assert.equal(divergences[0][0], 'GetNamedSecurityInfo');
        assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\WINDOWS'), 0, DACL,
            0, 0, DACL_OUT, 0, SD_OUT]), ERROR_INVALID_PARAMETER, 'SE_UNKNOWN_OBJECT_TYPE');
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('C:\\WINDOWS'), 99, DACL,
            0, 0, 0, 0]), ERROR_INVALID_PARAMETER);
    });

test('setting a file\'s security keeps it for the run; a key\'s is accepted and kept nowhere',
    ()=>{
        // advapi32's security tests: SetNamedSecurityInfo of a path that is
        // not there is ERROR_FILE_NOT_FOUND, with the last error untouched --
        // this table has no way to touch it.
        const { bytes, fns, dword, narrow, wide } = setup();
        assert.equal(fns.SetNamedSecurityInfoA.argBytes, 28);
        assert.equal(fns.SetNamedSecurityInfoW.argBytes, 28);
        const ACL_AT = PART;
        bytes.set([2, 0, 8, 0, 0, 0, 0, 0], ACL_AT);

        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('/an invalid file path'),
            SE_FILE_OBJECT, DACL, 0, 0, 0, 0]), ERROR_FILE_NOT_FOUND);
        assert.equal(fns.SetNamedSecurityInfoW.handler([wide('C:\\Program Files'),
            SE_FILE_OBJECT, DACL, 0, 0, ACL_AT, 0]), 0, 'an empty DACL');
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('C:\\Program Files'),
            SE_FILE_OBJECT, DACL, 0, 0, 0, 0]), 0, 'a null DACL');
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('MACHINE\\Software'),
            SE_REGISTRY_KEY, DACL, 0, 0, ACL_AT, 0]), 0, 'a key');

        assert.equal(fns.GetNamedSecurityInfoA.handler([narrow('C:\\Program Files'),
            SE_FILE_OBJECT, DACL, 0, 0, DACL_OUT, 0, SD_OUT]), 0);
        assert.equal(dword(DACL_OUT), 0, 'the null DACL that was set last, read back');

        bytes[ACL_AT] = 7;
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('C:\\Program Files'),
            SE_FILE_OBJECT, DACL, 0, 0, ACL_AT, 0]), ERROR_INVALID_ACL);
        bytes.set([5, 1], PART + 0x40);
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('C:\\Program Files'),
            SE_FILE_OBJECT, OWNER, PART + 0x40, 0, 0, 0]), ERROR_INVALID_SID);
        assert.equal(fns.SetNamedSecurityInfoA.handler([narrow('C:\\Program Files'),
            SE_FILE_OBJECT, DACL, PART + 0x40, 0, 0, 0]), 0, 'a part not given is not read');
    });

test('the permissions step of an installer: read the DACL, merge an entry, set it back', ()=>{
    const { bytes, view, host, fns, dword, narrow } = setup();
    const tokens = createTokenFunctions({
        ...host,
        setLastError: ()=>{},
        handles: { open: ()=>0, resolve: ()=>null },
    });
    const ENTRY = 0x600;
    const SID_AT = 0x680;
    const NEW = 0x6f0;
    const name = narrow('C:\\Program Files');

    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, DACL_OUT, 0, SD_OUT]), 0);
    // BUILTIN\Users, every file right, inherited by what is made below.
    bytes.set([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 0x21, 2, 0, 0], SID_AT);
    [0x1f01ff, 1, 3, 0, 0, 0, 5, SID_AT].forEach((value, at)=>
        view.setUint32(ENTRY + at * 4, value, true));
    assert.equal(tokens.SetEntriesInAclA.handler([1, ENTRY, dword(DACL_OUT), NEW]), 0);
    const merged = dword(NEW);
    assert.equal(bytes[merged + 4], 4, 'the new ACE merged into the volume\'s three');
    assert.equal(fns.SetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, merged, 0]), 0);
    // Set back and kept: the next read answers the four ACEs, not the default three.
    assert.equal(fns.GetNamedSecurityInfoA.handler([name, SE_FILE_OBJECT, DACL,
        0, 0, DACL_OUT, 0, SD_OUT]), 0);
    assert.equal(bytes[dword(DACL_OUT) + 4], 4, 'the DACL set on it, kept for the run');
});
