# Arquitectura — Tool "Seed Map" (mapa de biomas + localizador de estructuras)

Documento de diseño para `src/tools/seed-map/`. Alineado con el patrón actual
del repo: `index.ts` como entrypoint del bundle ES module, `manifest.ts` puro
(datos, sin dependencias — el build lo importa con `await import`), ES/EN vía
`translations.ts`, UI base en `src/shared/ui.ts`, sitio 100% estático en
Cloudflare Pages, sin frameworks, GPL-3.0.

Motores de cálculo (fuera del bundle): cubiomes (C99, MIT) compilado a WASM con
Emscripten para biomas/terrain Java 1.18+ (= Bedrock 1.18+) y un módulo propio
de estructuras Bedrock escrito desde cero (spec: helix-bedrock/worldgen; nada
de código de Chunkbiomes).

---

## 1. Diagrama de módulos (ascii)

```
┌──────────────────────────────────────────────────────────────────────┐
│                              NAVEGADOR                               │
│                                                                      │
│  index.ts (shell DOM + initUi de shared/ui.ts + wiring)              │
│    │                                                                 │
│    ├── ui/controls.ts ─ form seed · versión · dim · toggle structs   │
│    │         │                                                       │
│    ▼         ▼                                                       │
│  map-view.ts  ── transform mundo↔pantalla, pan/zoom/touch/dpr        │
│    │                                                                 │
│    ▼                                                                 │
│  map-renderer.ts ── 2 canvases (biomas + overlay), frame loop        │
│    │                    │                                            │
│    ▼                    ▼                                            │
│  tile-manager.ts   overlays/markers.ts (+ grid.ts)                   │
│    │ LRU ~160 tiles      │ dibuja StructureResults                   │
│    │                     structures.ts (layout/dedup/labels)         │
│    ▼                     structures/layout.ts (grep de regiones)     │
│  workers/worker-pool.ts ─ N Workers, lotes, prioridad, cancel        │
│    │                                                                 │
│    ▼  postMessage                                    Hilo worker     │
│  workers/seed-worker.ts ───────────────────────────────────────────► │
│    │  1 instancia WASM por Worker (carga perezosa)                   │
│    ▼                                                                 │
│  wasm/bridge.ts ─► java-wasmlib (cubiomes embind)                    │
│                 └─► structures/seed-worker.ts (bedrock-structs) ──┐  │
│                                                                   │  │
│  structures/seed-worker.ts:  (Emscripten MODULARIZE, workers)     │  │
│    - bedrock-rng.ts: MT32 Bedrock + salts por estructura (JS)     │  │
│    - structures-java.ts: region/separation/salt (cubiomes)        │  │
└──────────────────────────────────────────────────────────────────────┘

         public/wasm/
           biomes-java-gen.wasm        (cubiomes, -O3)
           bedrock-structures.wasm     (structs Bedrock, -O2)
           ambos: commiteados, servidos por Cloudflare Pages
```

### Responsabilidad y contrato de cada módulo (profundos, interfaces estrechas)

