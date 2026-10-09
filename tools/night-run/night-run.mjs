/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The night run: one agent session per broken bottle, one after another, each
 * told to bring its title up to its loading screen through the harness and to
 * fix what stops it in the generic layer that is wrong.
 *
 * Sessions run on the Claude Agent SDK and bill the API key in
 * ANTHROPIC_API_KEY, or in .api_key.txt beside the repository (outside it, so
 * no commit can take it in) -- a file, so the key is not in the environment of
 * every Claude Code session on the machine, which would then bill it too.
 * Never a subscription. They run one at a time because the
 * harness drives one browser and the tree has one checkout; each starts with a
 * fresh context, so one title's hunt does not crowd out the next.
 *
 * Usage (from the repository root):
 *   node tools/night-run/night-run.mjs [--budget USD] [--model ID] [--minutes N]
 *       [--only id,id] [--skip id,id] [--dry]
 *
 * A bottle is broken unless its manifest labels it playable; the Wine test
 * bottles (labelled test) are not titles and are left out.
 * They go in alphabetical order of title. The budget is shared out evenly
 * over the bottles not yet run, so an early long hunt leaves less for the rest
 * rather than running the key dry. Every session's messages
 * go to dbg/night/<id>.log and a line per bottle to dbg/night/summary.md.
 */

