import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

const publicDirectory = resolve('.output/public');
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

function insidePublicDirectory(filePath) {
  return filePath === publicDirectory || filePath.startsWith(`${publicDirectory}${sep}`);
}

async function fileIfPresent(filePath) {
  try {
    return (await stat(filePath)).isFile() ? filePath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFile(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const relativePath = normalize(decodedPath).replace(/^[/\\]+/, '');
  const directFile = resolve(publicDirectory, relativePath);

  if (!insidePublicDirectory(directFile)) return undefined;

  return (
    (await fileIfPresent(directFile)) ??
    (await fileIfPresent(resolve(publicDirectory, `${relativePath}.html`))) ??
    (await fileIfPresent(resolve(publicDirectory, relativePath, 'index.html')))
  );
}

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const filePath = await resolveFile(pathname);

    if (!filePath) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Lighthouse preview ready at http://127.0.0.1:${port}`);
});
