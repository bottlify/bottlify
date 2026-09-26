/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { existsSync } from 'node:fs';

/**
 * The skip option of a test that needs data fetched beside the code -- the
 * hardware corpus, the prebuilt emulator. Skipped in a checkout that never
 * fetched it; run wherever CI is set, so a run that should have judged the
 * corpus fails on the missing file rather than going green without it.
 *
 * @param {...URL} urls
 * @returns {string | false}
 */
export function skipWithout(...urls){
    const missing = urls.filter(url=>!existsSync(url));
    return missing.length > 0 && !process.env.CI
        ? `missing ${missing.map(url=>url.href).join(', ')}` : false;
}