| Módulo | Responsabilidad única (deep) | API expuesta (estrecha) |
|---|---|---|
| `index.ts` | Composición: instancia los módulos, shell DOM, i18n | `init()` (contrato del repo) |
| `manifest.ts` | Datos de la tarjeta home | igual que el resto de tools |
| `translations.ts` | Textos ES/EN (incl. nombres de biomas/estructuras) | `TranslationTable` |
| `ui/controls.ts` | Formulario seed/versión/dim/estructuras toggle; valida seed 64-bit | `mount(el, state)`, `onChange(cb)` |
| `map-view.ts` | Geometría: transform mundo↔pantalla, rueda/pincha zoom, pan/touch, DPR, centro actual | `state` (seed,dim,ver), `onViewportChange(cb)`, `screenToWorld()`, `fadeTo(cx,cz)` |
| `map-renderer.ts` | Doble canvas (biomas/z-overlays), requestAnimationFrame, pinta tiles recibidos y overlays | `invalidate()`, `onFrame(cb)`, `attach(canvas)` |
| `tile-manager.ts` | LRU de tiles bajo demanda, dedupe, cancelación por viewport, invalidación por (seed,ver,dim) | `requestTile(key) → Promise<Float32Array bits>`, `evictAll()`, `setPriority(cx,cz)` |
| `biome-colors.ts` | Uint32Array precalculado id→RGBA, modo claro/oscuro, legend | `colorOf(id)`, `nameOf(id, lang)` |
| `workers/worker-pool.ts` | Vida del pool, reparto de lotes, cola con prioridad centro-fuera, cancelación | `submit(batch, priority)`, `cancelBatch(id)`, `dispose()` |
| `workers/seed-worker.ts` | Único lugar que conoce WASM ABI; carga módulos; decodifica resultados | handler de mensajes internos |
| `wasm/bridge.ts` | Carga perezosa de los 2 .wasm, allocation de buffers, orden de args | `tileGen(req, out)` ; `findSpawn()` ; `reset(seed, ver)` |
| `structures.ts` | Catálogo de estructuras por versión/dim, su estado (Java/Bedrock), el conmutador | `STRUCTURES(version, dim)`, `find(type, range, seed)` |
| `structures/layout.ts` | Búsqueda de regiones: separación/span por tipo (Java=table, Bedrock=calc) | `regionsFor(type, seed, range)` |
| `bedrock-rng.ts` | RNG MT32 estilo Bedrock + salt por estructura (implementación limpia) | `next(seed)`, `hashCoords(x,z,salt)` |
| `overlays/markers.ts` | Dibujo de iconos de estructuras y hover/sel con estilo compartido | `draw(ctx, results, view)` |
| `overlays/grid.ts` | Rejilla de chunks (fase 1.5, detrás de flag) | `draw(ctx, scale, view)` |

**Regla de dependencias**: estrictamente de arriba hacia abajo en el diagrama.
Ningún módulo bajo conoce a uno alto. La única dependencia a `src/shared/ui.ts`
es `index.ts`. Una sola fuente de verdad de estado (`AppState`) que baja por
parámetros; los callbacks suben eventos.

---

## 2. Integración del build (Emscripten + Bun)

### Dónde vive el C

```
third_party/
  cubiomes/                  ← submodule git → xpple/cubiomes (MIT)
  cubiomes-extensions/       ← C99 propio, GPL-3.0, enlazado contra cubiomes
    bedrock_mt.c/.h             RNG MT32 Bedrock (from spec, no copy)
    bedrock_structures.c/.h     region/separation/salt por estructura (from spec)
    ext_bindings.c/.h           exports emcc: wrapper genBiomeTile + scans struct
```

Los wrappers no redefinen nada de cubiomes: hacen `#include` del código del
submodule en la compilación y exponen una **API estrecha**:

```c
void ext_set_seed(int64_t seed, int version_id);
void ext_gen_biome_tile(int scale, int x, int z, int w, int h, uint8_t *out_rgba);
int  ext_find_structures(int struct_type, int range_chunks, int32_t *out_xy); // devuelve n
void ext_get_spawn(int *x, int *z);
```

### Compilación

`scripts/build-wasm.mjs` (Bun) que orquesta dos llamadas a `emcc`:

1. **`public/wasm/biomes-java-gen.wasm`**
   - Fuentes: `third_party/cubiomes/src/*.c` + `ext_bindings.c`.
   - Flags: `-O3 -msimd128 -fwrapv -sMODULARIZE -sEXPORT_ES6`
     `-sENVIRONMENT=worker` `-sALLOW_MEMORY_GROWTH=1` — **sin pthreads/SAB**
     (la restricción de Cloudflare Pages + estabilidad). SIMD es opcional a
     futuro, no en el MVP.
   - Exports: `ext_set_seed, ext_gen_biome_tile, ext_get_spawn`.
2. **`public/wasm/bedrock-structures.wasm`**
   - Fuentes: `bedrock_mt.c` + `bedrock_structures.c` (no necesita cubiomes).
   - Flags mínimos: `-O2 -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=worker`.
   - Exports: `br_find(type, range, seed_hi, seed_lo, out)`.

Salida también como `.js` glue junto a cada `.wasm`; el `seed-worker` importa
el glue como ES module (mismo origen estático, CORS directo, sin bundler extra
para WASM).

### Comprometido vs generado

