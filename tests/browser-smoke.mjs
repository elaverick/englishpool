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
