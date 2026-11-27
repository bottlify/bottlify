/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache as the page file stands on it in a test: a Cellar keeper
 * over `budget` bytes of shared memory, its disk a folder of an origin of
 * `quota` bytes in memory, and the space of the pieces in it, only copies
 * that go to the disk (`cacheSpace` with `onlyCopy`, `disk: 'run'`), as the
 * run makes it (`app.js` `openRunPageFile`). The cache layer's `cacheSpace` is
 * handed in by the test: a layer's own code does not import another's.
 */

import { createReader, openKeeper } from '@bottlify/cellar';
import { fakeOpfs } from './opfs.fixture.js';
import { opfsDisk } from './opfs-disk.js';

/**
 * @param {(reader: import('@bottlify/cellar').Reader, name: string,
 *     options: { onlyCopy: boolean, disk: 'run' }) => import('./page-file.js').PieceSpace}
 *     cacheSpace
 * @param {{ budget?: number, segmentBytes?: number, quota?: number, disk?: boolean }} [made]
 *     `disk: false`: a cache in memory alone, as a run with no folder has
 */
export async function pieceSpace(cacheSpace, { budget = 64 << 20,
    segmentBytes = Math.min(budget, 16 << 20), quota = Infinity, disk = true } = {})
{
    const opfs = fakeOpfs({ quota });
    /** @type {import('@bottlify/cellar').Reader | null} */
    let reader = null;
    const keeper = await openKeeper({
        budget, segmentBytes, coldAfterMs: 1e9, now: ()=>0,
        disk: disk ? opfsDisk(await opfs.root.getDirectoryHandle('cache', { create: true })) : null,
        announce: message=>reader?.adopt(message),
    });
    reader = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: ()=>{},
            drop: name=>{
                keeper.drop(name);
            },
        } });
    // The first pack opens behind a promise, as on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    return { keeper, space: cacheSpace(reader, 'pages', { onlyCopy: true, disk: 'run' }) };
}
