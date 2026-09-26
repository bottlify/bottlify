/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_WINDOWS, VER, WINDOWS_VERSIONS, setCondition, verifyVersion, windowsVersion,
} from './versions.js';

const VER_EQUAL = 1;
const VER_GREATER = 2;
const VER_GREATER_EQUAL = 3;
const VER_LESS = 4;
const VER_AND = 6;
const VER_OR = 7;
const VERSION_FIELDS = VER.MAJORVERSION | VER.MINORVERSION
    | VER.SERVICEPACKMAJOR | VER.SERVICEPACKMINOR;

/** @param {...[number, number]} pairs  Type bit and condition, in order. */
const conditions = (...pairs)=>pairs.reduce((mask, [type, condition])=>
    setCondition(mask, type, condition), 0n);

test('the four choices answer the versions they shipped with their last service pack', ()=>{
    const summary = Object.fromEntries(Object.values(WINDOWS_VERSIONS).map(version=>
        [version.name, [`${version.major}.${version.minor}.${version.build}`,
            version.servicePackMajor, version.servicePackMinor, version.csdVersion]]));
    assert.deepEqual(summary, {
        win2000: ['5.0.2195', 4, 0, 'Service Pack 4'],
        winxp: ['5.1.2600', 3, 0, 'Service Pack 3'],
        win7: ['6.1.7601', 1, 0, 'Service Pack 1'],
        win10: ['10.0.19045', 0, 0, ''],
    });
    for (const version of Object.values(WINDOWS_VERSIONS))
    {
        assert.equal(version.platformId, 2, `${version.name}: VER_PLATFORM_WIN32_NT`);
        assert.equal(version.productType, 1, `${version.name}: VER_NT_WORKSTATION`);
    }
});

test('Remote Desktop\'s single-session suite bit is set from XP on, and not on 2000', ()=>{
    assert.equal(WINDOWS_VERSIONS.win2000.suiteMask, 0);
    assert.equal(WINDOWS_VERSIONS.winxp.suiteMask, 0x100);
    assert.equal(WINDOWS_VERSIONS.win7.suiteMask, 0x100);
    assert.equal(WINDOWS_VERSIONS.win10.suiteMask, 0x100);
});

test('the profiles move from Documents and Settings to Users with 7', ()=>{
    assert.equal(WINDOWS_VERSIONS.win2000.profiles.user, 'C:\\Documents and Settings\\User');
    assert.equal(WINDOWS_VERSIONS.winxp.profiles.allUsers,
        'C:\\Documents and Settings\\All Users');
    assert.equal(WINDOWS_VERSIONS.winxp.profiles.public, null);
    assert.equal(WINDOWS_VERSIONS.win7.profiles.user, 'C:\\Users\\User');
    assert.equal(WINDOWS_VERSIONS.win10.profiles.allUsers, 'C:\\ProgramData');
    assert.equal(WINDOWS_VERSIONS.win10.profiles.public, 'C:\\Users\\Public');
});

test('absent is XP with its third service pack, and an unknown name is refused', ()=>{
    assert.equal(DEFAULT_WINDOWS, 'winxp');
    assert.equal(windowsVersion(), WINDOWS_VERSIONS.winxp);
    assert.equal(windowsVersion(null), WINDOWS_VERSIONS.winxp);
    assert.equal(windowsVersion('win7'), WINDOWS_VERSIONS.win7);
    assert.throws(()=>windowsVersion('win98'), /win2000, winxp, win7, win10/);
    assert.throws(()=>windowsVersion('toString'), /unknown Windows version/,
        'a name inherited by every object is not a version');
});

test('VerSetConditionMask keeps three bits per type, in the order of the type bits', ()=>{
    assert.equal(setCondition(0n, VER.MINORVERSION, VER_GREATER_EQUAL), 3n);
    assert.equal(setCondition(0n, VER.MAJORVERSION, VER_GREATER_EQUAL), 3n << 3n);
    assert.equal(setCondition(0n, VER.SERVICEPACKMAJOR, VER_EQUAL), 1n << 15n);
    assert.equal(setCondition(0n, VER.PRODUCT_TYPE, VER_EQUAL), 1n << 21n);
    assert.equal(setCondition(5n, 0, VER_EQUAL), 5n, 'no type leaves the mask alone');
    assert.equal(setCondition(5n, VER.MAJORVERSION, 0), 5n, 'nor does no condition');
    assert.equal(setCondition(0n, VER.SUITENAME, 0xfe), 6n << 18n,
        'only the condition\'s low three bits are kept');
});

test('a minimum version is met by anything newer at the first field that differs', ()=>{
    const xp = WINDOWS_VERSIONS.winxp;
    const atLeast = conditions([VER.MAJORVERSION, VER_GREATER_EQUAL],
        [VER.MINORVERSION, VER_GREATER_EQUAL], [VER.SERVICEPACKMAJOR, VER_GREATER_EQUAL]);
    /** @param {number} major @param {number} minor @param {number} pack */
    const request = (major, minor, pack)=>({ ...xp, major, minor, servicePackMajor: pack });

    assert.equal(verifyVersion(xp, request(5, 1, 2), VERSION_FIELDS, atLeast), 'met',
        'XP SP2 or later: an installer\'s own floor');
    assert.equal(verifyVersion(xp, request(5, 1, 3), VERSION_FIELDS, atLeast), 'met');
    assert.equal(verifyVersion(xp, request(5, 0, 9), VERSION_FIELDS, atLeast), 'met',
        'a newer minor version is newer whatever the service pack');
    assert.equal(verifyVersion(xp, request(5, 1, 4), VERSION_FIELDS, atLeast), 'not-met');
    assert.equal(verifyVersion(xp, request(6, 0, 0), VERSION_FIELDS, atLeast), 'not-met');
    assert.equal(verifyVersion(WINDOWS_VERSIONS.win2000, request(5, 1, 2), VERSION_FIELDS,
        atLeast), 'not-met', '2000 SP4 is older than XP SP2');
});

