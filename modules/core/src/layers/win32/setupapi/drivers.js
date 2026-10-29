/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Driver lists: the drivers an INF offers a device, from its
 * [Manufacturer] section's models.
 *
 * A [Manufacturer] line names a models section and the platforms it is
 * decorated for; this machine takes the decoration for its platform,
 * `NTx86` (with or without an OS version after it), else `NT`, and passes
 * a manufacturer that has neither when it has any. A models line is a
 * driver: its description, its install section, its hardware ID and its
 * compatible IDs. A compatible driver list keeps the drivers one of whose
 * IDs is one of the device's, ranked as Windows ranks them -- a device
 * hardware ID on the driver's hardware ID best, then on one of its
 * compatible IDs, then a device compatible ID on either, each by the
 * device ID's position -- and a class driver list every driver of the
 * class.
 */

/** This machine's platform, as an INF decorates a section for it. */
const PLATFORM = 'ntx86';

/**
 * @typedef {Object} Driver
 * @property {string} description @property {string} manufacturer
 * @property {string} provider
 * @property {string} section      The install section, '' for none.
 * @property {string} hardwareId   The driver's own, '' for none.
 * @property {string[]} compatibleIds
 * @property {number} rank         Lower is better; 0xffff for a class driver.
 * @property {string} infPath
 * @property {bigint} date         The INF's DriverVer date as a FILETIME, 0n for none.
 * @property {bigint} version      Its four version words, 0n for none.
 */

/**
 * The models section a [Manufacturer] line means on this machine, or null
 * when it is decorated for other platforms only.
 *
 * @param {string} section @param {string[]} decorations
 */
function modelsSection(section, decorations){
    const named = decorations.map(decoration=>decoration.trim()).filter(Boolean);
    if (named.length === 0)
    {
        return section;
    }
    const platform = named.find(decoration=>decoration.toLowerCase() === PLATFORM
        || decoration.toLowerCase().startsWith(`${PLATFORM}.`))
        ?? named.find(decoration=>/^nt(\.|$)/i.test(decoration));
    return platform ? `${section}.${platform}` : null;
}

/**
 * [Version] DriverVer -- `mm/dd/yyyy[,w.x.y.z]` -- as a FILETIME and a
 * version; zero for what it does not give.
 *
 * @param {string | null} text @param {(ms: number) => bigint} fileTime
 */
function driverVersion(text, fileTime){
    if (!text)
    {
        return { date: 0n, version: 0n };
    }
    const [day = '', version = ''] = text.split(',').map(part=>part.trim());
    const [month, date, year] = day.split('/').map(Number);
    const ms = Date.UTC(year, month - 1, date);
    const words = version.split('.').map(word=>BigInt(Number(word) & 0xffff || 0));
    while (words.length < 4)
    {
        words.push(0n);
    }
    return {
        date: Number.isFinite(ms) ? fileTime(ms) : 0n,
        version: version === '' ? 0n
            : words.slice(0, 4).reduce((sum, word)=>(sum << 16n) | word, 0n),
    };
}

/**
 * Where a driver ranks for a device, null when none of its IDs is the
 * device's.
 *
 * @param {string} hardwareId @param {string[]} compatibleIds
 * @param {string[]} deviceHardware @param {string[]} deviceCompatible
 */
function rankOf(hardwareId, compatibleIds, deviceHardware, deviceCompatible){
    const lower = (/** @type {string[]} */ ids)=>ids.map(id=>id.toLowerCase());
    const hardware = lower(deviceHardware);
    const compatible = lower(deviceCompatible);
    const own = hardwareId.toLowerCase();
    const others = lower(compatibleIds);
    for (const [tier, ids, wanted] of /** @type {[number, string[], string[]][]} */ ([
        [0, hardware, [own]], [1, hardware, others], [2, compatible, [own]],
        [3, compatible, others]]))
    {
        const at = ids.findIndex(id=>id !== '' && wanted.includes(id));
        if (at >= 0)
        {
            return tier * 0x1000 + at;
        }
    }
    return null;
}

/**
 * The drivers an INF offers: for a compatible list, those matching the
 * device's IDs; for a class list, every one.
 *
 * @param {import('./inf.js').Inf} inf @param {string} infPath
 * @param {{ hardware: string[], compatible: string[] } | null} device  null for a class list.
 * @param {(value: string) => string} expand  Strings and DIRIDs substituted.
 * @param {(ms: number) => bigint} fileTime
 * @returns {Driver[]}
 */
export function driversOf(inf, infPath, device, expand, fileTime){
    const provider = expand(inf.value('Version', 'Provider') ?? '');
    const { date, version } = driverVersion(inf.value('Version', 'DriverVer'), fileTime);
    /** @type {Driver[]} */
    const found = [];
    for (const line of inf.section('Manufacturer')?.lines ?? [])
    {
        const manufacturer = expand(line.key ?? line.fields[0] ?? '');
        const [section = '', ...decorations] = line.key === null ? line.fields.slice(1)
            : line.fields;
        const models = modelsSection(expand(section), decorations);
        for (const model of (models === null ? null : inf.section(models))?.lines ?? [])
        {
            const [install = '', hardwareId = '', ...compatibleIds] = model.fields.map(expand);
            const rank = device === null ? 0xffff
                : rankOf(hardwareId, compatibleIds, device.hardware, device.compatible);
            if (rank === null)
            {
                continue;
            }
            found.push({ description: expand(model.key ?? ''), manufacturer, provider,
                section: install, hardwareId, compatibleIds: compatibleIds.filter(Boolean),
                rank, infPath, date, version });
        }
    }
    return found;
}

/**
 * The best of a compatible list: the lowest rank, the newest date, then
 * the highest version, the first of equals.
 *
 * @param {Driver[]} drivers
 */
export function bestDriver(drivers){
    let best = -1;
    drivers.forEach((driver, index)=>{
        const other = drivers[best];
        if (!other || driver.rank < other.rank || (driver.rank === other.rank
            && (driver.date > other.date
                || (driver.date === other.date && driver.version > other.version))))
        {
            best = index;
        }
    });
    return best;
}
