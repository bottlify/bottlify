# GameHub

Built. Agreed 2026-10-31 and revised the same day as measurements came in: the stores' protocols
moved from the service worker into the tab, then out of the tab into the extension's own frames;
the sign-in moved into the extension's own page. A number not measured says so.

GameHub is the browser extension in the launcher's repository, `bottlify-ui/gamehub`. It extends the launcher and does not work
without it: it keeps the stores' accounts and speaks their protocols, and the page asks it for
finished answers. Bottlify -- `@bottlify/core` and the launcher -- keeps the engine and the install:
the page downloads a game's manifests and chunks from the store's CDN itself, decrypts and
decompresses them, writes the bottle into its own OPFS and applies the redistributables. Steam is
the first store.

## Who does what

Each store has two pages of the extension's, which the build lays out at `<store>/<page>.html` and
the launcher frames; nothing of a store runs in the launcher's tab.

- **The session frame** (`steam/session.html`, `frame.js`), embedded a pixel in size by the
  launcher, speaks the store's protocol: the CM socket it opens, the logon, licences, PICS product
  info, depot keys, manifest request codes, content servers, ownership tickets and Valve's client
  files. It reads the session from the extension's database for a logon. The page asks it the
  store-neutral ops by `postMessage`, checked both ways: the frame hears its parent alone, from
  the parent's origin, and answers that origin; the page hears that frame's window from the
  extension's origin.
- **The sign-in page** (`steam/signin.html`), which the launcher shows in a dialog, draws the QR
  code, or takes the account name and password and then Steam Guard's step: a code by email, a
  code from the mobile authenticator, or an approval in the Steam app. It signs in itself, over a
  CM socket of its own, for as long as it is shown, and seals the token into the extension's
  database; a failed or stalled sign-in says so, with Try again. It posts the launcher
  `{ from: 'bottlify-signin', store, signedIn: { name } }` and nothing else.
