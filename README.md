# latlon2timezone

Оффлайн-конвертер географических координат в IANA-зону на чистом JavaScript, без зависимостей.

> **English summary.** Offline `(lat, lon) → IANA time zone` lookup in dependency-free JavaScript
> (Node ≥ 20, browsers, workers). Polygons from timezone-boundary-builder (444 zones incl. oceans)
> are compressed into a quadtree with delta/varint-encoded, Douglas–Peucker-simplified boundary
> fragments: 7.8 MB gzipped for the whole world, boundary error ≤ 11 m, ~9 M lookups/s on random
> points and ~600 k/s within 2 km of a border. Regional builds by country / zone glob / bbox, and a
> partition of the world into ~370 tiles (continents, countries, seas, oceans, Antarctica) with a
> loader that fetches only the tile under the point. Zone metadata (offset, abbreviation, local
> time) comes from `Intl`. Accuracy is verified against the source polygons on 20 000 points.
> The README below is in Russian; the code and CLI flags are self-explanatory.

```js
import { latLonToTimezone, lookupWithInfo } from 'latlon2timezone';

latLonToTimezone(55.7558, 37.6173);   // 'Europe/Moscow'
latLonToTimezone(30, -40);            // 'Etc/GMT+3'  (океан: UTC-3, POSIX-знак)

lookupWithInfo(22.5726, 88.3639);
// { timeZone: 'Asia/Kolkata', offsetMinutes: 330, offset: 'GMT+05:30',
//   abbreviation: 'GMT+5:30', longName: 'India Standard Time', localTime: '2026-09-07 06:20:25' }
```

В браузере / worker'е — платформонезависимый вход без `fs`:

```js
import { createLookup } from 'latlon2timezone/lookup';
const buf = await (await fetch('/tz.bin.gz')).arrayBuffer();     // сервер отдаёт с Content-Encoding или
const tz = createLookup(new Uint8Array(buf));                   // распакуйте DecompressionStream('gzip')
tz.lookup(48.8566, 2.3522); // 'Europe/Paris'
```

## Источник данных

[timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) (релиз `2026c`,
файл `timezones-with-oceans.geojson.zip`) — производная от OpenStreetMap, де-факто стандарт
(его используют geo-tz, timezonefinder и др.). 444 зоны, 8.19 млн вершин, 182 MB GeoJSON.
Вариант «с океанами» делает функцию тотальной: любая точка на планете → зона
(в открытом море это `Etc/GMT±N`).

Имена зон возвращаются как в датасете (современные IANA-идентификаторы: `Asia/Kolkata`,
`Europe/Kyiv`). При сборке каждое имя проверяется через `Intl.DateTimeFormat` — все 444 принимаются.
Смещение, аббревиатура, локальное время берутся из `Intl` (`timezoneInfo(tz, date)`).

## Как сжаты полигоны

`scripts/build.mjs` строит quadtree над `[-180,180]×[-90,90]`:

1. В каждом узле кольца всех зон обрезаются по прямоугольнику узла (Sutherland–Hodgman).
   Обрезка сохраняет winding number внутренних точек, поэтому чётно-нечётный тест на результате точен.
2. Если в ячейке осталась одна зона → лист «зона» (2 байта фактически: ссылка в дереве).
3. На максимальной глубине → «полигональный лист»: зона с наибольшей площадью в ячейке становится
   неявным *default* (её геометрия не хранится), кольца остальных зон квантуются до 16 бит внутри
   ячейки (≈0.6 м при глубине 10), кодируются дельтами + zigzag-varint.
   Опционально — упрощение Дугласа–Пекера с допуском `--tol` (градусы).
4. Поиск: спуск по дереву (≤ depth шагов) → либо ответ сразу, либо ray casting по кольцам листа
   (декодируются на лету, без аллокаций); если точка ни в одном кольце — default.

Формат файла описан в заголовке `build.mjs`; читается одним `createLookup(bytes)` без копирования
(`Int32Array`/`Uint32Array`/`Uint8Array` поверх буфера). Таблица зон и метаданные сборки (релиз,
глубина, допуск, выборка) лежат в файле в виде JSON и доступны как `createLookup(...).zones` / `.meta`.

## Сборка

