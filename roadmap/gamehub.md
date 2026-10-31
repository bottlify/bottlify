# GameHub

Built. Agreed 2026-10-31 and revised the same day twice: the stores' protocols moved from the
service worker into the tab, and the sign-in into the extension's own page. A number not measured
says so.

GameHub is the browser extension in `modules/bridge`. It extends the launcher and does not work
without it: it keeps the stores' accounts and speaks their protocols, and the page asks it for
finished answers. Bottlify -- `@bottlify/core` and the launcher -- keeps the engine and the install:
the page downloads a game's manifests and chunks from the store's CDN itself, decrypts and
decompresses them, writes the bottle into its own OPFS and applies the redistributables. Steam is
the first store.

## Who does what

- **The service worker keeps the accounts.** Each store's session is in the extension origin's
  IndexedDB, which only the extension's own pages and worker open, its token sealed with AES-GCM
  under a non-extractable key kept beside it (`vault.js`). The worker signs in, over HTTPS
  (`api.steampowered.com`), so the token Steam answers comes to it alone; it signs out; it switches
  each store's ruleset as the site says (A66); and it fetches what the ruleset does not open to a
  page: Steam's directory and Valve's client files.
- **A store's sign-in page** is the extension's, `<store>/signin.html` (`steam/signin.html`), which
  the launcher shows in a frame in Settings → Game Accounts. It draws the QR code, or takes the
  account name and password and then Steam Guard's step: a code by email, a code from the mobile
  authenticator, or an approval in the Steam app. It speaks to the worker alone (a runtime port);
  the launcher's scripts cannot reach its document. When signed in it posts the launcher
  `{ from: 'bottlify-signin', store, signedIn: { name } }`; nothing else crosses.
- **GameHub in the tab** (`tab.js`, run by the content script) reads the page's requests and
  answers them, speaking each store's protocol over sockets the page opens, at the tab's priority.
  For a CM logon it asks the worker for the session. Steam's connection managers refuse a socket
  whose Origin is not theirs; the ruleset rewrites the Origin of the page's sockets.
- **The page** asks store-neutral ops, frames a store's sign-in page, and installs with what
  `download` answers.

Why the protocol runs in the tab: Chrome keeps an extension's service worker at a low priority
(its processes at Idle on Windows), and with the machine busy -- a game running -- its work
waited. Product info for 704 apps, anonymous, headless Chrome 156, Parallels ARM VM with 4 vCPU:
the worker took 2 to 25 s idle and failed or was restarted with four cores kept busy; the page
took 1.1 to 3.6 s under the same load (`tools/gamehub-bench.mjs`; the entry of 2026-10-31 in
`negative-results.md`). A cold `list` with the protocol in the tab took 5.7 s in the user's Chrome
(reported by the user; its conditions not recorded). A worker that has stopped still costs its
start at the first ask: 7 to 19 s with four cores busy, measured.

## The ops

The page asks the content script (`window.postMessage`, `{ to: 'bottlify-bridge', id, op, args }`).
A store is an argument, never an op name.

| Op | Answer |
| --- | --- |
| `hello` | `{ version, origin, stores: [{ id, name, on }] }`: the stores GameHub has, which the site has on, and the extension's origin, where `<origin>/<store>/signin.html` is |
| `account { store, fresh? }` | `{ name }`, or null for nobody signed in |
| `signOut { store }` | `{}` |
| `list { store, fresh? }` | `[{ id, name, bytes, exact, installable, covers }]`: the account's games, with the URLs `cover` answers |
| `cover { store, game, kind }` | the URL of the store's picture (`header`, `capsule`, `hero`), which GameHub's rules open to the page |
| `download { store, game }` | what an install needs; Steam's: `{ name, launch, installscript, art, servers, depots: [{ depot, gid, key, code, shared }] }`, the redistributables' depots asked under the app that owns them |
| `runData { store, game }` | what a run hands the engine's emulation of the store's client; Steam's: `{ win32: { steam: { steamId, accountName, apps, ownershipTickets, clientFiles, appId } } }` |

A sign-in is not an op: the page frames `<origin>/<store>/signin.html`. A request code lasts
minutes (not measured how many): a resumed install asks `download` again.

## The threat model

Our own extension code may use the token. What must be impossible is another tab, a script
injected into the page or an XSS on the page getting it, or the password.

- **At rest** the token is sealed under a key no script can read out; the database is the
  extension origin's.
