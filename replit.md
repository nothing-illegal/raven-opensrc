# Fieldnote / Air

A local-first flight media log for authorized drone inspection work. Save flight records and media in the current browser, review GPS capture points, and optionally see nearby public business listings.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/flight-media-log/src/App.tsx` — app routes and user-facing workflows
- `artifacts/flight-media-log/src/lib/local-db.ts` — IndexedDB record and media persistence
- `artifacts/flight-media-log/src/index.css` — app theme and layout
- `artifacts/api-server/` — shared API scaffold; the flight media app does not currently use it

## Architecture decisions

- Flight records and original media stay in the user's browser; backups are explicit exports, not automatic cloud sync.
- Maps use OpenStreetMap tiles and optional public business listings; the app does not identify residents or property owners.
- DJI media is imported from files selected by the user; direct drone connection and universal model support are not claimed.

## Product

The app manages flight notes, photos and videos, editable capture metadata, GPS map markers, and portable backups. Nearby-business lookup is optional and only searches public business categories around a selected capture. It is designed for authorized inspection workflows, not profiling people.

## User preferences

No additional visual or workflow preferences recorded.

## Gotchas

- Browser storage can be cleared and does not move between browsers or devices; export a backup before changing devices.
- Backups include original media and embedded location metadata and may be large.
- Map tiles load online. Nearby-business lookup sends the selected capture coordinates to OpenStreetMap's public Overpass service only when requested.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Run the app with `pnpm --filter @workspace/flight-media-log run dev`
