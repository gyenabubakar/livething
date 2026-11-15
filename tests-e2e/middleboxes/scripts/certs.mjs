// Makes a test CA and a server certificate for livething.test, once. The proxies that read TLS
// (mitmproxy, Squid) make their own CA; the browser in the tests ignores certificate errors, as a
// company machine trusts its proxy's CA.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const certs = fileURLToPath(new URL('../certs', import.meta.url));
mkdirSync(certs, { recursive: true });
if (existsSync(join(certs, 'server.crt'))) process.exit(0);

function openssl(...args) {
  execFileSync('openssl', args, { cwd: certs, stdio: 'ignore' });
}

openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '3650',
  '-subj',
  '/CN=LiveThing test CA',
  '-keyout',
  'ca.key',
  '-out',
  'ca.crt',
);
writeFileSync(
  join(certs, 'server.ext'),
  'subjectAltName=DNS:livething.test,DNS:host.docker.internal,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
);
openssl(
  'req',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-subj',
  '/CN=livething.test',
  '-keyout',
  'server.key',
  '-out',
  'server.csr',
);
openssl(
  'x509',
  '-req',
  '-in',
  'server.csr',
  '-CA',
  'ca.crt',
  '-CAkey',
  'ca.key',
  '-CAcreateserial',
  '-days',
  '3650',
  '-extfile',
  'server.ext',
  '-out',
  'server.crt',
);
console.log(`certificates in ${certs}`);
