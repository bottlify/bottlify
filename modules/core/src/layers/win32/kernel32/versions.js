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
 * What a Windows release ships beside the system itself: its Internet
 * Explorer and its Media Player, and the files of the system folder that
 * carry their versions rather than the system's -- what a setup checks
 * before it installs anything that needs either.
 *
 * @typedef {Object} SystemComponents
 * @property {string} internetExplorer  The browser's version, dotted.
 * @property {string} mediaPlayer       The player's version, dotted.
 * @property {Readonly<Record<string, string>>} files
 *           Each file, by its lower-case name, and the version it carries.
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
 * @property {{ displayVersion: string, releaseId: string, ubr: number } | null} release
 * @property {SystemComponents | null} [components]
 *           The products the release ships beside the system, whose files
 *           carry their own versions; null where none are described.
 *           How Windows 10 names a release and its update beyond the build:
 *           the registry's DisplayVersion, ReleaseId and UBR. Null before 10.
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
        release: null,
    }),
    winxp: Object.freeze({
        name: /** @type {WindowsName} */ ('winxp'),
        major: 5, minor: 1, build: 2600, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 3, servicePackMinor: 0, csdVersion: 'Service Pack 3',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Microsoft Windows XP',
        profiles: DOCUMENTS_AND_SETTINGS,
        release: null,
        // Service Pack 3's own: Internet Explorer 6 SP3 and Media Player 9.
        // Not measured against a machine; see decision A39. DirectX 9.0c is
        // part of the system from XP on, its files at the system's build --
        // newer than any DirectX 9 redistributable's, which a setup's DXSETUP
        // then leaves alone rather than replacing at the next restart.
        components: Object.freeze({
            internetExplorer: '6.0.2900.5512',
            mediaPlayer: '9.0.0.4503',
            files: Object.freeze({
                'shdocvw.dll': '6.0.2900.5512', 'mshtml.dll': '6.0.2900.5512',
                'urlmon.dll': '6.0.2900.5512', 'wininet.dll': '6.0.2900.5512',
                'shlwapi.dll': '6.0.2900.5512', 'msdxm.ocx': '6.4.9.1133',
                'wmp.dll': '9.0.0.4503',
                'ddraw.dll': '5.3.2600.5512', 'dsound.dll': '5.3.2600.5512',
                'dinput.dll': '5.3.2600.5512', 'dinput8.dll': '5.3.2600.5512',
                'd3d8.dll': '5.3.2600.5512', 'd3d9.dll': '5.3.2600.5512',
                'dplayx.dll': '5.3.2600.5512', 'dpnet.dll': '5.3.2600.5512',
                'dpnhpast.dll': '5.3.2600.5512', 'dpnhupnp.dll': '5.3.2600.5512',
                'dmusic.dll': '5.3.2600.5512', 'dmime.dll': '5.3.2600.5512',
            }),
        }),
    }),
    win7: Object.freeze({
        name: /** @type {WindowsName} */ ('win7'),
        major: 6, minor: 1, build: 7601, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 1, servicePackMinor: 0, csdVersion: 'Service Pack 1',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Windows 7 Professional',
        profiles: USERS,
        release: null,
    }),
    win10: Object.freeze({
        name: /** @type {WindowsName} */ ('win10'),
        major: 10, minor: 0, build: 19045, platformId: VER_PLATFORM_WIN32_NT,
        servicePackMajor: 0, servicePackMinor: 0, csdVersion: '',
        suiteMask: VER_SUITE_SINGLEUSERTS, productType: VER_NT_WORKSTATION,
        productName: 'Windows 10 Pro',
        profiles: USERS,
        // Build 19045 is 22H2. Its ReleaseId stayed at 2009, where it froze
        // when the name moved to DisplayVersion; the update revision is one
        // 22H2 was serviced with.
        release: Object.freeze({ displayVersion: '22H2', releaseId: '2009', ubr: 6456 }),
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

/**
 * The Windows a manifest's supportedOS element can name, by the GUID it
 * names it with (the application manifest documentation's list).
 *
 * @type {Readonly<Record<string, readonly [number, number]>>}
 */
const SUPPORTED_OS = Object.freeze({
    'e2011457-1546-43c5-a5fe-008deee3d3f0': [6, 0],
    '35138b9a-5d96-4fbd-8e2d-a2440225f93a': [6, 1],
    '4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38': [6, 2],
    '1f676c76-80e1-4239-95bb-83d0f6d0da78': [6, 3],
    '8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a': [10, 0],
});

/**
 * The GUIDs a manifest's supportedOS elements name, lower case and without
 * braces, in the order they appear. Commented-out elements do not count.
 *
 * @param {string} manifest  The manifest's text.
 * @returns {string[]}
 */
export function supportedOsOf(manifest){
    const text = manifest.replace(/<!--[\s\S]*?-->/g, '');
    const element = /<(?:[\w.-]+:)?supportedOS\b[^>]*?\bId\s*=\s*(["'])\s*\{?([0-9a-fA-F-]+)\}?\s*\1/g;
    return [...text.matchAll(element)].map(match=>match[2].toLowerCase());
}

/**
 * What a program says about the Windows it was written for.
 *
 * @typedef {Object} ProgramCompatibility
 * @property {string[]} [supportedOS]  The GUIDs of its manifest's supportedOS
 *           elements (`supportedOsOf`).
 * @property {{ major: number, minor: number }} [imageVersion]  The operating
 *           system version its PE header names.
 */

/** @param {readonly number[]} a @param {readonly number[]} b */
const compareVersions = (a, b)=>a[0] - b[0] || a[1] - b[1];

/**
 * The version GetVersion, GetVersionEx and VerifyVersionInfo answer a program.
 *
 * Windows 8.1 and later answer a program with the newest Windows it says it
 * knows, and never newer than themselves: the newest its manifest's
 * supportedOS elements name, or when they name none the version its PE header
 * names, rounded down to one that exists -- and 8 (6.2) when that is older
 * still: the rule came with 8.1, and a program that knows nothing of it is
 * told the Windows before it (Wine's kernel32 version tests). RtlGetVersion,
 * the process block and the registry keep the truth. Of the four choices only
 * 10 is that new; the others answer every program the same.
 *
 * @param {WindowsVersion} version  The machine's.
 * @param {ProgramCompatibility} [compatibility]  The running program's.
 * @returns {WindowsVersion}
 */
export function reportedVersion(version, compatibility = {}){
    const truth = [version.major, version.minor];
    if (compareVersions(truth, [6, 3]) < 0)
    {
        return version;
    }
    const declared = (compatibility.supportedOS ?? [])
        .map(id=>SUPPORTED_OS[id.toLowerCase()])
        .filter(known=>known !== undefined)
        .sort(compareVersions);
    const image = compatibility.imageVersion;
    const asked = declared.length > 0
        ? declared[declared.length - 1]
        : [[10, 0], [6, 3]].find(known=>image && compareVersions(
            [image.major, image.minor], known) >= 0) ?? [6, 2];
    if (compareVersions(asked, truth) >= 0)
    {
        return version;
    }
    const [major, minor] = compareVersions(asked, [6, 3]) >= 0 ? [6, 3] : [6, 2];
    return Object.freeze({
        ...version, major, minor, build: minor === 3 ? 9600 : 9200,
        servicePackMajor: 0, servicePackMinor: 0, csdVersion: '',
    });
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
