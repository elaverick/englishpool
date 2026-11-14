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
      pocketFloorCount: test.scene.children.filter(object => object.name?.startsWith('pocket-floor-')).length,
      pocketLinerCount: test.scene.children.filter(object => object.name?.startsWith('pocket-liner-')).length,
      pocketRimCount: test.scene.children.filter(object => object.name?.startsWith('pocket-rim-')).length,
      pocketJawMeshCount: test.scene.children.filter(object => object.name?.startsWith('pocket-jaw-')).length,
      pocketJawBodyCount: test.world.bodies.filter(body => body.name?.startsWith('pocket-jaw-')).length,
      pocketMouthRadii: test.pockets.map(pocket => pocket.mouthRadius),
      ballLinearDamping: test.balls[0].body.linearDamping,
      ballAngularDamping: test.balls[0].body.angularDamping,
      fixedTimeStep: test.fixedTimeStep,
      cushionBedOverlap: test.cushionBedOverlap,
      cushionRailCount: test.scene.children.filter(object => object.name?.startsWith('cushion-rail-')).length,
      woodenFrameCount: test.scene.children.filter(object => object.name === 'wooden-frame-perimeter').length,
      woodenApronCount: test.scene.children.filter(object => object.name === 'wooden-apron-perimeter').length,
      woodenCornerSupportCount: test.scene.children.filter(object => object.name?.startsWith('wooden-corner-support-')).length,
      woodenFrameInnerBounds: test.woodenFrameInnerBounds,
      oldSegmentedWoodRailCount: test.scene.children.filter(object => object.name?.startsWith('visual-rail-')).length,
      woodenFrameBounds: (() => {
        const frame = test.scene.children.find(object => object.name === 'wooden-frame-perimeter');
        if (!frame) return null;
        const bounds = frame.geometry.boundingBox;
        return {
          min: [bounds.min.x, bounds.min.y, bounds.min.z],
          max: [bounds.max.x, bounds.max.y, bounds.max.z],
          positionY: frame.position.y
        };
      })(),
      woodenApronBounds: (() => {
        const apron = test.scene.children.find(object => object.name === 'wooden-apron-perimeter');
        if (!apron) return null;
        const bounds = apron.geometry.boundingBox;
        return {
          min: [bounds.min.x, bounds.min.y, bounds.min.z],
          max: [bounds.max.x, bounds.max.y, bounds.max.z],
          positionY: apron.position.y
        };
      })(),
      woodenApronInnerBounds: test.woodenApronInnerBounds,
      worldSleepEnabled: test.world.allowSleep,
      contactMaterials: test.world.contactmaterials.map(contact => ({
        pair: contact.materials.map(material => material.name).sort().join(':'),
        friction: contact.friction,
        restitution: contact.restitution
      })),
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
  assert.equal(diagnostics.pocketFloorCount, 6, 'Expected six recessed pocket wells');
  assert.equal(diagnostics.pocketLinerCount, 0, 'Pocket wells should not use exposed cylindrical liners');
  assert.equal(diagnostics.pocketRimCount, 0, 'Pocket openings should not have decorative raised rings');
  assert.equal(diagnostics.pocketJawMeshCount, 0, 'Pocket transitions should not use separate jaw blocks');
  assert.equal(diagnostics.pocketJawBodyCount, 0, 'Pocket transitions should not use separate jaw collision bodies');
  assert.ok(diagnostics.pocketMouthRadii.every(radius => radius >= 0.6), 'Pocket mouths are unexpectedly narrow');
  assert.equal(diagnostics.ballLinearDamping, 0.5, 'Original linear rolling resistance was changed');
  assert.equal(diagnostics.ballAngularDamping, 0.1, 'Original angular rolling resistance was changed');
  assert.equal(diagnostics.fixedTimeStep, 1 / 60, 'Original physics step duration was changed');
  assert.equal(diagnostics.cushionBedOverlap, 0.18, 'Cushions must overlap the cloth edge to close the rail gap');
  assert.equal(diagnostics.cushionRailCount, 8, 'Expected eight continuous cushion segments');
  assert.equal(diagnostics.woodenFrameCount, 1, 'The top wooden border must be one continuous perimeter');
  assert.equal(diagnostics.woodenApronCount, 1, 'The supporting timber apron must be one continuous perimeter');
  assert.equal(diagnostics.woodenCornerSupportCount, 0, 'Pocket openings must remain clear of separate corner fill blocks');
  assert.equal(diagnostics.oldSegmentedWoodRailCount, 0, 'Separate wooden frame bars can leave open corner joints');
  assert.ok(diagnostics.woodenFrameBounds, 'Missing continuous wooden perimeter geometry');
  assert.ok(diagnostics.woodenApronBounds, 'Missing continuous supporting apron geometry');
  assert.equal(diagnostics.woodenFrameBounds.positionY, 0.42, 'Original top-board height should be retained');
  assert.equal(diagnostics.woodenApronBounds.positionY, 0.012, 'The supporting apron must start at the playing-surface height');
  assert.ok(
    Math.abs(diagnostics.woodenFrameBounds.max[1] + diagnostics.woodenFrameBounds.positionY - 0.74) < 1e-6,
    'Top frame surface height changed unexpectedly'
  );
  assert.ok(
    Math.abs(diagnostics.woodenApronBounds.max[1] + diagnostics.woodenApronBounds.positionY - 0.43) < 1e-6,
    'Supporting apron must join the top frame underneath'
  );
  assert.deepEqual(
    diagnostics.woodenApronInnerBounds,
    { halfWidth: 5, halfLength: 10 },
    'The supporting apron must meet the outer edges of the playing surface'
  );
  assert.equal(diagnostics.worldSleepEnabled, false, 'Automatic world sleeping should remain disabled as in the original prototype');
  const expectedContacts = {
    'ball:ball': [0.1, 0.9],
    'ball:table': [0.4, 0.1],
    'ball:cushion': [0.1, 0.8]
  };
  for (const [pair, [friction, restitution]] of Object.entries(expectedContacts)) {
    const contact = diagnostics.contactMaterials.find(candidate => candidate.pair === pair);
    assert.ok(contact, `Missing ${pair} contact material`);
    assert.equal(contact.friction, friction, `Unexpected ${pair} friction`);
    assert.equal(contact.restitution, restitution, `Unexpected ${pair} restitution`);
  }
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

  // Look back into a corner from outside the cabinet to verify that the
  // timber support fills the pocket-side void beneath the top perimeter.
  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([-7.2, 2.2, -12.8], [-4.9, 0.35, -9.8]);
  });
  await page.screenshot({ path: `${outputDir}/corner-frame-support.png`, fullPage: true });

  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([-15, 10, 0], [-4.4, 0, 0]);
  });
  await page.screenshot({ path: `${outputDir}/side-pocket.png`, fullPage: true });

  // Low end-on view exposes the cushion-to-cloth join and the centre joint
  // between the two halves of each end cushion.
  await page.evaluate(() => {
    window.__POOL_TEST__.setCamera([0, 5.5, 18], [0, 0, -6]);
  });
  await page.screenshot({ path: `${outputDir}/end-rail-profile.png`, fullPage: true });

  // Shot availability follows the cue ball only. Object balls may still be
  // rolling after the cue ball has stopped, and must not lock out the next shot.
  const movementState = await page.evaluate(() => {
    const test = window.__POOL_TEST__;
    const cue = test.setBallState('white', [0, 0.25, 5], [0, 0, 0]);
    const objectBall = test.setBallState('red', [1, 0.25, 5], [2, 0, 0]);
    const cueStopped = test.refreshMovementState();
    const canShootWhileObjectBallRolls = test.canShoot;

    cue.body.velocity.set(0, 0, -0.2);
    const cueMoving = test.refreshMovementState();

    cue.body.velocity.set(0, 0, 0);
    objectBall.body.velocity.set(0, 0, 0);
    test.refreshMovementState();
    return { cueStopped, canShootWhileObjectBallRolls, cueMoving };
  });
  assert.equal(movementState.cueStopped, false, 'Stationary cue ball was marked as moving');
  assert.equal(movementState.canShootWhileObjectBallRolls, true, 'Moving object balls incorrectly prevent the next shot');
  assert.equal(movementState.cueMoving, true, 'Moving cue ball did not lock shot input');

  // Exercise every pocket throat after capturing the clean starting-table screenshots.
  const pocketPhysics = await page.evaluate(() => {
    const test = window.__POOL_TEST__;
    const corner = test.pockets.find(pocket => pocket.id === 'top-left');
    const nearMiss = test.setBallState('white', [
      corner.x + corner.captureRadius + 0.35, 0.25, corner.z
    ]);
    test.advancePhysics(90);
    const nearMissResult = {
      potted: nearMiss.potted,
      height: nearMiss.body.position.y
    };

    const scenarios = [
      ['red', 'top-left'],
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
