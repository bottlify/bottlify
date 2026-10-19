# `@bottlify/core`

[English](README.md)

Запускает 32-битную программу для Windows во вкладке браузера, без изменений. Этот пакет и есть
та Windows, которую видит программа: системные библиотеки, DirectX, OpenGL, звук, ввод и файлы,
написанные с нуля поверх WebGPU, Web Audio и OPFS. Часть [Bottlify](https://github.com/bottlify/bottlify).

## Установка

```sh
npm install @bottlify/core
```

## Пример

```js
import { createApp } from '@bottlify/core';

const canvas = document.querySelector('canvas');
const executable = new Uint8Array(await (await fetch('/bundles/demo/entry')).arrayBuffer());

const app = await createApp({
    canvas,
    executable,
    imagePath: 'C:\\App\\demo.exe',
    bundle: { url: '/bundles/demo/bundle.btl', id: 'demo' },   // the program's files, read on demand
    storage: 'opfs', id: 'demo',                               // saves and settings, kept per id
});
app.input.attach(canvas);
await app.run();
```

Странице нужен WebGPU (`https://` или `localhost`) и сервер, который отдаёт бандл по HTTP Range.
С заголовками `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy:
require-corp` движок делит память со своими воркерами и работает быстрее.

## Документация

На английском:

- [Как начать, как отдавать бутылку, режимы, звук](https://github.com/bottlify/bottlify/blob/main/docs/core/README.md)
- [API](https://github.com/bottlify/bottlify/blob/main/docs/core/api.md),
  [настройки](https://github.com/bottlify/bottlify/blob/main/docs/core/configuration.md),
  [ограничения](https://github.com/bottlify/bottlify/blob/main/docs/core/limits.md)

[Как всё устроено](https://github.com/bottlify/bottlify/blob/main/docs/architecture.ru.md), по-русски.

MPL-2.0; компоненты, которые распространяются вместе с пакетом, перечислены в
`THIRD-PARTY-NOTICES.md`.
