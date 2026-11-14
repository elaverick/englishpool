import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173/';
const outputDir = 'test-results';
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-webgl',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist'
  ]
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1
});
const pageErrors = [];
const consoleErrors = [];

page.on('pageerror', error => pageErrors.push(error.stack || error.message));
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

try {
  const response = await page.goto(baseUrl + '?test=1', { waitUntil: 'networkidle', timeout: 60000 });
  assert(response?.ok(), `Application returned HTTP ${response?.status()}`);

  await page.waitForFunction(
    () => window.__POOL_TEST__?.ready === true &&
      document.documentElement.dataset.appReady === 'true',
    null,
    { timeout: 30000 }
  );
  await page.waitForTimeout(1000);

  const diagnostics = await page.evaluate(() => {
    const test = window.__POOL_TEST__;
    const gl = test.renderer.getContext();
    let meshCount = 0;
    let invalidGeometries = [];
    test.scene.traverse(object => {
      if (!object.isMesh || !object.geometry) return;
      meshCount++;
      const geometry = object.geometry;
      const position = geometry.getAttribute('position');
      if (!position || position.count === 0) {
        invalidGeometries.push(object.name || object.type + ': missing positions');
        return;
      }
      for (let i = 0; i < position.count; i++) {
        if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)) {
          invalidGeometries.push(object.name || object.type + ': non-finite vertex');
          break;
        }
      }
    });
    return {
      canvasCount: document.querySelectorAll('canvas').length,
      canvasWidth: test.renderer.domElement.width,
      canvasHeight: test.renderer.domElement.height,
      webglVersion: gl.getParameter(gl.VERSION),
      renderCalls: test.renderer.info.render.calls,
      meshCount,
      ballCount: test.balls.length,
      pocketCount: test.pockets.length,
      pocketLinerCount: test.scene.children.filter(object => object.name?.startsWith('pocket-liner-')).length,
      pocketRimCount: test.scene.children.filter(object => object.name?.startsWith('pocket-rim-')).length,
      pocketJawMeshCount: test.scene.children.filter(object => object.name?.startsWith('pocket-jaw-')).length,
      pocketJawBodyCount: test.world.bodies.filter(body => body.name?.startsWith('pocket-jaw-')).length,
      pocketMouthRadii: test.pockets.map(pocket => pocket.mouthRadius),
      invalidGeometries
    };
  });

  assert.equal(diagnostics.canvasCount, 1, 'Expected one Three.js canvas');
  assert.ok(diagnostics.canvasWidth > 0 && diagnostics.canvasHeight > 0, 'Canvas has no drawing buffer');
  assert.match(diagnostics.webglVersion, /WebGL/i, 'WebGL context was not created');
  assert.ok(diagnostics.renderCalls > 0, 'Three.js did not issue any render calls');
  assert.ok(diagnostics.meshCount > 0, 'Scene contains no meshes');
  assert.equal(diagnostics.ballCount, 16, 'Expected cue ball plus fifteen object balls');
  assert.equal(diagnostics.pocketCount, 6, 'Expected six pocket definitions');
  assert.equal(diagnostics.pocketLinerCount, 6, 'Expected six recessed pocket liners');
  assert.equal(diagnostics.pocketRimCount, 6, 'Expected six visible pocket rims');
  assert.equal(diagnostics.pocketJawMeshCount, 12, 'Expected two visible jaws per pocket');
  assert.equal(diagnostics.pocketJawBodyCount, 12, 'Expected matching collision bodies for all jaws');
  assert.ok(diagnostics.pocketMouthRadii.every(radius => radius >= 0.8), 'Pocket mouths are unexpectedly narrow');
  assert.deepEqual(diagnostics.invalidGeometries, [], 'Found invalid mesh geometry');

  const test = await page.evaluateHandle(() => window.__POOL_TEST__);
  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([0, 28, 0.01], [0, 0, 0], [0, 0, -1]);
  });
  await page.screenshot({ path: `${outputDir}/overhead.png`, fullPage: true });

  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([-15, 11, 14], [-4.2, 0, -8.8]);
  });
  await page.screenshot({ path: `${outputDir}/corner-pocket.png`, fullPage: true });

  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([-15, 10, 0], [-4.4, 0, 0]);
  });
  await page.screenshot({ path: `${outputDir}/side-pocket.png`, fullPage: true });

  // Exercise every pocket throat after capturing the clean starting-table screenshots.
  const pocketPhysics = await page.evaluate(() => {
    const test = window.__POOL_TEST__;
    const corner = test.pockets.find(pocket => pocket.id === 'top-left');
    const nearMiss = test.setBallState('white', [
      corner.x + corner.captureRadius + 0.08, 0.25, corner.z
    ]);
    test.advancePhysics(90);
    const nearMissResult = {
      potted: nearMiss.potted,
      height: nearMiss.body.position.y
    };

    const scenarios = [
      ['white', 'top-left'],
      ['red', 'middle-right'],
      ['yellow', 'top-right'],
      ['red', 'middle-left'],
      ['yellow', 'bottom-left'],
      ['red', 'bottom-right']
    ];
    const captures = scenarios.map(([type, pocketId]) => {
      const pocket = test.pockets.find(candidate => candidate.id === pocketId);
      const ball = test.setBallState(type, [pocket.x, 0.25, pocket.z]);
      test.advancePhysics(120);
      return {
        expectedPocket: pocketId,
        potted: ball.potted,
        pocket: ball.pocket,
        hidden: !ball.mesh.visible
      };
    });
    return { nearMissResult, captures };
  });
  console.log('Pocket physics diagnostics:', JSON.stringify(pocketPhysics));
  assert.equal(pocketPhysics.nearMissResult.potted, false, 'A ball outside the throat was incorrectly captured');
  assert.ok(pocketPhysics.nearMissResult.height > 0.1, 'A near-miss ball fell through the bed');
  assert.equal(pocketPhysics.captures.length, 6, 'Expected six pocket capture scenarios');
  for (const capture of pocketPhysics.captures) {
    assert.equal(capture.potted, true, `Ball was not potted at ${capture.expectedPocket}`);
    assert.equal(capture.pocket, capture.expectedPocket, `Ball was assigned to the wrong pocket at ${capture.expectedPocket}`);
    assert.equal(capture.hidden, true, `Potted ball remained visible at ${capture.expectedPocket}`);
  }

  assert.deepEqual(pageErrors, [], 'Browser threw JavaScript exceptions');
  assert.deepEqual(consoleErrors, [], 'Browser reported console errors');

  console.log('Browser smoke test passed.');
  console.log(JSON.stringify({ ...diagnostics, pageErrors, consoleErrors }, null, 2));
} catch (error) {
  console.error(error);
  console.error(JSON.stringify({ pageErrors, consoleErrors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
