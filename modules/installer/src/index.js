/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Adding a title by running its installer.
 *
 * Three steps, and only the middle one is anybody else's business. This module
 * says what a prefix is made of and what to do with what it leaves behind; the
 * running of the program in between belongs to whoever owns the screen it draws
 * on, because a canvas, a device and a run loop are a launcher's concerns and
 * not an installer's.
 *
 *     const options = prefixOptions(media, { windows }); // build the app with these
 *     const silent = silentOptions(media, { silent });   // with no screen: skip the wizard
 *     await app.run(...);                                // the person clicks through
 *     const prefix = collectFrom(app, media);            // this is what it produced
 *     await publish({ prefix, manifest: { windows } });  // and this is the bottle
 *
 * A disc image takes `discOptions` in place of the first two: the image is
 * mounted as a CD-ROM drive of its own and the program it names runs from
 * there (`disc.js`), so nothing of it is seeded and nothing is subtracted.
 *
 * `silentOptions` is the engine's own unattended mode, asked for only by a run
 * with no screen (`{ silent: true }`, with createApp's `unattended` beside it),
 * when its family is recognised: a command line and the files it reads its
 * answers from, with the destination already decided. Null means the wizard
 * has to be run, which is the default with a screen.
 *
 * What is reachable today is the publisher's own single-process installer.
 * A distribution that extracts a payload and starts a second program cannot
 * run at all: `CreateProcess` refuses, deliberately, and until it does not this
 * path stops there rather than pretending.
 */

import { REGISTRY_PATH, collect, prefixOptions } from './prefix.js';
import { isDiscMedia } from './disc.js';
import { packBundle } from './pack.js';
import { bundleManifest, finish, partSink } from './upload.js';
import { HEADER_SIZE } from '@bottlify/core/bundle';
import { graphicsChoice, windowsChoice } from './windows.js';

export {
    DRIVE_ROOT, MEDIA_DIRECTORY, REGISTRY_PATH, collect, guessEntry, placementOf,
    prefixOptions,
} from './prefix.js';
export { archiveDisc, isZipArchive, readZip } from './archive.js';
export { isRarArchive, readRar } from './rar.js';
export { DEFAULT_BLOCK_SIZE, packBundle, packBlock, sha256 } from './pack.js';
export { chunkedFile, sizeOf } from './chunks.js';
export {
    DISC_LETTER, autorunText, discEntry, discOptions, isDiscImage, isDiscMedia, readAutorun,
    splitCommand,
} from './disc.js';
export {
    DESTINATION, detectFamily, dialogCalled, responseFile, responseFileV5, silentOptions,
} from './silent.js';
export { PART_BYTES, bundleManifest, finish, partSink } from './upload.js';
export {
    GRAPHICS_CHOICES, WINDOWS_CHOICES, graphicsChoice, windowsChoice,
} from './windows.js';

/**
 * The part of a running engine this module reads. Narrow on purpose: an install
 * is over by the time any of it is called.
 *
 * @typedef {Object} InstalledApp
 * @property {{ export: () => { path: string, bytes: Uint8Array }[],
 *             directories?: () => string[] }} session  `directories`: the empty ones
 *           it made, which a list of files cannot carry.
 * @property {() => { toJSON: () => unknown }} registry
 */

/**
 * @typedef {Object} PublishReport
 * @property {'collecting' | 'packing' | 'finishing' | 'done'} stage
 * @property {string} [detail]
 * @property {number} [bytes]
 */

/**
 * How much room the origin has left, or null where nothing will say.
 *
 * Asked before an install rather than during one: a prefix that will not fit
 * should be refused while it is still a question, not at ninety per cent.
 *
 * @returns {Promise<{ quota: number, usage: number, available: number } | null>}
 */
export async function storageHeadroom(){
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate)
    {
        return null;
    }
    const quota = estimate.quota ?? 0;
    const usage = estimate.usage ?? 0;
    return { quota, usage, available: Math.max(0, quota - usage) };
}

/**
 * What an install left behind, taken off a machine that has finished running it.
 *
 * Separate from publishing it because the two are a person apart: this is what
 * a screen shows before anybody decides to send anything, and reading it twice
 * would mean copying the whole tree out of the volume twice.
 *
 * @param {InstalledApp} app
 * @param {import('./prefix.js').InstallMedia | import('./disc.js').DiscMedia} media
 * @returns {import('./prefix.js').Prefix}
 */
export function collectFrom(app, media){
    return collect({
        files: app.session.export(),
        directories: app.session.directories?.() ?? [],
        registry: app.registry().toJSON(),
        // A disc is a drive of its own and was never in the prefix.
        seeded: isDiscMedia(media) ? [] : prefixOptions(media).seeded,
    });
}