| Artefacto | Estado en git |
|---|---|
| `third_party/cubiomes/*` | submodule (referencia + sha pinneado) |
| `third_party/cubiomes-extensions/*` | **commiteado** (código propio) |
| `public/wasm/*.wasm` + glue `.js` | **commiteado** — igual que hoy con `public/data/` y `public/textures/` (lo generado que se sube) |
| `public/tools/seed-map/bundle.js` | gitignored (regenerado por build.mjs, como todos los tools) |
| `public/wasm/checksums.json` | commiteado; generado por `build-wasm.mjs` para que CI valide que el binario corresponde al SHA del submodule |

El `build.mjs` actual no se toca: WASM vive en `public/` y el pipeline de Bun
solo compila TS. Se agrega `build:wasm` como script aparte en `package.json`
documentado en README/CONTRIBUTING, con la nota de que requiere emsdk instalado
(solo se usa al actualizar el submodule o los bindings).

### ¿Dos módulos o uno solo?

Decisión: **dos módulos**.

- El de biomas es grande (cubiomes completo, ~200–500 KB) y depende del
  estándar de cubiomes; el de estructuras Bedrock es pequeño y evoluciona
  rápido. Recompilar el motor de biomas por un fix de salt sería costoso.
- Los Workers pueden diferir la carga: un usuario que solo consulta biomas
  no paga el módulo de estructuras (y viceversa).
- Riesgo asumido: dos instancias de memoria WASM por Worker. Mitigado porque
  el módulo de estructuras usa una arena pequeña y se descarta el buffer tras
  cada lote.

---

## 3. Protocolo de Workers

### Request (main → worker)

```ts
type WorkerRequest = {
  id: number;                       // monótono del pool
  kind: "tiles" | "structures" | "spawn";
  seed: { hi: number; lo: number }; // seed 64-bit como dos i32
  version: number;                  // enum interno compacto
  dim: 0 | 1 | 2;                   // MVP: solo 0
} & ({ kind: "tiles"; tiles: Array<{ x: number; z: number; scale: number }> }
   | { kind: "structures"; types: StructureType[]; region: Rect }
   | { kind: "spawn" });

type WorkerCancel = { type: "cancel"; ids: number[] };       // por lote
type WorkerDrop   = { type: "drop-priority"; generation: number };
```

Cada request lleva un `gen` (número de generación de viewport) para que el
worker pueda descartar trabajo de generaciones viejas — cancel "optimista": el
worker revisa su cola antes de ejecutar el siguiente tile y salta los que ya
no interesan, sin penalizar la cancelación con roundtrips.

### Result (worker → main)

```ts
type WorkerResult = {
  id: number;
  kind: "tiles" | "structures" | "spawn" | "error";
} & (/* tiles: BitmapArray RLE-comprimido + meta por tile */ ...
   | { kind: "structures"; hits: StructureHit[] }
   | { kind: "spawn"; x: number; z: number }
   | { kind: "error"; message: string });

// tras cada tile
type TileResult = { x: number; z: number; scale: number;
                    pixels: Uint8ClampedArray /* transferible */ };
```

Los `Uint8ClampedArray` van como transferables (zero-copy). El JS
`(tabId, uint8clamped)` para WebGL/2D y el `tile-manager` lo convierte a
`ImageData` en el hilo principal; en el Worker se trasvasa con
`new Uint8ClampedArray(...)`,única copia).

### Prioridad centro-fuera

- El `tile-manager` construye el lote ordenado por distancia Manhattan al tile
  central del viewport (en unidades tile).
- Al llegar un `onViewportChange`, el pool **cancela** los lotes en vuelo cuyo
  `batchId` ya no interseca el nuevo viewport y **reordena** la cola pendiente
  para anteponer tiles del nuevo centro.
- Desempate: tiles de la escala actual del mapa primero, luego la escala
  anterior hasta que la nueva sustituya (evita "blanqueo" durante zoom).

### Ciclo

```
map-view ── onViewportChange ──▶ tile-manager (recorta tiles visibles)
   ▲                                   │ ordered request
   │                                   ▼
   │                            worker-pool ──▶ N× seed-worker (WASM)
   │                                   ▲                      │
   └── map-renderer.onFrame ◀── tiles/results (transferables)
```