test('the first ordering condition decides the rest of the version, whatever they ask', ()=>{
    // Wine's kernel32 version tests: major >= and minor < against a request
    // one minor version up fails, where minor < alone would have passed.
    const xp = WINDOWS_VERSIONS.winxp;
    const up = { ...xp, minor: xp.minor + 1 };
    assert.equal(verifyVersion(xp, up, VERSION_FIELDS,
        conditions([VER.MAJORVERSION, VER_GREATER_EQUAL], [VER.MINORVERSION, VER_LESS])),
    'not-met');
    assert.equal(verifyVersion(xp, up, VERSION_FIELDS,
        conditions([VER.MAJORVERSION, VER_EQUAL], [VER.MINORVERSION, VER_LESS])),
    'met', 'an EQUAL demands its own field and hands on to the next condition');
    assert.equal(verifyVersion(xp, { ...xp, servicePackMajor: 4 }, VERSION_FIELDS,
        conditions([VER.MAJORVERSION, VER_GREATER_EQUAL], [VER.SERVICEPACKMAJOR, VER_LESS])),
    'not-met', 'major >= carried down to a service pack the request says must be less');
});

test('a version field in the type mask with no condition, or AND and OR, is never met', ()=>{
    const xp = WINDOWS_VERSIONS.winxp;
    const packUp = { ...xp, servicePackMinor: 1 };
    assert.equal(verifyVersion(xp, packUp, VERSION_FIELDS,
        conditions([VER.SERVICEPACKMAJOR, VER_EQUAL], [VER.SERVICEPACKMINOR, VER_LESS])),
    'not-met', 'the major version is named and has no condition');
    assert.equal(verifyVersion(xp, packUp, VER.SERVICEPACKMAJOR | VER.SERVICEPACKMINOR,
        conditions([VER.SERVICEPACKMAJOR, VER_EQUAL], [VER.SERVICEPACKMINOR, VER_LESS])),
    'met', 'the same conditions over only the fields they name');
    assert.equal(verifyVersion(xp, { ...xp, minor: 2 }, VERSION_FIELDS,
        conditions([VER.MAJORVERSION, VER_AND], [VER.MINORVERSION, VER_LESS])), 'not-met');
    assert.equal(verifyVersion(xp, { ...xp, minor: 2 }, VERSION_FIELDS,
        conditions([VER.MAJORVERSION, VER_OR], [VER.MINORVERSION, VER_LESS])), 'not-met');
    assert.equal(verifyVersion(xp, { ...xp, build: 0 },
        VER.MAJORVERSION | VER.MINORVERSION | VER.BUILDNUMBER,
        conditions([VER.MAJORVERSION, VER_GREATER_EQUAL])), 'not-met',
    'the build is named and has no condition');
});

test('the suite is compared as a set, and the rest one field at a time', ()=>{
    const xp = WINDOWS_VERSIONS.winxp;
    /** @param {number} suiteMask */
    const suites = suiteMask=>({ ...xp, suiteMask });
    const and = conditions([VER.SUITENAME, VER_AND]);
    const or = conditions([VER.SUITENAME, VER_OR]);
    assert.equal(verifyVersion(xp, suites(0x100), VER.SUITENAME, and), 'met');
    assert.equal(verifyVersion(xp, suites(0x300), VER.SUITENAME, and), 'not-met',
        'XP Professional is not Home Edition');
    assert.equal(verifyVersion(xp, suites(0x300), VER.SUITENAME, or), 'met');
    assert.equal(verifyVersion(xp, suites(0x200), VER.SUITENAME, or), 'not-met');
    assert.equal(verifyVersion(xp, suites(0), VER.SUITENAME, and), 'met');
    assert.equal(verifyVersion(xp, suites(0), VER.SUITENAME, or), 'met',
        'asking for no suite at all is met either way');

    assert.equal(verifyVersion(xp, { ...xp, productType: 1 }, VER.PRODUCT_TYPE,
        conditions([VER.PRODUCT_TYPE, VER_EQUAL])), 'met');
    assert.equal(verifyVersion(xp, { ...xp, productType: 3 }, VER.PRODUCT_TYPE,
        conditions([VER.PRODUCT_TYPE, VER_EQUAL])), 'not-met', 'not a server');
    assert.equal(verifyVersion(xp, { ...xp, build: 2500 }, VER.BUILDNUMBER,
        conditions([VER.BUILDNUMBER, VER_GREATER])), 'met');
    assert.equal(verifyVersion(xp, { ...xp, platformId: 2 }, VER.PLATFORMID,
        conditions([VER.PLATFORMID, VER_EQUAL])), 'met');
});

test('a request that names nothing to compare is refused as a bad argument', ()=>{
    const xp = WINDOWS_VERSIONS.winxp;
    assert.equal(verifyVersion(xp, xp, 0, conditions([VER.MAJORVERSION, VER_EQUAL])),
        'invalid');
    assert.equal(verifyVersion(xp, xp, VER.MAJORVERSION, 0n), 'invalid');
});