```bash
npm run download          # data/raw/combined-with-oceans.json (~55 MB zip → 182 MB) + zone.tab/zone1970.tab + Natural Earth
npm run build             # data/tz.bin + tz.bin.gz  (флаги: --depth N --tol DEG --out PATH)
npm test                  # unit-тесты (не требуют исходных данных)
npm run test:reference    # точность против исходных полигонов (20 000 точек)
npm run bench             # производительность
```

### Варианты индекса (release 2026c, 444 зоны)

| depth | tol, ° (≈ м) | bits | вершин | MB в памяти | gzip MB | точность у границ | случайные точки, оп/с | точки <2 км от границы, оп/с |
|---|---|---|---|---|---|---|---|---|
| 10 | 0 (точный) | 16 | 4.43M | 15.20 | 11.93 | 0 промахов из 20 000 | 7.0M | 120k |
| 11 | 0 (точный) | 15 | 4.68M | 17.87 | 12.82 | 0 промахов из 20 000 | 9.0M | 235k |
| 12 | 0 (точный) | 14 | 5.30M | 23.84 | 14.60 | 0 промахов из 20 000 | 9.6M | 462k |
| 10 | 0.0001 (11) | 16 | 1.97M | 8.77 | 6.52 | сдвиг границы ≤ 6 м | 8.2M | 329k |
| **11** | **0.0001 (11)** | **16** | **2.22M** | **11.81** | **7.82** | **сдвиг границы ≤ 8 м** | **9.5M** | **658k** |
| 12 | 0.0001 (11) | 14 | 2.82M | 17.36 | 8.99 | сдвиг границы ≤ 8 м | 9.8M | 1.06M |
| 11 | 0.0002 (22) | 16 | 1.73M | 10.00 | 6.28 | ≤ tol | 9.6M | 930k |
| 10 | 0.0005 (55) | 16 | 0.97M | 5.27 | 3.57 | ≤ tol | 9.0M | 828k |
| 11 | 0.0005 (55) | 16 | 1.23M | 8.11 | 4.58 | сдвиг границы ≤ 45 м | 9.7M | 1.44M |
| 10 | 0.001 (110) | 16 | 0.71M | 4.27 | 2.69 | сдвиг границы ≤ 89 м | 9.3M | 1.23M |

Жирным — конфигурация по умолчанию (`data/tz.bin`): допуск 0.0001° ниже точности самих OSM-границ,
файл вдвое меньше точного, поиск у границ в 5 раз быстрее. «Сдвиг границы» — максимальное расстояние
ошибочно классифицированной тестовой точки до истинной границы (тест `test/reference.mjs` падает,
если оно превышает `tol` + погрешность квантования 2e-5°).

Точный индекс: `npm run build -- --tol 0 --depth 10`; компактный (4 MB): `npm run build -- --tol 0.001 --depth 10`.
Глубина увеличивает число узлов (16 байт на внутренний узел) и число вершин на разрезах,
но пропорционально уменьшает работу в полигональных листах. `--bits` задаёт квантование внутри ячейки:
при глубине 10 и 16 битах шаг ≈ 5·10⁻⁶° (0.6 м); при большей глубине можно снижать биты, сохраняя шаг.

Важно для упрощения: вершины, лежащие на границе ячейки, являются якорями Дугласа–Пекера, поэтому
упрощение никогда не сдвигает искусственные рёбра ячеек — только реальную границу, и не более чем на `tol`.
Без этого точки на краю ячейки уходили в чужую зону на сотни метров (обнаружено тестом).
Сборка любого варианта — 20–40 с (плюс gzip/brotli), пик памяти ~2 GB.

## Региональные сборки

Полный индекс весит 7.8 MB gzip — много для медленных или лимитированных соединений. Сборщик умеет
хранить геометрию только выбранных стран, зон или прямоугольника; всё остальное становится
«нет зоны», и `lookup()` там возвращает `null` (клиент может сходить на сервер или взять UTC).