- **The extension's database** keeps each store's session: the extension origin's IndexedDB, which
  the content script cannot open (its storage is the page's), the token sealed with AES-GCM under a
  non-extractable key kept beside it (`vault.js`).
- **The content script** says GameHub is there: it marks the page and answers `hello` -- the
  stores, which the site has on, and the extension's origin. It loads no module and holds nothing.
- **The service worker** switches each store's ruleset as the site's `config.json` says (A66) and
  answers the content script which stores are on. It keeps no session and speaks no protocol.

Why not the worker: Chrome keeps an extension's service worker at a low priority (its processes
at Idle on Windows) and stops it when idle. Product info for 704 apps, anonymous, headless Chrome
156, Parallels ARM VM with 4 vCPU: the worker took 2 to 25 s idle and failed or was restarted with
four cores kept busy, where a page took 1.1 to 3.6 s (`bottlify-ui/gamehub/tools/gamehub-bench.mjs`; the entry of
2026-10-31 in `negative-results.md`). A worker that had stopped cost 7 to 19 s to start under the
same load. Why not the tab: a CM logon takes the refresh token itself -- an access token minted
from it does not do (GenerateAccessTokenForApp answered EResult 63 for our SteamClient token,
measured with the user's account, `bottlify-ui/gamehub/tools/steam-access-logon.mjs`) -- and the tab's renderer would
then hold it. Why a frame can: a CM socket opened by an extension page gets the ruleset's Origin
and Steam takes its logon (Chrome 156, measured; a socket the worker opens is never rewritten).

## The ops

`hello` is asked of the content script (`window.postMessage` on the page's origin); every other op
of the store's session frame. A store is an argument, never an op name.

| Op | Answer |
| --- | --- |
| `hello` | `{ version, origin, stores: [{ id, name, on }] }`: the stores, which the site has on, and the extension's origin, where `<origin>/<store>/session.html` and `signin.html` are |
| `account { store, fresh? }` | `{ name }`, or null for nobody signed in |
| `signOut { store }` | `{}` |
| `list { store, fresh? }` | `[{ id, name, bytes, exact, installable, covers }]`: the account's games, with the URLs `cover` answers |
| `cover { store, game, kind }` | the URL of the store's picture (`header`, `capsule`, `hero`), which GameHub's rules open to the page |
| `download { store, game }` | what an install needs; Steam's: `{ name, launch, installscript, art, servers, depots: [{ depot, gid, key, code, shared }] }`, the redistributables' depots asked under the app that owns them |
| `runData { store, game }` | what a run hands the engine's emulation of the store's client; Steam's: `{ win32: { steam: { steamId, accountName, apps, ownershipTickets, clientFiles, appId } } }` |

The frame says `{ from: 'bottlify-gamehub', ready: true }` once it listens. A request code lasts
minutes (not measured how many): a resumed install asks `download` again.

## The threat model

Our own extension code may use the token. What must be impossible is another tab, a script
injected into the page or an XSS on the page getting it, or the password.

- **Nothing secret is in the tab.** The token is read and used in the extension's pages, which run
  in the extension's own process (site isolation keeps a `chrome-extension://` frame out of the
  page's process): the session frame puts it into a logon, the sign-in page receives it from Steam
  and seals it. The content script, the only GameHub code in the tab's renderer, holds nothing.
- **At rest** the token is sealed under a key no script can read out; the database is the
  extension origin's.
- **The password** is typed into the sign-in page, which the launcher's scripts cannot read, and
  goes to Steam sealed with the account's RSA key; it is kept nowhere.
- **Who may frame a store's pages**: the public build lets bottlify.app and play.bottlify.app
  alone; the dev build lets any page and the pages check the host framing them. A page cannot
  reach the worker (no `externally_connectable`), and asks a frame only what the ops answer.
- **What the page gets**: the account's name, the game list, depot keys and request codes (the
  same key for every owner of a depot), and an ownership ticket at a run (lifetime not measured).
  Script injected into bottlify.app could therefore install the account's games into bottlify.app
  and read its list; it cannot sign in without the person, nor read the sign-in page's fields.
- **A compromised extension update gets everything.** It is limited by hardware 2FA on the
  publisher account, builds from tagged commits with the zip's hash published, and the store's
  review.
- Without GameHub there are no stores (A66).

## What is where

| Code | In |
| --- | --- |
| CM connection and messages, logon, licences, product info, ownership tickets (`connection.js`, `messages.js`, `session.js`), depot keys, request codes, content servers (`keys.js`), what an install takes (`apps.js`), Valve's client files (`client.js`), the store's ops (`store.js`) | GameHub, `src/stores/steam/`, run in the session frame (`session-page.js`, `frame.js`) |
| Sign-in by QR code and by password with Steam Guard (`auth.js`, `signin-flow.js`), the sealed sessions (`vault.js`) | GameHub, run in the sign-in page (`signin.js`) |
| Manifest parsing, chunk fetch and decode, AES, LZMA, zstd, protobuf, KeyValues, the QR picture | core |
| The install, the in-place bottle writer, redistributables, installscript | core |
| The emulated Steam client (`layers/win32/steamclient`) | core, fed `runData` |

GameHub's build lays files out by their path under `modules/`, so its modules import core's formats
from one source; only the stores' pages are web-accessible, no module.
`tools/check-store-protocol.mjs` fails a change that puts store-protocol code into core, the
launcher or GameHub's content script.

## Tests

- **The session frame** (`frame.test.js`), with Steam's protocol over a made-up CM and over a
  Steam made up at the protocol's level: the token put into a logon alone and in nothing the page
  is posted through account, list, download, runData and sign-out; a sign-in elsewhere logged on
  with; what it refuses, and a store switched off.
- **The sign-in** (`signin.test.js`) over a made-up authentication service (`auth.fixture.js`): a
  QR code; a password without Steam Guard, Steam reading it back with the key's private half; a
  wrong password; an email code with a wrong one first; a mobile authenticator code; an approval
  in the app; a sign-in stopped with its page; a Steam that stops answering said so; the token in
  nothing sent to the page's steps.
- **The sealed session** (`vault.test.js`); the build (`build.test.js`): the content script loads
  no module, the page may load the stores' pages alone.
- **Live**, `extension.itest.js`: headless Chrome with the dev build against Steam itself,
  anonymous, on a cross-origin isolated page: the session frame's download, the worker stopped
  and the frame going on, the art, a manifest and a chunk, the sign-in page's QR code polled on
  with the worker stopped and its document out of the page's reach, the session sealed, Steam
  switched off.
- **The gates**: the install differential (`modules/core/src/steam/install-directory.test.js`), the bundle build test,
  `check:boundaries` with `tools/check-store-protocol.mjs`.

Not tested against Steam itself: a scanned QR code, a password sign-in and each Steam Guard code
-- they need a person's account.
