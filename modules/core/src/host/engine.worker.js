/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The worker the engine runs in. A page creates it as a module worker and
 * talks to it through `createRemoteApp`.
 */

import { createApp } from '../app.js';
import { serveEngine } from './serve.js';

serveEngine(/** @type {any} */ (globalThis), { createApp, threaded: true });
