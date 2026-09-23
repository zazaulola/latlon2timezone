# Лицензии данных / Data licenses

Код в этом репозитории — MIT (см. `LICENSE`). Файлы данных — производные работы
и распространяются на условиях своих источников:

| файл(ы) | источник | лицензия |
|---|---|---|
| `data/tz.bin.gz`, всё, что строит `scripts/build.mjs` и `scripts/partition.mjs` | [timezone-boundary-builder](https://github.com/evansiroky/timezone-boundary-builder) release 2026c, производная от © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| маски морей и океанов в `data/parts/seas`, `data/parts/oceans` | [Natural Earth](https://www.naturalearthdata.com/) 50m `geography_marine_polys` | public domain |
| таблицы стран (`zone.tab`, `zone1970.tab`) | [IANA tz database](https://www.iana.org/time-zones) | public domain |

The code is MIT-licensed. The compiled index `data/tz.bin.gz` and every file produced by
the build scripts are derived from the timezone-boundary-builder dataset, which is derived
from OpenStreetMap and licensed under the Open Database License (ODbL 1.0). If you
redistribute these files or your own builds, keep this attribution and the ODbL terms.
Natural Earth and the IANA tz tables are in the public domain.