```bash
# по странам (ISO 3166-1 alpha-2; страны → зоны через zone.tab / zone1970.tab из tzdb)
node scripts/build.mjs --countries US,CA,MX --out data/tz-na.bin
# страна + дополнительные зоны по маскам (Крым в zone.tab отнесён к UA; океан у побережья — Etc/*)
node scripts/build.mjs --countries RU --zones Europe/Simferopol --out data/tz-ru.bin
node scripts/build.mjs --countries US --zones 'Etc/GMT+5,Etc/GMT+6,Etc/GMT+7,Etc/GMT+8' --out data/tz-us.bin
# прямоугольник minLon,minLat,maxLon,maxLat — все зоны внутри, включая океан
node scripts/build.mjs --bbox -25,34,45,72 --out data/tz-europe.bin
```

| сборка | зон | MB в памяти | gzip MB | brotli MB |
|---|---|---|---|---|
| весь мир (по умолчанию) | 444 | 11.81 | 7.82 | 6.63 |
| `--countries US,CA,MX` | 64 | 1.49 | 1.08 | 0.92 |
| `--countries RU --zones Europe/Simferopol` | 27 | 1.58 | 1.21 | 1.04 |
| `--countries US --zones 'Etc/GMT+5..+10'` | 35 | 1.25 | 0.67 | 0.57 |
| `--bbox -25,34,45,72` (Европа) | 81 | 1.47 | 1.12 | 0.97 |

Как это работает внутри: невыбранные зоны отбрасываются до построения дерева (при `--bbox` кольца
дополнительно обрезаются по прямоугольнику). В ячейке, где единственная оставшаяся зона покрывает
её не полностью (остаток принадлежал отброшенным зонам), дерево дробится дальше, а на нижнем уровне
default-зона листа становится «нет зоны» и хранятся кольца всех выбранных зон. Снаружи страны
граница поэтому хранится с той же точностью, что и внутри.

Использование:

```js
import { createLookupFromFile } from 'latlon2timezone';
const na = createLookupFromFile('data/tz-na.bin.gz');
na.lookup(40.71, -74.0);   // 'America/New_York'
na.lookup(48.85, 2.35);    // null — вне сборки
na.meta;                   // { release: '2026c', depth: 11, tol: 0.0001, bits: 16,
                           //   selection: { countries: ['US','CA','MX'], zonePatterns: [], bbox: null } }
```

`test/reference.mjs --data data/tz-na.bin` проверяет региональную сборку тем же эталоном: точки, чья
истинная зона не входит в сборку (или лежат вне bbox), должны давать `null`, остальные — верную зону
с тем же контролем допуска. Поиск в региональной сборке быстрее (2.8M оп/с у границ для Северной
Америки против 660k у мировой), так как в листах меньше геометрии.

## Разбиение мира на части (тайлы)

`scripts/partition.mjs` строит набор региональных индексов и манифест к ним, а `src/tiled.mjs`
загружает нужную часть по координате. Пять групп:

