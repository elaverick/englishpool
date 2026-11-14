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

  // A ball skimming the visible mouth must remain on the bed; a ball whose
  // centre crosses the actual throat must fall and be removed from play.
  const pocketPhysics = await page.evaluate(() => {
    const test = window.__POOL_TEST__;
    const corner = test.pockets.find(pocket => pocket.id === 'top-left');
    const side = test.pockets.find(pocket => pocket.id === 'middle-right');

    const nearMiss = test.setBallState('white', [
      corner.x + corner.captureRadius + 0.08, 0.25, corner.z
    ]);
    test.advancePhysics(90);
    const nearMissResult = {
      potted: nearMiss.potted,
      height: nearMiss.body.position.y
    };

    const cornerBall = test.setBallState('white', [corner.x, 0.25, corner.z]);
    test.advancePhysics(120);
    const cornerResult = {
      potted: cornerBall.potted,
      pocket: cornerBall.pocket,
      hidden: !cornerBall.mesh.visible,
      position: [cornerBall.body.position.x, cornerBall.body.position.y, cornerBall.body.position.z],
      velocity: [cornerBall.body.velocity.x, cornerBall.body.velocity.y, cornerBall.body.velocity.z]
    };

    const sideBall = test.setBallState('red', [side.x, 0.25, side.z]);
    test.advancePhysics(120);
    const sideResult = {
      potted: sideBall.potted,
      pocket: sideBall.pocket,
      hidden: !sideBall.mesh.visible,
      position: [sideBall.body.position.x, sideBall.body.position.y, sideBall.body.position.z],
      velocity: [sideBall.body.velocity.x, sideBall.body.velocity.y, sideBall.body.velocity.z]
    };
    return { nearMissResult, cornerResult, sideResult };
  });
  console.log('Pocket physics diagnostics:', JSON.stringify(pocketPhysics));
  assert.equal(pocketPhysics.nearMissResult.potted, false, 'A ball outside the throat was incorrectly captured');
  assert.ok(pocketPhysics.nearMissResult.height > 0.1, 'A near-miss ball fell through the bed');
  assert.equal(pocketPhysics.cornerResult.potted, true, 'A ball in the corner throat was not potted');
  assert.equal(pocketPhysics.cornerResult.pocket, 'top-left', 'Corner ball was assigned to the wrong pocket');
  assert.equal(pocketPhysics.cornerResult.hidden, true, 'Potted corner ball remained visible');
  assert.equal(pocketPhysics.sideResult.potted, true, 'A ball in the side throat was not potted');
  assert.equal(pocketPhysics.sideResult.pocket, 'middle-right', 'Side ball was assigned to the wrong pocket');
  assert.equal(pocketPhysics.sideResult.hidden, true, 'Potted side ball remained visible');

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