---

## 4. Modelo de datos

### Tile cache

```
TileKey = seed64hex | version | dim | scale | tx | tz
```

- `seed64hex`: representación textual de la semilla (hex 64-bit) — la clave
  canónica, evita colisiones de `Number` y es legible en DevTools.
- `version`: enum interno `u16` (nombres de cubiomes: `MC_1_21`, …).
- `dim`: 0 overworld (MVP), 1 nether, 2 end (fases posteriores).
- `scale`: exponente del LOD (1:256, 1:4, 1:1 — nativo de cubiomes).
- `tx, tz`: coordenada del tile 256×256 en la cuadrícula global a esa escala.

En TS: objeto `{ seed, version, dim, scale, tx, tz }` con `key()` que produce
string canónico (hash pequeño enlóculo: concatenación con separadores).

Estructura del cache:

```ts
type TileEntry = { canvas: OffscreenCanvas | HTMLCanvasElement; ts: number; bytesApprox: number };
class TileCache {
  get(key: TileKey): TileEntry | null;
  put(key: TileKey, entry: TileEntry): void;   // evicta LRU + canvas doblebuffer
  invalidatePred(pred: (k: TileKey) => boolean): void; // cambio de seed/ver/dim
}
```

Presupuesto de memoria: ~160 tiles a 256×256×4 (≈64 MB peor caso, ~0.25 MB por
tile) — objetivo prudente dentro de 1 pestaña. Eviction LRU siempre respeta
los tiles visibles actuales (dadle prioridad by-priority más barata).

### Estructuras

```ts
type StructureHit = {
  type: StructureType;      // "village" | "amethyst_geode"... (catálogo)
  dim: 0 | 1 | 2;
  x: number; z: number;     // bloque del anchor (ChunKBase usa el anchor)
  chunk: [number, number];  // chunk de anclaje (útil para Bedrock)
  java?: boolean;           // proviene del WASM Java o del módulo Bedrock
  version: number;          // enum congelada de la consulta
};
```

- Estructuras **Java**: buscan en cubiomes con `findStructures` en la
  encorcuesta clásica (candidates por dchunk) — se aproxima vía region en
  escala proper.
- Estructuras **Bedrock**: el módulo C calcula por (type, salt) posición
  dentro de una región `region/space/split` Bedrock — desacoplado de Java.
- Resultado cacheado: `Map<TileSeedVersionDim, StructureHit[]>` **por rango ya
  consultado** (union of ranges con expand — clases registradas al vuelo, rango
  con cache de "ya escaneado" para que al hacer zoom-out no rescatee de nuevo).
- Rango de búsqueda en el MVP: viewport visible + búfer de 1 tile.
- **No** persistencia en IndexedDB en el MVP; sí en fase 2 (rescate costo en
  seeds grandes).

### AppState (núcleo UI, en `state.ts` opcional o dentro de `index.ts`)

```ts
type AppState = {
  seed: bigint;                 // 0 ≤ seed < 2^64 (aunque se admita negativo)
  version: VersionId;           // lista derivada de cubiomes
  dim: 0;                       // MVP
  showStructures: boolean;
  enabledStructures: Set<StructureType>;
};
```

---

## 5. MVP vs fases

### MVP (fase 1)

- Biomas Overworld Java (1.18 → 26.x via cubiomes) + **Bedrock (1.18+)** con
  el selector de edición: los biomas son idénticos, así que un solo motor
  cubre ambas.
- Estructuras mínimas cruzadas: Java: villages, monuments, outposts,
  mansions, strongholds. Bedrock: **villages** (la estructura mejor
  documentada y el riesgo más interesante). Todo lo demás queda curado a
  "próxima fase".
- Mapa 3 niveles de detalle (nativo de cubiomes): 1:256 / 1:4 / 1:1.
- Canvas 2D dos capas (bioma + iconos), LRU en memoria, pool de workers.
- UI ES/EN, seed 64-bit aceptando decimal y hex, "has clic para copiar".
- Spawn point Java (`getSpawn`) label.

### Explícitamente fuera del MVP

