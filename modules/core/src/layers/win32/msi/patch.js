/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Patches: a .msp is a compound file whose summary names the products it
 * targets (Template), its own code and the patches it replaces (Revision
 * Number), and the transforms it carries (Last Saved By) -- pairs of a
 * transform that changes the product and a "#" transform that adds the
 * patch's own Media and PatchPackage rows. Applying it applies each pair that
 * validates against the package, and the files it delivers -- whole, or as
 * deltas in its Patch table -- come from cabinets stored in the .msp itself,
 * which the package's database is given a view of.
 */

import { openCompound } from './compound.js';
import { nameKey } from '../ole32/cfb.js';
import { readSummary, PID } from './summary.js';
import { openDatabase } from './database.js';
import {
    ERROR_SUCCESS, applyTransformStorage, checkTransform, describeTransform, MSITRANSFORM_ERROR,
} from './transform.js';
import { extractCabinet } from '../cabinet/stream.js';
import {
    ERROR_INSTALL_FAILURE, errorMessage, installing, readFile, schedule, writeFile,
} from './steps.js';

export const ERROR_PATCH_PACKAGE_OPEN_FAILED = 1635;
export const ERROR_PATCH_PACKAGE_INVALID = 1636;
export const ERROR_PATCH_TARGET_NOT_FOUND = 1642;
export const ERROR_PATCH_NO_SEQUENCE = 1648;

/** A summary information stream's name in a storage. */
const SUMMARY_STREAM = '\u0005SummaryInformation';

/** @typedef {import('./database.js').Database} Database */

/**
 * @typedef {Object} Patch
 * @property {string} code          The patch's own GUID.
 * @property {string[]} replaces    The patches it supersedes.
 * @property {string[]} targets     The product codes it applies to.
 * @property {string[]} transforms  Its storages' names, in order, ":" taken off.
 * @property {any} file             Its compound file.
 * @property {Database} db          Its own database, whose streams hold its cabinets.
 */

/** @param {string} text @returns {string[]} the braced GUIDs a string runs together */
const guidsIn = text=>text.match(/\{[0-9A-Fa-f-]{36}\}/g) ?? [];

/**
 * Opens a .msp: its summary read for what it is and what it targets.
 *
 * @param {import('./compound.js').ByteSource} source
 * @returns {Promise<Patch | number>} the patch, or ERROR_PATCH_PACKAGE_INVALID
 */
export async function openPatch(source){
    try
    {
        const file = await openCompound(source);
        const node = file.root.children.get(nameKey(SUMMARY_STREAM));
        const summary = readSummary(node ? await file.readAll(node) : null);
        const text = (/** @type {number} */ id)=>String(summary.get(id)?.value ?? '');
        const [code, ...replaces] = guidsIn(text(PID.REVNUMBER));
        if (!code)
        {
            return ERROR_PATCH_PACKAGE_INVALID;
        }
        return {
            code: code.toUpperCase(), replaces: replaces.map(guid=>guid.toUpperCase()),
            targets: guidsIn(text(PID.TEMPLATE)).map(guid=>guid.toUpperCase()),
            transforms: text(PID.LASTAUTHOR).split(';').map(name=>name.trim())
                .filter(name=>name.startsWith(':')).map(name=>name.slice(1)),
            file, db: await openDatabase(file),
        };
    }
    catch {
        return ERROR_PATCH_PACKAGE_INVALID;
    }
}

/**
 * Applies a patch to a package's database: each transform pair whose
 * product transform validates, the "#" one with it; then the patch's streams
 * are made readable through the database, where the cabinets its Media rows
 * name are looked for.
 *
 * @param {Database} db @param {Patch} patch
 * @param {{ productCode: string, property?: (name: string) => string,
 *     log?: (text: string) => void }} options
 * @returns {Promise<number>}
 */
export async function applyPatch(db, patch, options){
    const log = options.log ?? (()=>{});
    if (!patch.targets.includes(options.productCode.toUpperCase()))
    {
        log(`patch ${patch.code} does not target ${options.productCode}`);
        return ERROR_PATCH_TARGET_NOT_FOUND;
    }
    let applied = 0;
    for (const name of patch.transforms.filter(entry=>!entry.startsWith('#')))
    {
        const storage = patch.file.root.children.get(nameKey(name));
        const companion = patch.file.root.children.get(nameKey(`#${name}`));
        if (storage?.kind !== 'storage')
        {
            continue;
        }
        const node = storage.children.get(nameKey(SUMMARY_STREAM));
        const summary = readSummary(node ? await patch.file.readAll(node) : null);
        if (checkTransform(db, summary, options.property).code !== ERROR_SUCCESS)
        {
            log(`patch ${patch.code}: ${name} does not apply to this package`);
            continue;
        }
        const conditions = describeTransform(summary).errorConditions
            & ~MSITRANSFORM_ERROR.VIEWTRANSFORM;
        for (const part of companion?.kind === 'storage' ? [storage, companion] : [storage])
        {
            const code = await applyTransformStorage(db, patch.file, part,
                part === storage ? conditions : ALL_CONDITIONS, { requireClass: false, log });
            if (code !== ERROR_SUCCESS)
            {
                return code;
            }
        }
        applied++;
    }
    if (applied === 0)
    {
        return ERROR_PATCH_TARGET_NOT_FOUND;
    }
    overlayStreams(db, patch.db);
    return ERROR_SUCCESS;
}

