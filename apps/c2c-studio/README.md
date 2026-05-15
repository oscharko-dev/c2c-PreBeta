# c2c Studio

Next.js App Router, React, TypeScript, and Tailwind frontend for the c2c Transformation Studio.

## Runtime model

Studio browser code talks only to the c2c BFF under `/api/v0/*`.

- Default browser runtime: same-origin relative BFF calls such as `/api/v0/health` and `/api/v0/mode`.
- Local split-server override: set `NEXT_PUBLIC_C2C_BFF_BASE_URL=http://localhost:18089` only when running the Next.js server separately from the BFF.
- Invalid or non-local overrides are treated as blocking configuration errors.

## Development

```bash
npm install
npm run dev
```

When using `npm run dev`, the app runs as a standalone Next.js dev server. Point it at a local BFF with `NEXT_PUBLIC_C2C_BFF_BASE_URL`.

## Product-mode local stack

The repository launcher runs Studio as a separate Next.js process and injects the local BFF URL:

```bash
./scripts/start-c2c-local.sh
```

That flow keeps the browser-visible boundary on the BFF and preserves W0 deterministic startup with model access disabled.

## Production

```bash
npm run build
npm start
```

## Verification

```bash
npm test
npm run build
```
