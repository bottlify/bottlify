# `@bottlify/core`

[English](README.md)

Запускает 32-битную программу для Windows во вкладке браузера: оригинальный `.exe`, без изменений.

Этот пакет и есть та Windows, которую видит программа. Он отвечает на её вызовы Windows
(`kernel32`, `user32`, `gdi32`, DirectDraw, Direct3D 7–10, OpenGL, DirectSound, Winsock и
остальные) через WebGPU, Web Audio и личную файловую систему сайта (OPFS). Самой Windows под ним
нет, и кода Windows внутри тоже нет ([как это устроено](../../docs/architecture.ru.md)).

Проект ранний: одни программы доходят до меню и дальше, многие останавливаются на API, которого
ещё нет, и лог называет его. Чего не хватает, перечислено в
[`docs/core/limits.md`](../../docs/core/limits.md).

## Игра за три команды

Из клона этого репозитория, с Node 22 или новее:

```sh
npm ci && npm run build                                   # builds modules/core/dist
node tools/make-btl.mjs pack "/path/to/My Game" mygame     # bundles/mygame/bundle.btl + manifest.json
node tools/play.mjs mygame                                 # prints http://127.0.0.1:8080/?bottle=mygame
```

Откройте адрес в Chrome или Edge (нужен WebGPU) и нажмите Start.

- **Папка** это установленная игра: её `.exe`, её DLL, её данные. `pack` принимает папку, а не
  архив: `.zip` сначала распакуйте (`unzip game.zip -d game`).
- **Точку входа**, то есть программу для запуска, `pack` угадывает: это самый большой `.exe`,
  который не установщик и не лаунчер. Если угадал неверно, укажите `"entry"` в
  `bundles/mygame/manifest.json` (путь внутри бандла, например `"Bin\\Game.exe"`) и удалите
  `bundles/mygame/entry`, если он есть.
- **Из установщика**, а не из установленной папки: [`@bottlify/installer`](../installer/README.md)
  запускает установщик внутри движка и собирает бутылку из того, что он установил.
- Другие команды для бутылок: `node tools/make-btl.mjs verify mygame`, `list mygame [pattern]`,
  `extract mygame [file]`.

## Бутылка на своей странице

Странице нужны три вещи с одного источника (origin):

| Путь | Что | Откуда |
| --- | --- | --- |
| `/bottlify/` | движок: `core.js`, его воркеры, `worklet.js`, `cork/`, `vendor/` | `modules/core/dist` после `npm run build` |
| `/bundles/<id>/bundle.btl`, `manifest.json` | бутылка, читается по блокам | `make-btl pack` |
| `/bundles/<id>/entry` | образ программы, его `createApp` принимает байтами | `node tools/make-btl.mjs extract <id>` |

Отдавайте `bundle.btl` с поддержкой **HTTP Range** (`206 Partial Content`): движок никогда не
скачивает игру целиком, он читает те блоки, которые просит программа, и хранит их в OPFS. Так
умеют nginx, Caddy, Apache, `npx http-server` и большинство CDN; `http.server` из Python не умеет.