| группа | принцип | частей | gzip суммарно |
|---|---|---|---|
| `continents` | суша по частям света: africa, asia, europe, north_america, south_america, oceania (зоны по префиксу IANA; America/* делится по стране на Северную/Южную; список исключений в `CONTINENT_OVERRIDES`) | 6 | 7.70 MB |
| `countries` | суша по государствам: зоны страны из `zone.tab`; страны без собственной зоны (Багамы → America/Toronto и т.п.) получают общую зону из `zone1970.tab` и помечены `sharedZones` | 247 | 11.39 MB |
| `seas` | воды по морям, заливам, проливам: полигоны Natural Earth 50m (`featurecla` ≠ ocean/river/reef); внутрь части попадает вся геометрия под полигоном, включая территориальные воды | 106 | 2.50 MB |
| `oceans` | воды по семи океанам (Natural Earth); участки воды, не покрытые ни одним морским полигоном (≈1.4 % океанских точек, в основном у берегов Антарктиды и Арктики), отдаются ближайшему океану | 7 | 1.55 MB |
| `antarctica` | зоны Antarctica/* + Indian/Kerguelen | 1 | 55 kB |

Группы `countries`/`continents` взаимозаменяемы, как и `seas`+`oceans` вместе против одного мирового
файла. Полное покрытие мира дают наборы `countries + seas + oceans + antarctica` (15.5 MB gzip суммарно,
но клиент качает только части под своей точкой) или `continents + seas + oceans + antarctica` (11.8 MB).

```bash
npm run download        # добавит data/raw/ne_50m_marine.geojson (Natural Earth, public domain)
npm run partition       # data/parts/<group>/<part>.bin.gz + data/parts/manifest.json, ~65 с
node scripts/partition.mjs --groups seas --only baltic-sea      # одна часть
node scripts/partition.mjs --dump-config cfg.json               # выгрузить правила, поправить, --config cfg.json
node test/partition.test.mjs                                    # полнота покрытия по 20 000 эталонных точек
```

Как строится часть по маске-полигону (море/океан): полигон-цель и все соседние полигоны обрезаются по
ячейкам вместе с зонами. Ячейка целиком вне цели → «нет зоны»; целиком внутри → обычная сборка;
частично → дробление, а на нижнем уровне ячейка включается целиком (перехлёст ≤ одной ячейки ≈ 0.18°,
соседние части слегка дублируют друг друга по границе). Ячейка, не покрытая ни одним морским полигоном,
но содержащая воду (Etc-зону), для группы `oceans` уходит ближайшему океану — так у вод нет дыр.

Манифест для каждой части хранит `bbox` реально записанной геометрии, список зон и размеры.
Загрузчик перебирает части, чей bbox содержит точку, от меньшей к большей (страна раньше континента,
море раньше океана), подгружает их лениво и берёт первый ответ, не равный `null`.

```js
import { createTiledLookup } from 'latlon2timezone/tiled';
const manifest = await (await fetch('/parts/manifest.json')).json();
const tz = createTiledLookup({
  manifest,
  groups: ['countries', 'seas', 'oceans', 'antarctica'],
  load: async part => new Uint8Array(await (await fetch('/parts/' + part.file)).arrayBuffer()), // сервер отдаёт .gz с Content-Encoding
});
await tz.lookup(59.93, 30.33);        // 'Europe/Moscow' — скачался только countries/RU.bin.gz
tz.lookupSync(59.93, 30.33);          // синхронно по уже загруженным частям (undefined, если нужна догрузка)
await tz.preload([20, 35, 45, 60]);   // заранее подтянуть всё под bbox
```

В Node: `tiledLookupFromDir('data/parts', groups)`.

## Тест точности

`test/reference.mjs` считает эталон честным point-in-polygon по исходному GeoJSON для 20 000 точек:
10 000 равномерно по сфере, 5 000 в радиусе ~2 км от границ зон и 5 000 в радиусе ~200 м
(точки берутся у случайных вершин полигонов суши). Ответы кэшируются в `data/reference-points.json`.

В самом датасете есть намеренные перекрытия (Синьцзян: `Asia/Shanghai`/`Asia/Urumqi`;
`Asia/Hebron`/`Asia/Jerusalem`; Абьей; ряд спорных участков) — там любой из перекрывающихся
ответов считается верным; библиотека возвращает один из них детерминированно.

## Бенчмарк


`bench/bench.mjs` (Node 26, Apple Silicon, конфигурация по умолчанию), `bench/compare.mjs` — таблица по всем собранным вариантам.

| сценарий | оп/с | нс/оп |
|---|---|---|
| загрузка `tz.bin` (read + parse, без копирования) | 2–3 мс | |
| загрузка `tz.bin.gz` (read + gunzip + parse) | ~33 мс | |
| равномерно случайные точки на сфере (70 % океан) | 8.1–9.5M | 105–123 |
| случайные точки на суше | 6.9–7.7M | 130–146 |
| точки в пределах 2 км от границ зон (худший случай) | 560–660k | 1 500–1 800 |
| 16 крупных городов (горячий кэш) | 37M | 27 |

Пороговые значения в бенче (`TARGETS`): ≥ 2M оп/с на случайных точках, ≥ 200k оп/с у границ,
загрузка ≤ 200 мс — выставлены с запасом ~4× относительно измеренного, чтобы проходить на слабом железе.
Бенч завершается кодом 1, если порог не достигнут.

Поиск не аллоцирует (кольца декодируются из varint-потока на лету), поэтому нет GC-пауз;
память процесса растёт ровно на размер файла.

## Лицензии

Код — MIT. Индекс `data/tz.bin.gz` и всё, что строят скрипты, — производные от
timezone-boundary-builder (© OpenStreetMap contributors, ODbL 1.0); полигоны морей Natural Earth и
таблицы IANA — public domain. Подробности и требования атрибуции — в [DATA-LICENSE.md](DATA-LICENSE.md).
