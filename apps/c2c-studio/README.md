# c2c Transformation Studio

Nuxt/Tailwind frontend application for the c2c Transformation Studio.

## Development

Make sure to install the dependencies:

```bash
npm install
```

Start the development server on `http://localhost:3000`:

```bash
npm run dev
```

## Environment Variables

The application requires the BFF URL to be passed during runtime. Create a `.env` file or provide it via process environment variables:

```bash
NUXT_PUBLIC_C2C_BFF_BASE_URL=http://localhost:8090
```

## Production

Build the application for production:

```bash
npm run build
```

The output will be in `.output/`. You can serve the application using Node:

```bash
node .output/server/index.mjs
```

## Tests

Run the test suite using Vitest:

```bash
npm run test
```
