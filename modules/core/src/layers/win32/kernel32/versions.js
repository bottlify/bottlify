/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Windows this machine says it is.
 *
 * A program reads the version in more places than one -- GetVersion's packed
 * word, GetVersionEx's structure, VerifyVersionInfo's comparison, the process
 * block, RtlGetVersion, the registry, the file version of a system library --
 * and an installer that asks two of them and gets two answers takes the
 * machine for a broken one. So every one of them reads the record chosen
 * here, and the choice is the bottle's: a title that insists on an older
 * Windows and one that insists on a newer one cannot both be satisfied by a
 * single answer.
 *
 * All four are 32-bit systems. Nothing here has a WOW64 layer beneath it, so
 * IsWow64Process is FALSE and there is no `Program Files (x86)` whichever is
 * chosen.
 */

export const VER_PLATFORM_WIN32_NT = 2;
export const VER_NT_WORKSTATION = 1;

/**
 * Remote Desktop with one interactive session, which OSVERSIONINFOEX
 * documents as set on every system not in application server mode -- from XP
 * on, where Remote Desktop first shipped on a workstation. Windows 2000
 * Professional has no Remote Desktop and no suite bit.
 */
const VER_SUITE_SINGLEUSERTS = 0x100;

/**
 * @typedef {'win2000' | 'winxp' | 'win7' | 'win10'} WindowsName
 */

/**
 * Where the per-user and the shared folders live. Windows Vista moved both:
 * `Documents and Settings` became `Users`, and the folders every user shares
 * went to `ProgramData` and `Users\Public`.
 *
 * @typedef {Object} ProfileRoots
 * @property {string} user      The one account's profile.
 * @property {string} allUsers  What ALLUSERSPROFILE names.
 * @property {string | null} public  The shared documents and desktop; null
 *           on a system that keeps them under `allUsers`.
 */

/**
 * @typedef {Object} WindowsVersion
 * @property {WindowsName} name
 * @property {number} major
 * @property {number} minor
 * @property {number} build
 * @property {number} platformId
 * @property {number} servicePackMajor
 * @property {number} servicePackMinor
 * @property {string} csdVersion    The service pack as text; empty when there is none.
 * @property {number} suiteMask
 * @property {number} productType
 * @property {string} productName   The registry's ProductName.
 * @property {ProfileRoots} profiles
 */

/** @type {ProfileRoots} */
const DOCUMENTS_AND_SETTINGS = Object.freeze({
    user: 'C:\\Documents and Settings\\User',
    allUsers: 'C:\\Documents and Settings\\All Users',
    public: null,
});

/** @type {ProfileRoots} */
const USERS = Object.freeze({
    user: 'C:\\Users\\User',
    allUsers: 'C:\\ProgramData',
    public: 'C:\\Users\\Public',
});

/**
 * The four choices, each the last service pack its release had: a program
 * that asks for a minimum service pack asks for one that shipped.
 *
 * @type {Readonly<Record<WindowsName, WindowsVersion>>}
 */
export const WINDOWS_VERSIONS = Object.freeze({
    win2000: Object.freeze({
        name: /** @type {WindowsName} */ ('win2000'),
        major: 5, minor: 0, build: 2195, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 4, servicePackMinor: 0, csdVersion: 'Service Pack 4',
        suiteMask: 0, productType: VER_NT_WORKSTATION,
        productName: 'Microsoft Windows 2000',
        profiles: DOCUMENTS_AND_SETTINGS,
    }),
    winxp: Object.freeze({
        name: /** @type {WindowsName} */ ('winxp'),
        major: 5, minor: 1, build: 2600, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 3, servicePackMinor: 0, csdVersion: 'Service Pack 3',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Microsoft Windows XP',
        profiles: DOCUMENTS_AND_SETTINGS,
    }),
    win7: Object.freeze({
        name: /** @type {WindowsName} */ ('win7'),
        major: 6, minor: 1, build: 7601, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 1, servicePackMinor: 0, csdVersion: 'Service Pack 1',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Windows 7 Professional',
        profiles: USERS,
    }),
    win10: Object.freeze({
        name: /** @type {WindowsName} */ ('win10'),
        major: 10, minor: 0, build: 19045, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 0, servicePackMinor: 0, csdVersion: '',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Windows 10 Pro',
        profiles: USERS,
    }),
});

/**
 * XP with its third service pack: new enough for the DirectX redistributable a
 * title of the era carries, whose setup refuses anything below XP SP2, and old
 * enough that a program written for 2000 or 98 still recognises it.
 *
 * @type {WindowsName}
 */
export const DEFAULT_WINDOWS = 'winxp';

/**
 * The record for a name; absent is the default. A name that is not one of the
 * four is refused rather than quietly read as the default, since a bottle that
 * asked for a Windows it did not get would fail somewhere that says nothing
 * about why.
 *
 * @param {string | null} [name]
 * @returns {WindowsVersion}
 */
export function windowsVersion(name){
    const wanted = name ?? DEFAULT_WINDOWS;
    if (!Object.hasOwn(WINDOWS_VERSIONS, wanted))
    {
        throw new Error(`unknown Windows version ${JSON.stringify(name)}: `
            + `the choices are ${Object.keys(WINDOWS_VERSIONS).join(', ')}`);
    }
    return WINDOWS_VERSIONS[/** @type {WindowsName} */ (wanted)];
}

/** VerifyVersionInfo's type bits, which are also VerSetConditionMask's. */
export const VER = Object.freeze({
    MINORVERSION: 0x01,
    MAJORVERSION: 0x02,
    BUILDNUMBER: 0x04,
    PLATFORMID: 0x08,
    SERVICEPACKMINOR: 0x10,
    SERVICEPACKMAJOR: 0x20,
    SUITENAME: 0x40,
    PRODUCT_TYPE: 0x80,
});

