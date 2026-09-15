/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The worker the log keeper runs in. A page creates it as a module worker and
 * talks to it through `createRemoteApp`.
 */

import { serveKeeper } from './keeper.js';

serveKeeper(/** @type {any} */ (globalThis));
