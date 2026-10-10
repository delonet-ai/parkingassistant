'use strict';

// Pins the stand deployment topology. `docker compose config` validates the syntax; these
// assertions pin the parts a syntactically valid file can still get wrong — a dropped storage
// mount, a service that starts before migrations, a stand port that stops matching the docs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repoRoot = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');

// Minimal top-level service extractor — enough for these assertions, and it keeps the test
// dependency-free (the repo has no YAML parser and does not need one at runtime).
function serviceBlocks(text) {
  const servicesSection = text.slice(text.indexOf('\nservices:'));
  const lines = servicesSection.split('\n');
  const blocks = new Map();
  let current = null;

  for (const line of lines) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      blocks.set(current, []);
      continue;
    }
    if (current && /^ {0,1}\S/.test(line)) {
      current = null;
      continue;
    }
    if (current) {
      blocks.get(current).push(line);
    }
  }

  return new Map([...blocks].map(([name, body]) => [name, body.join('\n')]));
}

const services = serviceBlocks(compose);

test('the stack defines exactly the MVP services', () => {
  assert.deepEqual([...services.keys()].sort(), ['admin-ui', 'api', 'jobs', 'migrate', 'postgres']);
});

// The destination of the `COPY` that carries `source`, or null if nothing carries it.
function copyDestination(dockerfile, source) {
  const line = dockerfile
    .split('\n')
    .find((candidate) => candidate.startsWith('COPY ') && candidate.split(/\s+/).includes(source));

  return line ? line.trim().split(/\s+/).at(-1) : null;
}

test('every module the admin-ui server imports is copied into its image, at the same depth', () => {
  // server.js is ESM and loads its imports at startup, so a file left out of the COPY makes
  // the container exit with ERR_MODULE_NOT_FOUND after a build that looked fine. Since the
  // multipart parser moved to packages/shared the imports also climb out of apps/admin-ui,
  // which is why the image mirrors the repository tree instead of flattening into /app: a
  // module copied to a different depth resolves above the image root and fails the same way.
  const wholeDockerfile = fs.readFileSync(path.join(__dirname, 'docker', 'admin-ui.Dockerfile'), 'utf8');
  // Only the runtime stage matters: the build stage copies the same sources elsewhere, to a
  // tree that is thrown away once the bundle is built.
  const runtimeStart = wholeDockerfile.indexOf('AS runtime');
  assert.notEqual(runtimeStart, -1, 'admin-ui.Dockerfile has no runtime stage');
  const dockerfile = wholeDockerfile.slice(runtimeStart);
  const serverDirectory = path.join(repoRoot, 'apps', 'admin-ui');
  const serverSource = fs.readFileSync(path.join(serverDirectory, 'server.js'), 'utf8');
  const relativeImports = [...serverSource.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1]);

  assert.ok(relativeImports.length > 0, 'expected server.js to import at least one local module');

  for (const source of ['apps/admin-ui/server.js', 'apps/admin-ui/package.json']) {
    assert.equal(
      copyDestination(dockerfile, source),
      '/app/apps/admin-ui/',
      `admin-ui.Dockerfile must copy ${source} into /app/apps/admin-ui/`
    );
  }

  // WORKDIR is where `CMD ["node", "server.js"]` resolves from.
  assert.match(dockerfile, /\nWORKDIR \/app\/apps\/admin-ui\n/);

  for (const specifier of relativeImports) {
    const source = path.relative(repoRoot, path.resolve(serverDirectory, specifier));

    assert.ok(
      fs.existsSync(path.join(repoRoot, source)),
      `server.js imports ${specifier}, which does not exist`
    );

    const destination = copyDestination(dockerfile, source);
    const mirrored = `/app/${path.dirname(source)}`;

    assert.ok(destination, `admin-ui.Dockerfile does not copy ${source}, which server.js imports`);
    assert.ok(
      destination === mirrored || destination === `${mirrored}/` || destination === `/app/${source}`,
      `admin-ui.Dockerfile copies ${source} to ${destination}, not to ${mirrored}/ — ` +
        'the image must mirror the repository tree so a relative import still resolves'
    );
  }
});

