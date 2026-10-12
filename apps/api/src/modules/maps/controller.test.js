'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { createMapsController } = require('./controller');

function backgroundHandler(onUpdate) {
  const controller = createMapsController({
    services: {
      maps: {
        getMapDiagnostics: async () => ({ maps: [], placeWithoutLine: [], lineCapacityMismatch: [] }),
        updateMapBackground: async (input) => {
          onUpdate?.(input);

          return {
            id: 'map-1',
            code: input.mapCode,
            title: input.mapTitle,
            floor_label: input.floorLabel,
            file_type: input.fileType,
            file_path: input.filePath,
            source_checksum: input.sourceChecksum
          };
        }
      }
    }
  });

  const route = controller.routes.find(
    (candidate) => candidate.method === 'POST' && candidate.path === '/admin/map-backgrounds'
  );

  return (body) =>
    route.handler({
      req: Readable.from([Buffer.from(JSON.stringify(body))]),
      authUser: { id: 'operator-1', login: 'sysadmin' }
    });
}

const validBody = {
  mapCode: 'g3',
  filePath: '/maps/parking-g3-7f3a.webp',
  fileType: 'webp',
  sourceChecksum: 'abc'
};

test('POST /admin/map-backgrounds stores a path inside the map volume', async () => {
  let stored = null;
  const handle = backgroundHandler((input) => {
    stored = input.filePath;
  });

  const result = await handle(validBody);

  assert.equal(result.statusCode, 200);
  assert.equal(stored, '/maps/parking-g3-7f3a.webp');
});

test('POST /admin/map-backgrounds accepts the bare file name the seeds hold', async () => {
  const handle = backgroundHandler();

  const result = await handle({ ...validBody, filePath: 'parking-g3.png', fileType: 'png' });

  assert.equal(result.statusCode, 200);
});

test('POST /admin/map-backgrounds refuses a path that leaves this installation', async () => {
  // The row becomes an image source in every operator's browser, so an admin must not be able
  // to point it at another origin, an internal host, or anywhere outside the map volume.
  const offSitePaths = [
    '//attacker.example/pixel.png',
    'https://attacker.example/pixel.png',
    'http://10.0.0.1/admin',
    '/etc/passwd',
    '/maps/../../etc/passwd',
    '/maps/..',
    '/maps/%2e%2e%2fsecret',
    'javascript:alert(1)'
  ];

  for (const filePath of offSitePaths) {
    const handle = backgroundHandler(() => {
      assert.fail(`stored an off-site path: ${filePath}`);
    });

    const result = await handle({ ...validBody, filePath });

    assert.equal(result.statusCode, 400, filePath);
    assert.match(result.payload.error, /filePath/);
  }
});
