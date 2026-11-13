/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Takes something down a step at a time, each step whatever the others did.
 * A teardown written as one block stops at its first throw, and what came
 * after it - a worker terminated, a lent span given back, a port closed - is
 * left standing for the rest of the run, holding whatever it reaches.
 */

/**
 * Runs every step in order, waiting for each; one that throws or rejects is
 * handed to `failed` and the next runs.
 *
 * @param {(() => unknown)[]} steps
 * @param {(error: unknown) => void} failed
 * @returns {Promise<void>}
 */
export async function teardown(steps, failed){
    for (const step of steps)
    {
        try
        {
            await step();
        }
        catch (e){
            try
            {
                failed(e);
            }
            catch {
                // Whoever is told cannot stop the rest either.
            }
        }
    }
}