/**
 * Turns a finished prefix into a bottle on a server.
 *
 * Packed on the way out: the blocks are compressed here and posted a part at a
 * time, so neither the installed tree nor a second copy of it is ever written
 * to this machine.
 *
 * @param {Object} options
 * @param {import('./prefix.js').Prefix} options.prefix
 * @param {import('./upload.js').Endpoint} options.endpoint
 * @param {string} options.id                Names the bottle, and its directory.
 * @param {Record<string, unknown>} [options.manifest]  Title, description, cover,
 *        the Windows the bottle runs under, `windows`, and the graphics it
 *        prefers, `graphics` (`windows.js`); absent is the engine's default, and a
 *        name the engine does not know is refused.
 * @param {(report: PublishReport) => void} [options.report]
 * @returns {Promise<{ packed: import('./pack.js').PackedSummary,
 *                      answer: import('./upload.js').BottleAnswer }>}
 */
export async function publish({ prefix, endpoint, id, manifest = {}, report }){
    windowsChoice(manifest.windows);
    graphicsChoice(manifest.graphics);
    // The registry is always there, so it is not evidence that anything ran.
    if (!prefix.files.some(file=>file.path !== REGISTRY_PATH))
    {
        throw new Error('the installer produced no files, so there is no bottle to make');
    }

    const sink = partSink(endpoint, id, sent=>
        report?.({ stage: 'packing', bytes: sent }));

    report?.({ stage: 'packing', detail: `${prefix.files.length} files under ${prefix.root}` });
    const packed = await packBundle({
        files: prefix.files,
        directories: prefix.directories ?? [],
        write: sink.write,
        onProgress: progress=>report?.({
            stage: 'packing',
            detail: progress.path,
            bytes: progress.packedTotal,
        }),
    });
    await sink.flush();

    report?.({ stage: 'finishing' });
    const answer = await finish(endpoint, id, packed, {
        title: id,
        entry: prefix.entry,
        // Where the installation put it, which is where it is mounted again
        // (`placementOf`): the registry it left names that place.
        root: prefix.root,
        ...manifest,
    });

    report?.({ stage: 'done', bytes: packed.bytes });
    return { packed, answer };
}

/**
 * Turns a finished prefix into a bottle kept in this browser: a directory of
 * the origin's file system (`directory`, OPFS) that holds the bottle as a
 * server would -- `<id>/bundle.btl`, its `manifest.json` -- and the
 * program it starts, `<id>/entry`, which a server reads out of the bundle
 * and a browser keeps beside it, so starting the bottle reads nothing back.
 *
 * Packed as it is written, as `publish` sends it: the blocks go to the file
 * behind the room left for the header, the index after them, and the header,
 * known last, into that room.
 *
 * @param {Object} options
 * @param {import('./prefix.js').Prefix} options.prefix
 * @param {FileSystemDirectoryHandle} options.directory  Where bottles are kept.
 * @param {string} options.id                Names the bottle, and its directory.
 * @param {Record<string, unknown>} [options.manifest]  As `publish` takes it.
 * @param {(report: PublishReport) => void} [options.report]
 * @returns {Promise<{ packed: import('./pack.js').PackedSummary,
 *                      manifest: Record<string, unknown> }>}
 */
export async function saveBottle({ prefix, directory, id, manifest = {}, report }){
    windowsChoice(manifest.windows);
    graphicsChoice(manifest.graphics);
    if (!prefix.files.some(file=>file.path !== REGISTRY_PATH))
    {
        throw new Error('the installer produced no files, so there is no bottle to make');
    }
    const entry = String(manifest.entry ?? prefix.entry ?? '');
    const program = prefix.files.find(file=>file.path.toLowerCase() === entry.toLowerCase());
    if (!program)
    {
        throw new Error(`the program to start, ${entry || 'none'}, `
            + 'is not among the installed files');
    }

    const folder = await directory.getDirectoryHandle(id, { create: true });
    const stream = await (await folder.getFileHandle('bundle.btl', { create: true }))
        .createWritable();
    /** @type {import('./pack.js').PackedSummary} */
    let packed;
    try
    {
        await stream.write({ type: 'seek', position: HEADER_SIZE });
        report?.({ stage: 'packing', detail: `${prefix.files.length} files under ${prefix.root}` });
        packed = await packBundle({
            files: prefix.files,
            directories: prefix.directories ?? [],
            write: bytes=>stream.write(/** @type {Uint8Array<ArrayBuffer>} */ (bytes)),
            onProgress: progress=>report?.({
                stage: 'packing',
                detail: progress.path,
                bytes: progress.packedTotal,
            }),
        });
        report?.({ stage: 'finishing' });
        await stream.write(/** @type {Uint8Array<ArrayBuffer>} */ (packed.index));
        await stream.write({ type: 'write', position: 0,
            data: /** @type {Uint8Array<ArrayBuffer>} */ (packed.header) });
        await stream.close();
    }
    catch (e){
        await stream.abort?.();
        throw e;
    }

    const described = bundleManifest(packed, {
        title: id,
        root: prefix.root,
        ...manifest,
        entry: program.path,
    });
    /** @param {string} name @param {Uint8Array} bytes */
    const put = async(name, bytes)=>{
        const writing = await (await folder.getFileHandle(name, { create: true })).createWritable();
        await writing.write(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
        await writing.close();
    };
    await put('entry', program.bytes);
    await put('manifest.json', new TextEncoder().encode(JSON.stringify(described, null, 4)));
    report?.({ stage: 'done', bytes: packed.bytes });
    return { packed, manifest: described };
}
