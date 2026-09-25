/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a bundle's build substitutes into the source (`scripts/build.mjs`). The
 * source run as it is -- tests, the harness, a development page -- has none of
 * it, so each reads as absent there.
 */
interface ImportMeta {
    /**
     * `false` in a production bundle, which leaves every diagnostic instrument
     * out of itself: a guard reads `import.meta.BOTTLIFY_DIAGNOSTICS !== false`,
     * so the build folds it to `false` and drops what it guards, and the source
     * keeps it on.
     */
    readonly BOTTLIFY_DIAGNOSTICS?: boolean;
}
