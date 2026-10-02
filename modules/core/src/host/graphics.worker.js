/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The worker the Direct3D 8 and 9 devices draw in, on a GPU device of its
 * own; the engine's worker opens it (`graphics-worker.js`) and sends it each
 * root's calls.
 */

import { serveGraphics } from '../layers/graphics/remote/worker.js';

serveGraphics(/** @type {any} */ (globalThis), { gpu: /** @type {any} */ (navigator).gpu });