| Feature | Fase | Motivo de aplazamiento |
|---|---|---|
| Nether / End (dims 1 y 2) | 1.5 | cubiomes ya lo da; requiere tabla de colores multi-dim y selector de dimensión en UI |
| End Cities Bedrock | 2 | algoritmo Bedrock distinto; no bloquea el bioma |
| Estructuras Bedrock adicionales (monument, mansion…) | 2 | specs parciales; validar antes villages |
| Fuertes Bedrock | 2 | la mecánica de strongholds Bedrock es particularmente distinta |
| IndexedDB (persistencia de tiles cruzando sesiones) | 2 | in-memory cumple presupuestos; el disco añade complejidad de invalidación |
| WASM SIMD dual-build (simd + no-simd)` | 3 | `-msimd128` funciona en todos los navegadores modernos; el fallback tardío satura CI |
| Compartir URL con parámetros (;seed, versión, centro) | 1.5 | barato, pero no crítico para demo/validación |
| Compartir seeds/guardados locales (localStorage lista) | 3 | nítido valor UX |

Criterios de "listo" del MVP: cambiar seed < 1 s; **pan/zoom fluido a 60 fps**
a escala 1:4; zoom 1:1 en un tile < 100 ms; buscar villages en ±8k con
latencia imperceptible; obra matel en móvil de gama media.

---

## 6. Decisión: submodule vs vendor

**Recomendación: submodule git** (`third_party/cubiomes` → `xpple/cubiomes`).

1. **El repo ya commitea artefactos generados** (`public/data/`,
   `public/textures`, los futuros `.wasm`), así el sitio y CI funcionan sin
   `git clone --recursive`. El submodule da trazabilidad sin convertir al
   submodule en un requisito de build.
2. **Actualizaciones frecuentes de cubiomes** (nuevas versiones MC, fixes de
   estructura). Con submodule: bump de SHA + rebuild + commit de `.wasm`
   nuevos → diff atómico "actualización cubiomes" revisable.
3. **Claridad GPL/MIT**: vendor-copy mezclaría el C MIT de cubiomes con código
   GPL propio en un mismo árbol carente de frontera, y dificultaría justo
   atribuir los créditos a cubiomes. El submodule mantiene la separación
   legal límpida (wrapper GPL Enlace dinámico contra biblioteca MIT).
4. Vendor solo se recomendaría si se planea parchear el código de cubiomes
   extensamente; no es el caso (los cambios van en `cubiomes-extensions/`).

Documentación de créditos: sección en README + cabecera en
`docs/architecture.md` — cubiomes (MIT), Chunkbiomes/helix-bedrock citados
como **referencia de especificación** sin código copiado.

---

## 7. Riesgos técnicos de implementación

1. **Riesgo estructuras Bedrock — mayor riesgo del proyecto.** La RNG MT32
   (modificada) de Bedrock y salts por estructura no están formalmente
   documentadas; reverse-engineering empírico puede fallar para estructuras
   nuevas. Mitigación: empezar solo con villages Bedrock; suite de tests con
   seeds fijas + coordenadas esperadas verificadas contra ChunkBase en vivo
   (comparación manual sujeto a bloom;doktor).
2. **Semilla 64-bit en JS**: `Number` pierde precisión > 2^53. Regla del
   proyecto: bigint solo existe en el borde (UI/input/URL) y dentro del
   worker se viaja como `{hi, lo}` i32 sin hacer cast a Number nunca.
   typechecks con tests dedicados.
3. **WASM + ES modules + Workers**: el glue de Emscripten genera código que
   asume opcode distinto; el empaquetado con Bun lo puede morder. Mitigación:
   NO bundlear el glue — se accede por URL directa (`new URL(...,
   import.meta.url)` + `importScripts`) y el worker carga
   `WebAssembly.instantiateStreaming` por su cuenta. Probarlo primero con un
   PoC de 1 worker antes de integrar el pool.
4. **Presión de memoria**: cada Worker con 2 instancias WASM + buffers de
   tile ~0.5 MB en vuelo. Mitigación: límite de tiles en vuelo por worker
   (2), buffers reutilizados por arena (output pointer fijo por worker) y
   liberación explícita al `evictAll`.
5. **Latencia de cambio de seed**: al escribir una nueva seed, destruir/como
   re-instanciar los WASM es asimétrico. Mitigación: `resetSeed` solo
   reconfigura los módulos (set_seed) en lugar de reinstantiar WASM, y el
   tile-manager flush cache atómicamente para evitar mezcla de biomas de
   seeds mezcladas en pantalla (barrier de todos los workers).
6. **Draw subtle en móvil** (canvas 2DO overlay en pantallas retina):
   el corte de `devicePixelRatio` alto + tiles 256 puede fallar a 120 hz.
   Mitigación: canvas por DPR (cap a 2) y escala por CSS; medir el primer
   frame y degradar LOD automático si > presupuesto.
7. **Versión ↔ features de cubiomes**: no todas las versiones soportan todas
   las estructuras (Beta 1.7 vs 26.x). `structures.ts` debe derivar su
   catálogo de la versión elegida y deshabilitar/hide entradas que no
   apliquen (UI: checkboxes con estados disabled).
8. **Cancelación y reorden de cola (racing)**: tiles pendientes tras zoom
   rápido pueden d reapintear en tiles obsoletos. Mitigación: resultado por
   generación (id por lote + `generation` de viewport); el renderer descarta
   resultados con `generation` menor a la actual.

---

## 8. Lista de archivos a crear

```
src/tools/seed-map/
  manifest.ts               Datos de la tarjeta (icon, path, color, platforms)
  index.ts                  Shell + initUi + wiring de módulos (sin lógica propia)
  translations.ts           ES/EN (incl. nombres de estructuras y tooltips)
  map-view.ts               Transform mundo↔pantalla, pan/zoom/touch/DPR
  map-renderer.ts           Doble canvas, rAF, composición biomas+overlay
  tile-manager.ts           LRU tiles, órdenes por lotes, invalidación
  biome-colors.ts           id→RGBA, paleta clara/oscura, leyenda
  structures.ts             Catálogo de estructuras por versión/dim + toggle
  state.ts                  AppState tipado + suscripciones (pub/sub mínimo)
  types.ts                  TileKey, TileReq, StructureHit, enums, rect
  workers/
    worker-pool.ts          Pool, lotes, prioridad, cancelación
    seed-worker.ts          Runtime WASM (un módulo por worker, carga lazy)
  wasm/
    bridge.ts               ABI: carga .wasm, exports envueltos, buffers
    manifest.ts             URLs y hashes de los módulos wasm (SSOT de paths)
  overlays/
    markers.ts              Dibujo de iconos estructuras + hover/selection
    grid.ts                 Rejilla de chunks (detrás de flag, fase 1.5)
  ui/
    controls.ts             Form: seed, versión, dim, toggle estructuras
    status-bar.ts           Coordenadas hover, escala, estado de carga

