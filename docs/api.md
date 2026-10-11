# BedrockTools API

API REST de BedrockTools implementada con **Cloudflare Pages Functions** ([docs](https://developers.cloudflare.com/pages/functions/)) y **ElysiaJS** ([docs](https://elysiajs.com/), adapter Cloudflare vía `elysia/adapter/cloudflare-worker`).

Toda la API vive bajo `/api/*`, se sirve desde las funciones del propio despliegue (`functions/`) y lee los datos de los assets del sitio (`public/data/*.json`, `public/textures/*`) mediante el binding `ASSETS` — los datos no se duplican dentro del worker.

## Desarrollo local

```bash
bun install
bun run dev:functions   # wrangler pages dev public --port 8787
```

**Nota de runtime:** la app se construye una vez por isolate al arrancar y funciona en el modo dinámico de Elysia (`aot: false`), que no genera código con `new Function` — el runtime de Workers solo permite eso durante el arranque del isolate (flag `allow_eval_during_startup`). Así la API funciona con cualquier `compatibility_date` sin flags especiales; no se necesita ninguna configuración extra de compatibilidad.

Solo las rutas `/api/*` invocan al worker: `public/_routes.json` limita la ejecución de funciones para que el resto de requests se sirvan como assets estáticos (y sigan siendo gratis en Cloudflare Pages).

## Documentación interactiva

| Ruta | Contenido |
|---|---|
| `/api/docs` | Swagger UI (generado por `@elysiajs/openapi`) |
| `/api/openapi/json` | Spec OpenAPI 3 en JSON |

## Endpoints

Base: `https://<tu-dominio>` · Sin autenticación · Respuestas JSON salvo `/api/textures/*` (binario) · Errores siempre `{ "error": string }`.

### Meta

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | `{ status: "ok", version }` |

### Items — `GET /api/items`

Catálogo de 1.617 items con proyección servida por el servidor. Diseñado para que los clientes dejen de descargar `items.json` completo (385 KB) para un simple picker.

| Parámetro | Valores | Efecto |
|---|---|---|
| `lang` | `en` (def.) \| `es` | Con `es`, `displayName` pasa a la traducción española y la original se conserva como `displayNameEn`. |
| `compact` | `1` | Devuelve solo `id, name, displayName, textureUrl, renderAs`. |
| `fields` | `a,b,c` | Allowlist explícita de campos (tiene prioridad sobre `compact`). |
| `kind` | `block` \| `item` \| `layered` | Filtra por `renderAs`. |
| `search` | texto | Substring case-insensitive sobre `name`, `displayName` y `displayNameEs`. |
| `limit` | 1–500 (def. 100) | Máximo de resultados. |

```bash
curl 'http://localhost:8787/api/items?compact=1&lang=es&kind=item&limit=2'
# [{"id":280,"name":"wooden_sword","displayName":"Espada de madera","textureUrl":"/textures/item/wooden_sword.webp","renderAs":"item"}, ...]
```

### Un item — `GET /api/items/:idOrName`

Resuelve por id numérico o por nombre exacto (case-insensitive). 404 `{ "error": "not_found" }` si no existe.

```bash
curl http://localhost:8787/api/items/stone
curl 'http://localhost:8787/api/items/stone?lang=es&fields=id,name,displayName'
```

### Recetas — `GET /api/recipes` y `GET /api/recipes/:itemIdOrName`

`recipes.json` está indexado por id numérico, pero los endpoints aceptan también nombres (`stone` → `1`), siempre en ese orden de resolución. El batch acepta hasta 50 ids/nombres separados por comas; las claves desconocidas se omiten.

```bash
curl http://localhost:8787/api/recipes/stone
# [{"id":1,"name":"stone","recipes":[...]}]

curl 'http://localhost:8787/api/recipes?ids=stone,stick,totally_unknown'
# [{"id":1,...},{"id":947,...}]
```

### Modelos — `GET /api/models/:name`

Devuelve el modelo de bloque **con la cadena de `parent` ya resuelta** (merge de `elements`, resolución de referencias de textura `#ref` y herencia de `display`), replicando la lógica de `src/tools/minecraft-items/model-parser.ts`. Sustituye la descarga del bundle `models/all.json` (216 KB) para consultar un solo modelo.

```bash
curl http://localhost:8787/api/models/stone
# {"name":"stone","elements":[...],"textures":{"all":"minecraft:block/stone","particle":"...",...},"display":null}
```

`textures` contiene cada clave resuelta a su sprite; `display` es `null` si ni el modelo ni sus padres lo definen (el cliente aplica su default).

### Texturas — `GET /api/textures/*`

Resuelve en servidor la cadena de fallbacks que hoy hace el navegador (cada 404 era una petición de más) y devuelve los bytes con `content-type` correcto y `cache-control: public, max-age=31536000, immutable`.

Acepta, a cualquier profundidad:

- nombre o id de ítem (`stone`) → usa la cadena de variantes del propio ítem (`_side`/`_top`/`_bottom`, igual que `getTextureFallbacks` del cliente);
- ruta de textura (`block/stone`, `entity/bed/red`, `bed/red`), con o sin extensión.

```bash
curl -O http://localhost:8787/api/textures/stone
curl -O http://localhost:8787/api/textures/entity/bed/red
```

Las rutas se sanean antes de tocar assets: se rechaza `..`, rutas absolutas y caracteres fuera de `[A-Za-z0-9._/-]` (404 JSON).

## Rendimiento y caché

- **JSON** (`items`, `recipes`, `models`, `block-item-ids`): se parsea una vez por isolate y se cachea en memoria 5 min. El plan gratuito de Workers permite 10 ms de CPU por request, así que el primer request de cada isolate paga el parse y el resto se sirven de memoria.
- **Texturas**: passthrough desde assets con `immutable` (la CDN de Cloudflare las cachea en el edge).
- Las respuestas de texto se comprimen con gzip/brotli en el edge de Cloudflare.

## Estructura

```
functions/
  api/
    [[path]].ts        # entry del Page Function (onRequest)
    app.ts             # app Elysia: rutas, validación, CORS, OpenAPI, onError
    lib/
      env.ts           # interface Env { ASSETS: Fetcher }
      assets.ts        # acceso a assets + saneado de paths + caché de JSON
      items.ts         # carga, proyección, filtrado y búsqueda de items
      recipes.ts       # lookup de recetas por ids
      models.ts        # resolución de la cadena parent de modelos
      textures.ts      # cadena de fallbacks de texturas
  tsconfig.json        # types aislados (@cloudflare/workers-types)
wrangler.jsonc         # name, pages_build_output_dir, compatibility_date
public/_routes.json    # include /api/* (el resto se sirve como estático)
```

## Tests

`tests/api.test.ts` (bun test) cubre los sanecadores, las proyecciones/filtros, el merge de modelos y todos los endpoints contra los datos reales de `public/` mediante un mock del binding `ASSETS`. Ejecutar con `bun test`.

## Notas de despliegue

- `bun run deploy` (`wrangler pages deploy public`) compila `functions/` automáticamente; no hay paso de build adicional.
- Si en el futuro se añaden bindings (KV, etc.), se declaran en `wrangler.jsonc` y `.dev.vars` para local.
- El typecheck de CI (`tsc --noEmit` raíz) sigue comprobando solo `src/`; `functions/` tiene su propio `tsconfig.json`: `bunx tsc -p functions/tsconfig.json`.