- **Signing in** happens in the extension's page and the worker. The password is typed into the
  frame, which the page cannot read, goes to the worker over a runtime port, and to Steam sealed
  with the account's RSA key; it is kept nowhere. The token Steam answers comes to the worker over
  HTTPS. The page is told the account's name.
- **A CM logon** takes the refresh token itself: the worker gives it to GameHub in the tab for each
  logon, and it goes into the ClientLogon frame. An access token minted from it does not do:
  GenerateAccessTokenForApp for our SteamClient refresh token answered EResult 63 with no token,
  measured 2026-10-31 with the user's account (`tools/steam-access-logon.mjs`). The content script's
  isolated world is not readable by the page's scripts; it shares the tab's renderer process, so a
  renderer exploit or a Spectre-class read in that process could reach it -- accepted.
- **Who may ask the worker**: its port for a tab only GameHub's own content script in a tab; its
  sign-in port only GameHub's own sign-in pages (the sender's URL). A page cannot connect (no
  `externally_connectable`). The public build runs on bottlify.app and play.bottlify.app alone, and
  only they may frame a sign-in page; the dev build's pages check the host they run on.
- **What the page gets**: the game list, depot keys and request codes (the same key for every owner
  of a depot), and an ownership ticket at a run (lifetime not measured). Script injected into
  bottlify.app could therefore install the account's games into bottlify.app and read its list; it
  cannot sign in without the person, nor read the frame's fields.
- **A compromised extension update gets everything.** It is limited by hardware 2FA on the
  publisher account, builds from tagged commits with the zip's hash published, and the store's
  review.
- Without GameHub there are no stores (A66).

Measured and not used (Chrome 156, headless, 2026-10-31): a CM socket opened by an extension page
-- a frame of the extension's in the launcher's page, or an offscreen document -- gets the ruleset's
Origin and Steam takes its anonymous logon, with the shipped rule and with rules narrowed by
`initiatorDomains`, `tabIds: [-1]` or by URL alone; with the ruleset off it is refused. A socket the
service worker opens is never rewritten (403). So the whole protocol could move into an extension
frame, the token never in the tab's renderer; not chosen.

## What is where

| Code | In |
| --- | --- |
| CM connection and messages, logon, licences, product info, ownership tickets (`connection.js`, `messages.js`, `session.js`), depot keys, request codes, content servers (`keys.js`), what an install takes (`apps.js`), Valve's client files (`client.js`), the store's ops (`store.js`) | GameHub, `src/stores/steam/`, run in the tab |
| Sign-in by QR code and by password with Steam Guard (`auth.js`), Steam's web API (`webapi.js`), the sealed sessions (`vault.js`) | GameHub, run in the worker |
| The sign-in page (`signin.html`, `signin.js`) | GameHub, served at `steam/signin.html` |
| Manifest parsing, chunk fetch and decode, AES, LZMA, zstd, protobuf, KeyValues, the QR picture | core |
| The install, the in-place bottle writer, redistributables, installscript | core |
| The emulated Steam client (`layers/win32/steamclient`) | core, fed `runData` |

GameHub's build lays files out by their path under `modules/`, so its modules import core's formats
from one source. `tools/check-store-protocol.mjs` fails a change that puts store-protocol code back
into core or the launcher.

## Tests

- **The tab and the worker** (`tab.test.js`): the token asked of the worker for a logon alone and in
  nothing the page is posted; after the worker stopped, the CM session going on and a new logon
  given the token the new worker read; a page refused `signIn`.
- **The sign-in** (`signin.test.js`), the worker over a made-up HTTPS Steam (`https.fixture.js`): a
  QR code; a password without Steam Guard, Steam reading it back with the key's private half; a
  wrong password; an email code with a wrong one first; a mobile authenticator code; an approval
  in the app; the token in nothing sent to the sign-in page.
- **The sealed session** (`vault.test.js`).
- **Live, headless Chrome with the dev build**: `signin.itest.js` frames the sign-in page on a
  cross-origin isolated page, the worker's requests answered by the made-up Steam through DevTools'
  interception, and types a password and an email code into the frame: the page is posted the name
  alone, and its document, storage and messages hold neither the password nor the token.
  `extension.itest.js` against Steam itself, anonymous: a download, the art, a manifest and a
  chunk, Steam's QR code in the framed page, the session sealed, Steam switched off.
- **The gates**: the install differential (`tools/steam-install.test.js`), the bundle build test,
  `check:boundaries` with `tools/check-store-protocol.mjs`.

Not tested against Steam itself: a password sign-in and each Steam Guard code -- they need a
person's account.