import { readdir, readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dbg', 'night');

/** @param {string[]} argv */
function parseFlags(argv){
    /** @type {Record<string, string | true>} */
    const flags = {};
    for (let at = 0; at < argv.length; at++)
    {
        if (!argv[at].startsWith('--'))
        {
            continue;
        }
        const name = argv[at].slice(2);
        const next = argv[at + 1];
        flags[name] = next && !next.startsWith('--') ? (at++, next) : true;
    }
    return flags;
}

const flags = parseFlags(process.argv.slice(2));
const budget = Number(flags.budget ?? 190);
const model = String(flags.model ?? 'claude-opus-5-5');
const minutes = Number(flags.minutes ?? 75);
const list = (/** @type {string | true | undefined} */ value)=>
    (typeof value === 'string' ? value.split(',').filter(Boolean) : []);
const only = list(flags.only);
const skip = list(flags.skip);

/** @returns {Promise<{ id: string, title: string, labels: string[] }[]>} */
async function brokenBottles(){
    const bottles = [];
    for (const id of await readdir(join(ROOT, 'bundles')))
    {
        const text = await readFile(join(ROOT, 'bundles', id, 'manifest.json'), 'utf8')
            .catch(()=>null);
        if (text === null)
        {
            continue;
        }
        const manifest = JSON.parse(text);
        const labels = Array.isArray(manifest.labels) ? manifest.labels : [];
        const chosen = only.length ? only.includes(id)
            : !id.startsWith('wine-') && !labels.some((/** @type {string} */ label)=>
                ['playable', 'test'].includes(label));
        if (chosen && !skip.includes(id))
        {
            bottles.push({ id, title: String(manifest.title ?? id).trim(), labels });
        }
    }
    return bottles.sort((a, b)=>a.title.localeCompare(b.title));
}

/** @param {{ id: string, title: string, labels: string[] }} bottle @param {number} dollars */
const brief = (bottle, dollars)=>`Night run, one bottle: "${bottle.title}" \
(bundle id ${bottle.id}, labels: ${bottle.labels.join(', ') || 'none'}). \
Nobody is watching; do not ask questions.

Goal: get into the game -- past its launcher, settings dialogs, intro films and menus, through \
New Game / Single Player / a skirmish or the first level, until the title is loading its world or \
is in it. A main menu is not the goal. Solved means a harness run shows the title in its game and \
the fixes are committed. A dead end means every approach was refuted by measurement -- say what \
was measured.

The route: bundles/${bottle.id}/route.json, beside the bundle, holds the game.mjs flags that take \
this title from its start into the game (format: --route in tools/cdp_test/README.md). If it is \
there, start with it (game.mjs ${bottle.id} --route ...). If it is not, find the way in and save \
it there before you finish -- even when nothing needed fixing -- with "reaches" saying what screen \
it ends on. A route that no longer gets in is corrected, not worked around.

The steps, in order:
1. Read CLAUDE.md, tools/cdp_test/README.md and the bringup skill (.claude/skills/bringup).
2. What is missing from the start: node tools/import-audit.mjs bundles/${bottle.id}/bundle.btl \
--dynamic --specs dbg/specs.
3. Add it: implement every missing entry point the title's own executables reach, by contract, \
with tests.
4. Run the title and fix everything up to its first start in the game (below).
5. Commit each fix to review and push it; the message says what was fixed and why -- the \
contract that was wrong and what the title did because of it.
6. When the title reaches its game, label it playable: add "playable" to "labels" in \
bundles/${bottle.id}/manifest.json (that file is not in git; keep the rest of it as it is). \
Not before.
7. Leave the test's route beside the game: bundles/${bottle.id}/route.json.
8. Copy the screenshot that shows how far the title got (in its game, or where it stops) to \
dbg/night/${bottle.id}.png; the person reads it in the morning.

How:
- Run it: node tools/cdp_test/game.mjs ${bottle.id} --headed --worker --coi --wait 240 (more if \
the title loads slowly). Read the report and the files the game itself wrote before theorising.
- Find the way in by looking: read the screenshots (the PNGs) and walk the screens a step at a \
time with tools/cdp_test/live/drive.mjs (/shot, /click, /key, /type -- see \
tools/cdp_test/README.md), then write the route as game.mjs flags (--click x,y,Ns, --key Code,Ns, \
--click-at x,y,ms, --press "Play|OK") and confirm that one run with --route gets in on its own.
- Fix the generic contract that is wrong -- never branch on a program's name, executable or hash, \
never hardcode an offset for one title. Every fix carries a test in the same change.
- Run only the touched layer's tests and gates (the table in CLAUDE.md), npm run typecheck and \
npm run lint. No full test suite.

Rules:
- Work in this checkout on branch review. Commit each fix and push it (git push origin review). \
No Co-Authored-By or session lines in commit messages. Never stage bottlify-ui/public/config.json \
or anything holding a token. Temporary files go to dbg/.
- Do not start, stop or restart the launcher on port 5180 or the bottle server on 8788. Only the \
harness browser; one run at a time.
- Do not touch modules/cork's translator: if the title stops inside the translator, write down \
the evidence and move on.
- This session has about $${dollars.toFixed(0)} of API budget. When the title is in its game \
and the route is saved, or the budget is nearly spent, stop.

Finish with one short paragraph: solved / dead end / out of budget, how far the title gets, \
whether the route is saved, the commits made (hashes), and what stops the title now.`;

async function main(){
    const key = process.env.ANTHROPIC_API_KEY
        ?? (await readFile(join(ROOT, '..', '.api_key.txt'), 'utf8').catch(()=>'')).trim();
    if (!key)
    {
        throw new Error('no API key (ANTHROPIC_API_KEY or ../.api_key.txt): '
            + 'the night run bills an API key, never a subscription');
    }
    await mkdir(OUT, { recursive: true });
    const bottles = await brokenBottles();
    console.log(`${bottles.length} bottles, $${budget} over them, ${model}, ${minutes} min each`);
    for (const bottle of bottles)
    {
        console.log(`  ${bottle.id}  ${bottle.title}  [${bottle.labels.join(',')}]`);
    }
    if (flags.dry)
    {
        return;
    }
    const summary = join(OUT, 'summary.md');
    await appendFile(summary,
        `\n## Night run ${new Date().toISOString()} -- ${model}, $${budget}\n\n`);

    let spent = 0;
    for (const [index, bottle] of bottles.entries())
    {
        const share = (budget - spent) / (bottles.length - index);
        if (share < 1)
        {
            await appendFile(summary, `- budget spent; stopped before ${bottle.title}\n`);
            break;
        }
        const log = join(OUT, `${bottle.id}.log`);
        await writeFile(log, `# ${bottle.title} -- $${share.toFixed(2)}\n`);
        const abort = new AbortController();
        const timer = setTimeout(()=>abort.abort(), minutes * 60_000);
        let cost = 0;
        let outcome = 'no result';
        let last = '';
        try
        {
            for await (const message of query({
                prompt: brief(bottle, share),
                options: {
                    cwd: ROOT,
                    model,
                    maxBudgetUsd: share,
                    permissionMode: 'bypassPermissions',
                    allowDangerouslySkipPermissions: true,
                    systemPrompt: { type: 'preset', preset: 'claude_code' },
                    settingSources: ['project'],
                    abortController: abort,
                    env: { ...process.env, ANTHROPIC_API_KEY: key },
                },
            }))
            {
                if (message.type === 'assistant')
                {
                    for (const block of message.message.content)
                    {
                        const line = block.type === 'text' ? block.text
                            : block.type === 'tool_use'
                                ? `> ${block.name} ${JSON.stringify(block.input).slice(0, 400)}`
                                : '';
                        if (line)
                        {
                            last = block.type === 'text' ? block.text : last;
                            await appendFile(log, `${line}\n`);
                        }
                    }
                }
                else if (message.type === 'result')
                {
                    cost = message.total_cost_usd;
                    outcome = message.subtype;
                    if (message.subtype === 'success')
                    {
                        last = message.result;
                    }
                }
            }
        }
        catch (e){
            outcome = abort.signal.aborted ? `stopped after ${minutes} min`
                : `failed: ${/** @type {Error} */ (e).message}`;
        }
        finally
        {
            clearTimeout(timer);
        }
        // A session stopped by the clock leaves no result to read its cost from;
        // its whole share is counted, so the rest is not overspent.
        spent += cost || (abort.signal.aborted ? share : 0);
        const line = `- **${bottle.title}** (${bottle.id}) -- ${outcome}, $${cost.toFixed(2)}: `
            + `${last.replace(/\s+/g, ' ').trim().slice(0, 1200)}\n`;
        await appendFile(summary, line);
        console.log(line.trim());
    }
    await appendFile(summary, `\nSpent $${spent.toFixed(2)} of $${budget}.\n`);
    console.log(`spent $${spent.toFixed(2)}`);
}

await main();