/** The conditions a caller may set; AND and OR are for the suite alone. */
const VER_EQUAL = 1;
const VER_GREATER = 2;
const VER_GREATER_EQUAL = 3;
const VER_LESS = 4;
const VER_LESS_EQUAL = 5;
const VER_AND = 6;
const VER_OR = 7;

/** Three bits of condition per type bit, in the order of the type bits. */
const CONDITION_BITS = 3n;
const CONDITION_MASK = 7n;

/**
 * VerSetConditionMask: the condition stored against each type named.
 *
 * A type or a condition of zero leaves the mask as it was, so a caller that
 * builds the mask a field at a time can pass a field it has no condition for.
 *
 * @param {bigint} mask @param {number} typeMask @param {number} condition
 * @returns {bigint}
 */
export function setCondition(mask, typeMask, condition){
    const wanted = BigInt(condition) & CONDITION_MASK;
    let result = BigInt.asUintN(64, mask);
    if (wanted === 0n)
    {
        return result;
    }
    for (let bit = 0; bit < 8; bit++)
    {
        if ((typeMask >>> 0 & 1 << bit) !== 0)
        {
            result |= wanted << BigInt(bit) * CONDITION_BITS;
        }
    }
    return result;
}

/** @param {bigint} mask @param {number} type  One type bit. */
const conditionOf = (mask, type)=>
    Number(mask >> BigInt(Math.log2(type)) * CONDITION_BITS & CONDITION_MASK);

/**
 * Whether a comparison's outcome satisfies a condition, from the sign of
 * current minus requested. AND, OR and an unset condition are satisfied by
 * nothing: they say nothing about an ordering.
 *
 * @param {number} sign @param {number} condition
 */
const satisfies = (sign, condition)=>{
    switch (condition)
    {
        case VER_EQUAL: return sign === 0;
        case VER_GREATER: return sign > 0;
        case VER_GREATER_EQUAL: return sign >= 0;
        case VER_LESS: return sign < 0;
        case VER_LESS_EQUAL: return sign <= 0;
        default: return false;
    }
};

/**
 * The fields VerifyVersionInfo compares.
 *
 * @typedef {Object} ComparedVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} build
 * @property {number} platformId
 * @property {number} servicePackMajor
 * @property {number} servicePackMinor
 * @property {number} suiteMask
 * @property {number} productType
 */

/**
 * The major version, the minor version and the two service pack numbers, in
 * the order VerifyVersionInfo reads them as one version.
 *
 * @type {readonly [number, 'major' | 'minor' | 'servicePackMajor' | 'servicePackMinor'][]}
 */
const HIERARCHY = Object.freeze([
    [VER.MAJORVERSION, 'major'],
    [VER.MINORVERSION, 'minor'],
    [VER.SERVICEPACKMAJOR, 'servicePackMajor'],
    [VER.SERVICEPACKMINOR, 'servicePackMinor'],
]);

/**
 * VerifyVersionInfo's comparison of the running system against a request.
 *
 * Every field the type mask names is tested with its own condition, except
 * the four that make up the version, which are tested as one number
 * (VerifyVersionInfo's remarks). Walking them in order, an EQUAL condition
 * demands that field and moves on; the first ordering condition decides the
 * rest of them together, lexicographically, whatever conditions those carry --
 * so "major at least 5, minor at least 1" is met by 6.0. A field in the mask
 * with no condition, or with AND or OR, is never met: Wine's kernel32 version
 * tests expect a request naming all four with conditions on only two of them
 * to fail on exactly that.
 *
 * @param {ComparedVersion} current @param {ComparedVersion} requested
 * @param {number} typeMask @param {bigint} conditionMask
 * @returns {'met' | 'not-met' | 'invalid'}
 */
export function verifyVersion(current, requested, typeMask, conditionMask){
    const types = typeMask >>> 0;
    const mask = BigInt.asUintN(64, conditionMask);
    // A request that names nothing to compare is refused as a bad argument
    // rather than answered.
    if (types === 0 || mask === 0n)
    {
        return 'invalid';
    }

    /** @param {number} left @param {number} right */
    const sign = (left, right)=>Math.sign((left >>> 0) - (right >>> 0));

    /** @param {number} type @param {'build' | 'platformId' | 'productType'} field */
    const single = (type, field)=>(types & type) === 0
        || satisfies(sign(current[field], requested[field]), conditionOf(mask, type));

    const suite = ()=>{
        if ((types & VER.SUITENAME) === 0)
        {
            return true;
        }
        const asked = requested.suiteMask & 0xffff;
        const present = current.suiteMask & asked;
        switch (conditionOf(mask, VER.SUITENAME))
        {
            case VER_AND: return present === asked;
            case VER_OR: return asked === 0 || present !== 0;
            default: return false;
        }
    };

    const version = ()=>{
        const named = HIERARCHY.filter(([type])=>(types & type) !== 0);
        for (let at = 0; at < named.length; at++)
        {
            const [type, field] = named[at];
            const condition = conditionOf(mask, type);
            if (condition === VER_EQUAL)
            {
                if (current[field] !== requested[field])
                {
                    return false;
                }
                continue;
            }
            const order = named.slice(at)
                .map(([, rest])=>sign(current[rest], requested[rest]))
                .find(difference=>difference !== 0) ?? 0;
            return satisfies(order, condition);
        }
        return true;
    };

    return single(VER.BUILDNUMBER, 'build') && single(VER.PLATFORMID, 'platformId')
        && single(VER.PRODUCT_TYPE, 'productType') && suite() && version()
        ? 'met'
        : 'not-met';
}
