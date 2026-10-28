import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { BASE_PATH } from './base-path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());

// -------------------------------------------------------------
// VITE DEV SERVER / STATIC ASSETS MOUNT
// -------------------------------------------------------------

async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const indexFile = path.join(distDir, 'index.html');

    // Serve the build under the same subpath Vite baked into the asset URLs.
    // Mounting at '/' while `base` is '/CountUp/' makes every /CountUp/assets/*
    // request miss dist/, fall through to the SPA catch-all, and come back as
    // index.html — the browser then rejects the "module" and shows a blank page.
    const mountPath = BASE_PATH.replace(/\/+$/, '');
    const serveStatic = express.static(distDir, { index: false });

    if (mountPath) {
      app.use(mountPath, serveStatic);
      // Deep links (and the bare mount path without a trailing slash) boot the SPA.
      app.get([mountPath, `${mountPath}/*`], (_req: Request, res: Response) => {
        res.sendFile(indexFile);
      });
      // The server root always reaches the app, whatever base path was built with.
      app.get('/', (_req: Request, res: Response) => {
        res.redirect(302, `${mountPath}/`);
      });
    } else {
      app.use(serveStatic);
      app.get('*', (_req: Request, res: Response) => {
        res.sendFile(indexFile);
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Countup Server] Running on http://0.0.0.0:${PORT}${isProduction ? ` (serving ${BASE_PATH})` : ''}`,
    );
  });
}

void startServer();