third_party/
  cubiomes/                 submodule → xpple/cubiomes (MIT)
  cubiomes-extensions/      C99 propio (GPL-3.0), enlaza contra cubiomes
    ext_bindings.c/.h       exports estrechos emcc
    bedrock_mt.c/.h         RNG MT32 Bedrock (desde spec, no copiado)
    bedrock_structures.c/.h region/separation/salt Bedrock

scripts/
  build-wasm.mjs            orquesta emcc → public/wasm/* + checksums.json

public/wasm/
  biomes-java-gen.wasm      (output de emcc, commiteado)
  biomes-java-gen.js        (glue ES module, commiteado)
  bedrock-structures.wasm   (commiteado)
  bedrock-structures.js     (commiteado)
  checksums.json            (hashes para validar CI)

tests/seed-map/
  seed64.test.ts            Parseo/propagación de seeds > 2^53
  tile-key.test.ts          Canonicalización y colisiones de TileKey
  worker-protocol.test.ts   Contrato request/result/cancel con mock
  tile-cache.test.ts        LRU: partida, invalidación por seed/versión
  bedrock-structures.test.ts  Fixtures de seeds/coords esperadas (villages)
```

Nada nuevo se agrega a `public/styles.css` sin necesitarlo: los componentes
de seed-map usan las clases compartidas y una hoja mínima
`src/tools/seed-map/map.css` importada por `index.ts` (Bun la emite como CSS
adentro del bundle; alternativamente su contenido puede ir a
`styles.css` si el repo prefiere seguir con una sola hoja).