Желательно отдавать каждый ответ с заголовками

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Они включают режим `isolated`, в котором движок делит память со своими воркерами; без них страница
работает в режиме `compatible`. Чем режимы отличаются, сказано в
[Which mode](../../docs/core/README.md#which-mode). WebGPU работает только на `https://` или
`localhost`.

Сама страница лежит в [`tools/play/index.html`](../../tools/play/index.html): скопируйте её
целиком или возьмите главное:

```html
<canvas id="screen" width="640" height="480"></canvas>
<button id="start">Start</button>
<script type="module">
import { createApp } from '/bottlify/core.js';

const id = 'mygame';
document.getElementById('start').onclick = async()=>{
    const manifest = await (await fetch(`/bundles/${id}/manifest.json`)).json();
    const executable = new Uint8Array(await (await fetch(`/bundles/${id}/entry`)).arrayBuffer());
    const canvas = document.getElementById('screen');
    const app = await createApp({
        canvas,
        executable,
        imagePath: `C:\\App\\${manifest.entry}`,          // the bottle is mounted at C:\App
        bundle: { url: `/bundles/${id}/bundle.btl`, id, indexSha256: manifest.bundle.indexSha256 },
        storage: 'opfs', id,                             // saves and settings, kept per bottle
    });
    app.input.attach(canvas);
    app.on('message-box', box=>app.answerMessageBox(box.id, box.defaultButton));
    console.log('exit code', await app.run());
};
</script>
```

Полная страница ещё и играет звук ([Sound](../../docs/core/README.md#sound)), поэтому запускается
по клику: браузер включает звук только после действия человека. Кроме того, бутылку, собранную
установщиком, она монтирует туда, куда её поставил установщик, а не в `C:\App`.

`node tools/play.mjs <id> [--port 8080] [--compatible]` это локальный сервер ровно под такую
раскладку, с Range и заголовками изоляции (`--compatible` их не ставит). Для замеров страница
плеера берёт из адреса ещё две настройки: `&executors=3` выполняет потоки программы на трёх
исполнителях сразу (`executors` у `createApp`), а `&cork={"checkReads":true}` задаёт настройки
транслятора (`EngineConfig`).

## Установка пакетом

```sh
npm install @bottlify/core      # or: npm install <checkout>/modules/core
```

```js
import { createApp } from '@bottlify/core';
```

`createApp` ищет свои воркеры, `cork/` и `vendor/` рядом с `core.js`; если сборщик раскладывает
файлы иначе, передайте `workerUrl` и `cork: { moduleUrl }`. Видеодекодер FFmpeg лежит отдельным
путём, `@bottlify/core/video-decoder.wasm`, и передаётся как `media: { wasmBytes }`; без него
программе сообщают, что ролики проигрывать нечем. Все опции, контроллер и события описаны в
[`docs/core/api.md`](../../docs/core/api.md).

### Без cork: v86

```js
const app = await createApp({ executable, engine: 'emulator',
    v86: { moduleUrl: '/v86/libv86.mjs', wasmBytes: await (await fetch('/v86/v86.wasm')).arrayBuffer() } });
```

v86 в пакет не входит; без своей сборки `engine: 'emulator'` откажет.

### В Node

Тот же `createApp` работает в Node без окна: без canvas, движок в вызывающем потоке. Так программы
запускают тесты, и так удобно запускать консольные программы и установщики:

```js
import { readFile } from 'node:fs/promises';
import { createApp } from '@bottlify/core';

const app = await createApp({ executable: new Uint8Array(await readFile('tool.exe')) });
app.on('output', ({ text })=>process.stdout.write(text));
console.log('exit code', await app.run());
await app.dispose();
```

## Что ещё есть в пакете

| Экспорт | Что это |
| --- | --- |
| `@bottlify/core` | `createApp`, `assembleModules` (слои без программы), `createLogReader` |
| `@bottlify/core/bundle`, `/bundle/node` | константы формата `.btl`; чтение и запись бандлов в Node |
| `@bottlify/core/iso` | чтение образов дисков ISO 9660 |
| `@bottlify/core/worklet.js` | `AudioWorklet` звукового вывода |

## Документация

- [`docs/core/`](../../docs/core/README.md) (на английском): страница, режимы, звук;
  в [`api.md`](../../docs/core/api.md) все опции и события,
  в [`configuration.md`](../../docs/core/configuration.md) настройки каждого слоя,
  в [`limits.md`](../../docs/core/limits.md) то, чего ещё нет.
- [`docs/architecture.ru.md`](../../docs/architecture.ru.md): как всё устроено внутри.
- [`@bottlify/networking`](../networking/README.md): сетевая игра и интернет для программы.

## Лицензия

MPL-2.0. См. `LICENSE`, а компоненты, которые распространяются вместе с пакетом, перечислены в
`THIRD-PARTY-NOTICES.md`.
