# ADR 006: The Admin UI Moves to Vision UI as a Vue 3 App

## Status

Accepted. Implements milestone M10 and supersedes the "tokens over SSR" option that M10
described before the design system was available locally.

## Context

The admin UI carried its whole visual language in one ~600-line inline `<style>` inside
`apps/admin-web/src/pages/layout.js`: a hand-picked palette, a serif font, and no shared layer
of primitives, so every new screen re-invented spacing and colour by hand.

The target is **Vision UI**, the company design system (`@vi-frontend/vision-ui`, version
1.16.0). It is a **Vue 3 component library**, while `admin-web` is server-rendered HTML over
plain `node:http` with no framework, no build step and no third-party dependency at all — its
image ships without `node_modules`. So this was never "swap the CSS"; it was a choice between
two different programs.

Two routes were considered:

- **А — a Vue 3 app on the real components.** Real Vision UI, no drift from the design system.
  Costs the no-build-step property and adds a dependency on an internal registry.
- **Б — keep SSR, carry over tokens and flat classes.** Cheaper, works offline, no registry.

Route Б collapsed on inspection of the design system's compiled stylesheet. Its class names are
**hashed CSS modules** — `._vi-icon_10v1h_25`, `._title-h1_10oca_25` — generated per build and
changing between releases. Hand-written markup cannot target them. Route Б could therefore only
ever reuse the *tokens* (the CSS custom properties, whose names are stable) and the fonts, with
every component's appearance re-implemented by hand. That is a look-alike that drifts from the
design system by construction, not a migration to it.

What made route А viable was getting the design system locally: the library and the icon package
arrive as tarballs, its documentation as an offline mirror served by a local MCP server, and the
component index matched the mirror from the production server exactly (52 of 52 components,
`ViButton` byte-identical). Props are therefore read, never guessed — which immediately caught
one: Vision UI inputs expose `value` and bind with `v-model:value`, so a plain `v-model` renders
correctly and silently posts nothing.

## Decision

**Route А.** A new app, `apps/admin-ui`, Vue 3 + Vite on `@vi-frontend/vision-ui`.

```
apps/admin-ui/
├── server.js            static files + floor plans + same-origin /api proxy + /health
├── src/api.js           the only place the app talks to the backend
├── src/store.js         reactive day state; every write reloads the day
├── src/statuses.js      the six place statuses → design-system palette groups
├── src/components/      per-screen pieces, each with a *.spec.js beside it
└── src/pages/           DayPage, RequestsPage, LinesPage, CatalogPage, AuditPage, PlacesPage
```

Rules the app holds to:

- **No parking rule lives in the UI.** Slot statuses come from `/admin/place-lines`, not from a
  local derivation — which also means the drawer and the slot beside it can no longer disagree
  about one place. "Today" is the API's answer in `APP_TIMEZONE`, never the browser clock, since
  the 19:00 and 07:00 rules are evaluated server-side.
- **Colour never carries meaning alone.** Statuses print the word next to the nameplate, and
  selection is `aria-pressed` on a real `<button>`, not a colour.
- **Tokens only.** Colours, radii and spacing are `var(--vi-color-…)`, `var(--vi-radius-…)`,
  `var(--vi-vr-…)`. A hard-coded hex is a defect; a test asserts the status palette is tokens.
  A `--vi-color-*` token is **never** wrapped in `rgb()` — that layer holds hex values, only the
  deprecated `--vi-primary` layer holds triplets, and `rgb(#cfeed7)` makes the browser drop the
  whole declaration. Getting this wrong cost the first build its entire visual layer.
- **Same origin.** The browser talks to `/api/*` on this app's own server, which proxies to the
  API. No CORS — who may call the backend is a backend decision, not a UI convenience.

**The migration ran tab by tab, with both UIs deployed, and is finished.** While it was in
progress `admin-ui` served the tabs it had taken over on port `3360` and said plainly which ones
it had not, while `admin-web` kept serving the rest on `3340`. All six tabs are migrated now, so
the repository's no-compatibility-layer rule has been applied with the migration as its unit:
`apps/admin-web`, its Dockerfile, its compose service, its tests and `packages/shared/html.js`
(whose only consumer it was) are deleted, and `admin-ui` has taken over port `3340` so the
operator's address did not change.

## Consequences

**The build now needs files that are not in git.** `@vi-frontend/vision-ui` and
`@vi-frontend/svgs` come from an internal registry and are placed on the host as tarballs in
`vendor/`, which is gitignored — this repository is **public**, and internal code must not land
in it. Consequences, all of them real:

- the host checkout needs `vendor/*.tgz` present once, the same way `staging/env/app.env` is
  (see SETUP.md);
- CI cannot build or test `apps/admin-ui`: it has no tarballs. `npm run test:ui` and
  `npm run admin-ui:build` are local and stand steps, and `ci.yml` says so where it would
  otherwise look like an omission;
- `package.json` does name the internal packages. The *code* stays private; the *names* are
  public. If that is not acceptable, the repository has to become private — nothing in this ADR
  makes that decision.

**The repo gains a second module system and a test runner.** `apps/admin-ui` is the one ESM
package; eslint learned a separate block for it, and `node --check` already handles it. Component
tests run on vitest + happy-dom (the design system's own choice) and are named `*.spec.js` so
`node --test` does not try to load them as CommonJS. They mount real Vision UI components, which
is what lets them assert the `v-model:value` binding rather than the markup around it.

**The design system is now a build-time dependency of the only admin UI there is.** While the
migration ran, a broken screen had `admin-web` behind it; now it does not. What stands in for
that fallback is the test layer: 108 specs that mount the real components, a smoke check that
proves the served shell carries a built bundle and that the `/api` proxy answers, and a
deployment test that refuses an image missing a module the server imports — the last one added
after exactly that failure reached the stand.

**Nothing about the API changed.** Not one endpoint, not one payload: the golden snapshots are
untouched by this work. That is the property that made a tab-by-tab migration safe at all, and it
has one visible consequence — the API labels an operator's write `actorService: 'admin-web'` in 32
places of its own code, so the audit log still names an application that no longer exists.
Renaming it is an API change with a golden regeneration behind it, to be done deliberately rather
than as a side effect of deleting a UI.