test('the deploy script waits for containers the stack actually defines', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy', 'stand.sh'), 'utf8');
  const waited = [...script.matchAll(/parkingassistant-([a-z-]+)/g)].map((match) => match[1]);
  const defined = new Set([...services.keys()]);

  assert.ok(waited.length > 0, 'expected the deploy script to wait for at least one container');

  for (const name of new Set(waited)) {
    assert.ok(defined.has(name), `stand.sh waits for ${name}, which docker-compose.yml does not define`);
  }
});

test('bot-adapter is not deployed while the Yandex phase is deferred', () => {
  assert.equal(services.has('bot-adapter'), false);
  assert.equal(compose.includes('parkingassistant-bot-adapter'), false);
});

test('every storage mount from the README is wired to a service', () => {
  const mounts = {
    postgres: '/opt/git/parkingassistant/staging/postgres',
    maps: '/opt/git/parkingassistant/staging/maps',
    imports: '/opt/git/parkingassistant/staging/imports',
    logs: '/opt/git/parkingassistant/staging/logs',
    backups: '/opt/git/parkingassistant/staging/backups'
  };

  for (const [name, hostPath] of Object.entries(mounts)) {
    assert.ok(compose.includes(`${hostPath}:`), `storage mount ${name} (${hostPath}) is missing`);
  }

  assert.ok(services.get('postgres').includes(mounts.postgres));
  assert.ok(services.get('api').includes(mounts.maps));
  assert.ok(services.get('api').includes(mounts.imports));
  assert.ok(services.get('admin-ui').includes(mounts.maps));
  assert.ok(services.get('jobs').includes(mounts.backups));
});

test('no service bind-mounts repo sources — images must be self-contained', () => {
  const sourceMount = /- \.?[./]*(apps|packages|scripts|node_modules)\b.*:/;

  for (const [name, body] of services) {
    assert.doesNotMatch(body, sourceMount, `${name} bind-mounts repo sources instead of baking them into the image`);
  }
});

test('api and jobs wait for migrations to complete', () => {
  for (const name of ['api', 'jobs']) {
    assert.match(
      services.get(name),
      /migrate:\s*\n\s*condition: service_completed_successfully/,
      `${name} does not wait for the migrate step`
    );
  }
});

test('migrate is a one-shot step that runs db:migrate', () => {
  const migrate = services.get('migrate');

  assert.match(migrate, /restart: "no"/);
  assert.match(migrate, /command: \["npm", "run", "db:migrate"\]/);
  assert.match(migrate, /postgres:\s*\n\s*condition: service_healthy/);
});

test('published ports match the documented stand ports', () => {
  assert.match(services.get('api'), /\$\{API_PORT:-3330\}:3000/);
  assert.match(services.get('admin-ui'), /\$\{ADMIN_UI_PORT:-3340\}:3100/);
});

test('api and admin-ui expose a container healthcheck', () => {
  assert.match(services.get('api'), /healthcheck:[\s\S]*127\.0\.0\.1:3000\/health/);
  assert.match(services.get('admin-ui'), /healthcheck:[\s\S]*127\.0\.0\.1:3100\/health/);
});

test('every service builds from a Dockerfile that exists', () => {
  const dockerfiles = [...compose.matchAll(/dockerfile: (\S+)/g)].map((match) => match[1]);

  assert.ok(dockerfiles.length >= 4);
  for (const dockerfile of new Set(dockerfiles)) {
    assert.ok(fs.existsSync(path.join(repoRoot, dockerfile)), `${dockerfile} is referenced but missing`);
  }
  assert.ok(dockerfiles.includes('infra/docker/jobs.Dockerfile'));
});

test('runtime images install dependencies reproducibly from the lockfile', () => {
  for (const name of ['app', 'jobs']) {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'infra/docker', `${name}.Dockerfile`), 'utf8');
    assert.match(dockerfile, /COPY package\.json package-lock\.json/);
    assert.match(dockerfile, /npm ci --omit=dev/);
  }
});

test('no runtime image is left on a placeholder command', () => {
  for (const name of ['app', 'admin-ui', 'jobs']) {
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'infra/docker', `${name}.Dockerfile`), 'utf8');
    assert.equal(dockerfile.includes('sleep infinity'), false, `${name}.Dockerfile still has a placeholder CMD`);
  }
});