/**
 * Every error condition suppressed: the "#" transform adds rows a package
 * patched before may already hold.
 */
const ALL_CONDITIONS = MSITRANSFORM_ERROR.ADDEXISTINGROW | MSITRANSFORM_ERROR.DELMISSINGROW
    | MSITRANSFORM_ERROR.ADDEXISTINGTABLE | MSITRANSFORM_ERROR.DELMISSINGTABLE
    | MSITRANSFORM_ERROR.UPDATEMISSINGROW | MSITRANSFORM_ERROR.CHANGECODEPAGE;

/**
 * Lets a database read the streams another one holds, where it has none of
 * that name itself: a package's view of the cabinets inside a patch.
 *
 * @param {Database} db @param {Database} extra
 */
export function overlayStreams(db, extra){
    const own = {
        hasStream: db.hasStream, streamSize: db.streamSize, readStream: db.readStream,
        readStreamRange: db.readStreamRange,
    };
    /** @param {string} name */
    const from = name=>(own.hasStream(name) || !extra.hasStream(name) ? own : extra);
    db.hasStream = name=>own.hasStream(name) || extra.hasStream(name);
    db.streamSize = name=>from(name).streamSize(name);
    db.readStream = name=>from(name).readStream(name);
    db.readStreamRange = (name, offset, length)=>from(name).readStreamRange(name, offset,
        length);
}

/**
 * The patches a PATCH property names, and the installed ones not being
 * removed, without duplicates and with superseded ones left out.
 *
 * @param {Patch[]} patches
 */
export function effectivePatches(patches){
    const superseded = new Set(patches.flatMap(patch=>patch.replaces));
    /** @type {Map<string, Patch>} */
    const byCode = new Map();
    for (const patch of patches)
    {
        if (!superseded.has(patch.code) && !byCode.has(patch.code))
        {
            byCode.set(patch.code, patch);
        }
    }
    return [...byCode.values()];
}

/**
 * PatchFiles: each file the Patch table names a delta for, among those its
 * component installs, brought up to date -- the delta read out of the
 * cabinet whose Media row holds its sequence, applied to the file already
 * there, and the result written in its place. Files a patch delivers whole
 * come through InstallFiles, the patch's transform having moved them to its
 * own cabinet.
 *
 * @param {import('./engine.js').Engine} engine
 */
export async function patchFiles(engine){
    const { session, host } = engine;
    const rows = (session.db.table('Patch')?.rows ?? []).filter(row=>{
        const file = session.files.get(String(row[0]));
        return file?.target && installing(engine, file.component);
    });
    if (rows.length === 0)
    {
        return ERROR_SUCCESS;
    }
    return schedule(engine, 'PatchFiles', async()=>{
        const media = [...session.db.table('Media')?.rows ?? []]
            .sort((left, right)=>Number(left[1] ?? 0) - Number(right[1] ?? 0));
        for (const row of rows)
        {
            const file = /** @type {import('./session.js').PackageFile} */ (
                session.files.get(String(row[0])));
            const sequence = Number(row[1] ?? 0);
            const holder = media.find(entry=>Number(entry[1] ?? 0) >= sequence);
            const cabinet = holder?.[3] === null || holder?.[3] === undefined ? ''
                : String(holder[3]);
            const delta = cabinet.startsWith('#')
                ? await entryOf(session.db, cabinet.slice(1), file.key) : null;
            const old = await readFile(host.files, /** @type {string} */ (file.target));
            if (!delta || !old)
            {
                await errorMessage(engine, 1334, [file.key, cabinet]);
                return ERROR_INSTALL_FAILURE;
            }
            const result = await host.applyDelta?.(old, delta) ?? null;
            if (!result)
            {
                host.divergence?.('PatchFiles', 'no delta patch engine to apply the Patch table');
                return ERROR_INSTALL_FAILURE;
            }
            if (result.code !== ERROR_SUCCESS || !result.bytes)
            {
                const target = /** @type {string} */ (file.target);
                await errorMessage(engine, 1328, [target, String(result.code)]);
                return ERROR_INSTALL_FAILURE;
            }
            writeFile(host.files, /** @type {string} */ (file.target), result.bytes);
        }
        return ERROR_SUCCESS;
    });
}

/**
 * One file's bytes out of a cabinet stored in the database.
 *
 * @param {Database} db @param {string} stream @param {string} name
 * @returns {Promise<Uint8Array | null>}
 */
async function entryOf(db, stream, name){
    const size = db.streamSize(stream);
    if (size === null)
    {
        return null;
    }
    /** @type {Uint8Array[]} */
    const parts = [];
    let found = false;
    await extractCabinet({ size, read: async(offset, length)=>
        (await db.readStreamRange(stream, offset, length)) ?? new Uint8Array(0) }, async entry=>{
        if (entry.name !== name || found)
        {
            return null;
        }
        found = true;
        return {
            write: (/** @type {number} */ offset, /** @type {Uint8Array} */ bytes)=>{
                parts.push(bytes.slice());
                void offset;
            },
            close: async()=>{},
        };
    }, { eager: true });
    if (!found)
    {
        return null;
    }
    const total = parts.reduce((sum, part)=>sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts)
    {
        bytes.set(part, at);
        at += part.length;
    }
    return bytes;
}
