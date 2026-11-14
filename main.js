import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import * as CANNON from 'https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js';

const BALL_RADIUS = 0.25;
const TABLE_WIDTH = 10;
const TABLE_LENGTH = 20;
const HALF_WIDTH = TABLE_WIDTH / 2;
const HALF_LENGTH = TABLE_LENGTH / 2;
const MAX_POWER = 12;
const MAX_SPIN_RADIUS = BALL_RADIUS * 0.75;
const FIXED_TIME_STEP = 1 / 120;
const MAX_FRAME_DELTA = 0.05;
const POCKET_CAPTURE_RADIUS = 0.67;
const POCKET_DROP_DEPTH = 0.9;
const CUSHION_HEIGHT = 0.68;
const CUSHION_THICKNESS = 0.72;

let scene, camera, renderer, world, audioCtx;
let balls = [];
let whiteBallBody;
let mainLine, cueDeflectionLine, objectBallLine, ghostBall, strikeDot;
let isMoving = false;
let cameraAngle = 0;
let cameraPitch = 0.6;
let cameraDistance = 12;
let spinX = 0;
let spinY = 0;
let isAiming = false;
let isCharging = false;
let startDragY = 0;
let chargePower = 0;
let accumulator = 0;
let lastFrameTime = 0;
let pockets = [];
let testCameraPose = null;

const powerBarContainer = document.getElementById('power-bar-container');
const powerBar = document.getElementById('power-bar');

init();
requestAnimationFrame(animate);

function init() {
    setupThreeJS();
    setupLights();
    world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0),
        allowSleep: true
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 12;
    world.solver.tolerance = 0.001;

    const materials = setupPhysicsMaterials();
    buildTable(materials);
    buildBalls(materials.ballMat);
    setupTrajectoryVisuals();
    setupStrikeDot();
    setupInput();
    window.addEventListener('pointerdown', resumeAudio, { once: true });
    if (new URLSearchParams(window.location.search).has('test')) {
        window.__POOL_TEST__ = {
            ready: true,
            scene,
            camera,
            renderer,
            world,
            get balls() { return balls; },
            get pockets() { return pockets; },
            setBallState(type, position, velocity = [0, 0, 0]) {
                const ball = balls.find(candidate => candidate.type === type && !candidate.potted);
                if (!ball) throw new Error(`No active ${type} ball available`);
                ball.body.position.set(...position);
                ball.body.velocity.set(...velocity);
                ball.body.angularVelocity.set(0, 0, 0);
                ball.body.wakeUp();
                ball.mesh.position.copy(ball.body.position);
                return ball;
            },
            advancePhysics(steps = 120) {
                for (let i = 0; i < steps; i++) {
                    world.step(FIXED_TIME_STEP);
                    updatePocketing();
                }
                for (const ball of balls) {
                    if (!ball.potted) ball.mesh.position.copy(ball.body.position);
                }
            },
            setCamera(position, target, up = [0, 1, 0]) {
                testCameraPose = {
                    position: new THREE.Vector3(...position),
                    target: new THREE.Vector3(...target),
                    up: new THREE.Vector3(...up)
                };
                camera.position.copy(testCameraPose.position);
                camera.up.copy(testCameraPose.up);
                camera.lookAt(testCameraPose.target);
                renderer.render(scene, camera);
            }
        };
        document.documentElement.dataset.appReady = 'true';
    }
}

function setupThreeJS() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111315);
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
}

function setupLights() {
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x26301f, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-5, 14, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -13;
    key.shadow.camera.right = 13;
    key.shadow.camera.top = 23;
    key.shadow.camera.bottom = -23;
    scene.add(key);
    const fill = new THREE.PointLight(0xffd8a0, 35, 35);
    fill.position.set(5, 8, -4);
    scene.add(fill);
}

function resumeAudio() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function setupPhysicsMaterials() {
    const ballMat = new CANNON.Material('ball');
    const tableMat = new CANNON.Material('table');
    const cushionMat = new CANNON.Material('cushion');
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, ballMat, {
        friction: 0.08, restitution: 0.92
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, tableMat, {
        friction: 0.38, restitution: 0.05
    }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, cushionMat, {
        friction: 0.12, restitution: 0.78
    }));
    return { ballMat, tableMat, cushionMat };
}

function createBaizeMaterial(size = 512, repeat = 4) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#07501f';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5000; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const length = 1 + Math.random() * 3;
        const alpha = 0.025 + Math.random() * 0.075;
        ctx.strokeStyle = 'rgba(150,210,150,' + alpha + ')';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + length, y + (Math.random() - 0.5) * 0.7);
        ctx.stroke();
    }
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeat, repeat);
    map.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return new THREE.MeshStandardMaterial({ map, roughness: 0.92, metalness: 0 });
}

function buildTable(mats) {
    const wood = new THREE.MeshStandardMaterial({ color: 0x392316, roughness: 0.34 });
    const cushionVisual = new THREE.MeshStandardMaterial({ color: 0x24402d, roughness: 0.72 });
    const black = new THREE.MeshStandardMaterial({ color: 0x050606, roughness: 0.98 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb18a4b, metalness: 0.65, roughness: 0.3 });

    const cabinet = new THREE.Mesh(
        new THREE.BoxGeometry(TABLE_WIDTH + 2, 0.8, TABLE_LENGTH + 2), wood
    );
    cabinet.position.y = -0.48;
    cabinet.castShadow = cabinet.receiveShadow = true;
    scene.add(cabinet);

    buildPlayingSurface(createBaizeMaterial(), mats.tableMat);
    createPockets(black);

    const sideIntervals = [[-9.15, -0.85], [0.85, 9.15]];
    for (const sx of [-1, 1]) {
        for (const interval of sideIntervals) {
            addRailSegment(
                sx * (HALF_WIDTH + 0.34), (interval[0] + interval[1]) / 2,
                CUSHION_THICKNESS, interval[1] - interval[0], 0,
                cushionVisual, mats.cushionMat
            );
        }
    }
    for (const sz of [-1, 1]) {
        for (const sx of [-1, 1]) {
            addRailSegment(sx * 1.9, sz * (HALF_LENGTH + 0.34), 3.8, CUSHION_THICKNESS,
                0, cushionVisual, mats.cushionMat);
        }
    }
    buildPocketJaws(cushionVisual, mats.cushionMat);

    addVisualRail(0, -HALF_LENGTH - 0.77, TABLE_WIDTH + 1.55, 0.46, wood);
    addVisualRail(0, HALF_LENGTH + 0.77, TABLE_WIDTH + 1.55, 0.46, wood);
    addVisualRail(-HALF_WIDTH - 0.77, 0, 0.46, TABLE_LENGTH + 1.55, wood);
    addVisualRail(HALF_WIDTH + 0.77, 0, 0.46, TABLE_LENGTH + 1.55, wood);

    for (const x of [-3.2, -1.6, 0, 1.6, 3.2]) {
        addSight(x, -HALF_LENGTH - 0.77, brass);
        addSight(x, HALF_LENGTH + 0.77, brass);
    }
    for (const z of [-8, -6, -4, -2, 2, 4, 6, 8]) {
        addSight(-HALF_WIDTH - 0.77, z, brass);
        addSight(HALF_WIDTH + 0.77, z, brass);
    }

    const marking = new THREE.MeshBasicMaterial({ color: 0xe7e1c8 });
    const baulkZ = HALF_LENGTH * 0.5;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TABLE_WIDTH, 0.025), marking);
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.022, baulkZ);
    scene.add(line);

    const curve = new THREE.EllipseCurve(0, baulkZ, 1, 1, 0, Math.PI, false, 0);
    const dPoints = curve.getPoints(48).map(p => new THREE.Vector3(p.x, 0.023, p.y));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(dPoints),
        new THREE.LineBasicMaterial({ color: 0xe7e1c8 })));
    addTableSpot(0, -HALF_LENGTH * 0.25, marking);
    addTableSpot(0, 0, marking);
    addTableSpot(0, HALF_LENGTH * 0.25, marking);
}

function buildPlayingSurface(material, tableMat) {
    // A single continuous outline forms six open notches in the table edge.
    // Shape coordinates use (x, -z), then rotate onto the XZ playing plane.
    const shape = new THREE.Shape();
    shape.moveTo(-3.75, 10.0);
    shape.quadraticCurveTo(-5.0, 10.0, -5.0, 8.75);
    shape.lineTo(-5.0, 0.82);
    shape.quadraticCurveTo(-3.3, 0.0, -5.0, -0.85);
    shape.lineTo(-5.0, -8.75);
    shape.quadraticCurveTo(-5.0, -10.0, -3.75, -10.0);
    shape.lineTo(3.75, -10.0);
    shape.quadraticCurveTo(5.0, -10.0, 5.0, -8.75);
    shape.lineTo(5.0, -0.82);
    shape.quadraticCurveTo(3.3, 0.0, 5.0, 0.85);
    shape.lineTo(5.0, 8.75);
    shape.quadraticCurveTo(5.0, 10.0, 3.75, 10.0);
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape, 24);
    geometry.rotateX(-Math.PI / 2);
    const cloth = new THREE.Mesh(geometry, material);
    cloth.position.y = 0.012;
    cloth.receiveShadow = true;
    scene.add(cloth);

    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    const body = new CANNON.Body({ mass: 0, material: tableMat });
    body.addShape(new CANNON.Trimesh(Array.from(positions), Array.from(indices)));
    body.position.set(0, 0.012, 0);
    world.addBody(body);
}

function createPockets(black) {
    pockets = [
        { id: 'top-left', type: 'corner', x: -4.55, z: -9.55, mouthRadius: 0.88, captureRadius: 0.61 },
        { id: 'top-right', type: 'corner', x: 4.55, z: -9.55, mouthRadius: 0.88, captureRadius: 0.61 },
        { id: 'middle-left', type: 'side', x: -4.15, z: 0, mouthRadius: 0.85, captureRadius: 0.59 },
        { id: 'middle-right', type: 'side', x: 4.15, z: 0, mouthRadius: 0.85, captureRadius: 0.59 },
        { id: 'bottom-left', type: 'corner', x: -4.55, z: 9.55, mouthRadius: 0.88, captureRadius: 0.61 },
        { id: 'bottom-right', type: 'corner', x: 4.55, z: 9.55, mouthRadius: 0.88, captureRadius: 0.61 }
    ];

    const linerMaterial = new THREE.MeshStandardMaterial({
        color: 0x080909, roughness: 0.96, metalness: 0.02,
        side: THREE.DoubleSide
    });
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0x171a17, roughness: 0.88, metalness: 0.02
    });

    for (const pocket of pockets) {
        const floor = new THREE.Mesh(new THREE.CircleGeometry(0.62, 48), black);
        floor.name = `pocket-floor-${pocket.id}`;
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(pocket.x, -0.62, pocket.z);
        scene.add(floor);

        const liner = new THREE.Mesh(
            new THREE.CylinderGeometry(0.78, 0.43, 0.62, 48, 1, true),
            linerMaterial
        );
        liner.name = `pocket-liner-${pocket.id}`;
        liner.position.set(pocket.x, -0.29, pocket.z);
        liner.castShadow = true;
        liner.receiveShadow = true;
        scene.add(liner);

        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.045, 8, 48), rimMaterial);
        rim.name = `pocket-rim-${pocket.id}`;
        rim.rotation.x = Math.PI / 2;
        rim.position.set(pocket.x, 0.018, pocket.z);
        rim.castShadow = true;
        scene.add(rim);
    }
}

function buildPocketJaws(material, physicsMaterial) {
    // Each jaw is a tapered, plan-view wedge rather than a blunt rectangular
    // block. The same extruded geometry supplies both the render mesh and the
    // static collision mesh, keeping the cushion nose and physics aligned.
    const height = CUSHION_HEIGHT;
    const bevel = 0.035;

    function addWedge(name, points) {
        const shape = new THREE.Shape();
        shape.moveTo(points[0][0], -points[0][1]);
        for (let i = 1; i < points.length; i++) {
            shape.lineTo(points[i][0], -points[i][1]);
        }
        shape.closePath();

        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: height,
            steps: 1,
            bevelEnabled: true,
            bevelSegments: 2,
            bevelSize: bevel,
            bevelThickness: bevel,
            curveSegments: 2
        });
        geometry.rotateX(-Math.PI / 2);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `pocket-jaw-${name}`;
        mesh.castShadow = mesh.receiveShadow = true;
        scene.add(mesh);

        const positions = geometry.attributes.position;
        const vertices = Array.from(positions.array);
        const indices = geometry.index
            ? Array.from(geometry.index.array)
            : Array.from({ length: positions.count }, (_, i) => i);
        const body = new CANNON.Body({ mass: 0, material: physicsMaterial });
        body.name = mesh.name;
        body.addShape(new CANNON.Trimesh(vertices, indices));
        world.addBody(body);
    }

    // Corner jaws continue the side and end cushions into a diagonal nose.
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            addWedge(`corner-${sx}-${sz}-side`, [
                [sx * 4.98, sz * 8.88],
                [sx * 5.12, sz * 8.88],
                [sx * 4.58, sz * 9.42],
                [sx * 4.40, sz * 9.25]
            ]);
            addWedge(`corner-${sx}-${sz}-end`, [
                [sx * 3.88, sz * 9.98],
                [sx * 4.02, sz * 9.98],
                [sx * 4.58, sz * 9.42],
                [sx * 4.40, sz * 9.25]
            ]);
        }
    }

    // Side-pocket jaws taper from the cushion ends towards the pocket throat.
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            addWedge(`side-${sx}-${sz}`, [
                [sx * 4.98, sz * 0.82],
                [sx * 5.12, sz * 0.82],
                [sx * 4.36, sz * 0.40],
                [sx * 4.16, sz * 0.48]
            ]);
        }
    }
}

function addRailSegment(x, z, width, length, angle, material, physicsMaterial) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, CUSHION_HEIGHT, length), material);
    mesh.position.set(x, CUSHION_HEIGHT / 2, z);
    mesh.rotation.y = angle;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    const body = new CANNON.Body({ mass: 0, material: physicsMaterial });
    body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, CUSHION_HEIGHT / 2, length / 2)));
    body.position.set(x, CUSHION_HEIGHT / 2, z);
    body.quaternion.setFromEuler(0, angle, 0);
    world.addBody(body);
}


function addVisualRail(x, z, width, length, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.32, length), material);
    mesh.position.set(x, 0.58, z);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
}

function addSight(x, z, material) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), material);
    mesh.position.set(x, 0.75, z);
    mesh.scale.y = 0.45;
    scene.add(mesh);
}

function addTableSpot(x, z, material) {
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), material);
    spot.rotation.x = -Math.PI / 2;
    spot.position.set(x, 0.024, z);
    scene.add(spot);
}

function buildBalls(ballPhysMat) {
    const geometry = new THREE.SphereGeometry(BALL_RADIUS, 32, 24);
    const colours = { red: 0xc5222b, yellow: 0xf2c32e, black: 0x111111, white: 0xf4f1e8 };
    function createBall(type, x, z) {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
            color: colours[type], roughness: 0.2, metalness: 0.02
        }));
        mesh.castShadow = true;
        scene.add(mesh);
        const body = new CANNON.Body({
            mass: 0.17,
            shape: new CANNON.Sphere(BALL_RADIUS),
            position: new CANNON.Vec3(x, BALL_RADIUS, z),
            material: ballPhysMat,
            linearDamping: 0.12,
            angularDamping: 0.04,
            allowSleep: true,
            sleepSpeedLimit: 0.08,
            sleepTimeLimit: 0.5
        });
        world.addBody(body);
        body.addEventListener('collide', event => {
            const impact = Math.abs(event.contact.getImpactVelocityAlongNormal());
            playImpactSound(impact, body.position);
        });
        const ball = { type, mesh, body, potted: false };
        balls.push(ball);
        return body;
    }

    whiteBallBody = createBall('white', 0, TABLE_LENGTH * 0.25);
    const pattern = [
        ['red'],
        ['yellow', 'red'],
        ['red', 'black', 'yellow'],
        ['yellow', 'red', 'yellow', 'red'],
        ['red', 'yellow', 'red', 'yellow', 'yellow']
    ];
    const spacing = BALL_RADIUS * 2.01;
    const startZ = -TABLE_LENGTH * 0.25;
    for (let row = 0; row < pattern.length; row++) {
        const rowZ = startZ - row * spacing * Math.sqrt(3) / 2;
        const startX = -(row * spacing) / 2;
        for (let col = 0; col < pattern[row].length; col++) {
            createBall(pattern[row][col], startX + col * spacing, rowZ);
        }
    }
}

function playImpactSound(strength, position) {
    if (!audioCtx || strength < 0.03) return;
    const now = audioCtx.currentTime;
    const duration = Math.min(0.18, 0.045 + strength * 0.025);
    const master = audioCtx.createGain();
    master.gain.setValueAtTime(Math.min(0.25, 0.035 + strength * 0.035), now);
    master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    master.connect(audioCtx.destination);
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(650 + Math.min(strength, 10) * 95, now);
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(now);
    oscillator.stop(now + duration);
}

function setupTrajectoryVisuals() {
    const lineMaterial = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.2, gapSize: 0.1 });
    const objectMaterial = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 0.2, gapSize: 0.1 });
    mainLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
    cueDeflectionLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial);
    objectBallLine = new THREE.Line(new THREE.BufferGeometry(), objectMaterial);
    ghostBall = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
        new THREE.MeshStandardMaterial({
            color: 0xffffff, transparent: true, opacity: 0.25,
            roughness: 0.2, depthWrite: false
        }));
    scene.add(mainLine, cueDeflectionLine, objectBallLine, ghostBall);
}

function setupStrikeDot() {
    strikeDot = new THREE.Mesh(new THREE.SphereGeometry(0.015, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x8d0000, depthTest: false }));
    strikeDot.renderOrder = 999;
    scene.add(strikeDot);
}

function setupInput() {
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onMouseWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
}

function onMouseDown(event) {
    if (event.button === 2) isAiming = true;
    else if (event.button === 0 && !isMoving && whiteBallBody) {
        isCharging = true;
        startDragY = event.clientY;
        chargePower = 0;
        powerBarContainer.style.display = 'block';
    }
}

function onMouseMove(event) {
    if (isAiming) {
        cameraAngle -= event.movementX * 0.005;
        cameraPitch = THREE.MathUtils.clamp(cameraPitch + event.movementY * 0.005, 0.12, 1.42);
    }
    if (isCharging) {
        const dragDistance = Math.max(0, event.clientY - startDragY);
        chargePower = Math.min(dragDistance * 0.05, MAX_POWER);
        powerBar.style.width = String((chargePower / MAX_POWER) * 100) + '%';
    }
}

function onMouseUp(event) {
    if (event.button === 2) {
        isAiming = false;
        return;
    }
    if (event.button !== 0 || !isCharging) return;
    isCharging = false;
    powerBarContainer.style.display = 'none';
    powerBar.style.width = '0%';
    if (chargePower > 0.5 && whiteBallBody) {
        resumeAudio();
        const forceX = -Math.sin(cameraAngle) * chargePower;
        const forceZ = -Math.cos(cameraAngle) * chargePower;
        const localZ = Math.sqrt(Math.max(0, BALL_RADIUS ** 2 - spinX ** 2 - spinY ** 2));
        const contactOffset = new CANNON.Vec3(
            spinX * Math.cos(cameraAngle) + localZ * Math.sin(cameraAngle),
            spinY,
            -spinX * Math.sin(cameraAngle) + localZ * Math.cos(cameraAngle)
        );
        whiteBallBody.applyImpulse(new CANNON.Vec3(forceX, 0, forceZ), contactOffset);
        whiteBallBody.wakeUp();
        spinX = 0;
        spinY = 0;
    }
    chargePower = 0;
}

function onMouseWheel(event) {
    event.preventDefault();
    cameraDistance = THREE.MathUtils.clamp(cameraDistance + event.deltaY * 0.005, 3, 25);
}

function onKeyDown(event) {
    if (isMoving) return;
    const key = event.key.toLowerCase();
    const spinSpeed = 0.01;
    if (key === 'arrowup' || key === 'w') spinY += spinSpeed;
    if (key === 'arrowdown' || key === 's') spinY -= spinSpeed;
    if (key === 'arrowleft' || key === 'a') spinX -= spinSpeed;
    if (key === 'arrowright' || key === 'd') spinX += spinSpeed;
    const radius = Math.hypot(spinX, spinY);
    if (radius > MAX_SPIN_RADIUS) {
        spinX = spinX / radius * MAX_SPIN_RADIUS;
        spinY = spinY / radius * MAX_SPIN_RADIUS;
    }
}

function updatePocketing() {
    for (const ball of balls) {
        if (ball.potted) continue;
        const p = ball.body.position;
        // Capture is based on the usable throat, not the decorative outer
        // mouth. The ball must enter far enough for its centre to clear the
        // cushion noses; merely grazing the mouth no longer creates suction.
        const pocket = pockets.find(candidate =>
            Math.hypot(p.x - candidate.x, p.z - candidate.z) < candidate.captureRadius
        );
        if (!pocket) continue;

        // Once the centre crosses the throat, remove the bed support and let
        // gravity carry the ball below the cabinet. Damping prevents a fast
        // ball from skating across the liner while it falls.
        ball.body.velocity.x *= 0.88;
        ball.body.velocity.z *= 0.88;
        if (ball.body.position.y > -POCKET_DROP_DEPTH) {
            ball.body.velocity.y = Math.min(ball.body.velocity.y, -1.2);
        }
        if (ball.body.position.y < BALL_RADIUS - POCKET_DROP_DEPTH) {
            ball.potted = true;
            ball.pocket = pocket.id;
            ball.mesh.visible = false;
            world.removeBody(ball.body);
            if (ball.body === whiteBallBody) whiteBallBody = null;
        }
    }
}

function updateMovementState() {
    isMoving = balls.some(ball => {
        if (ball.potted) return false;
        const body = ball.body;
        return body.sleepState !== CANNON.Body.SLEEPING &&
            (body.velocity.lengthSquared() > 0.0004 || body.angularVelocity.lengthSquared() > 0.0025);
    });
}

function updateTrajectory() {
    if (!whiteBallBody || isMoving) {
        ghostBall.visible = mainLine.visible = cueDeflectionLine.visible = objectBallLine.visible = false;
        return;
    }
    ghostBall.visible = mainLine.visible = true;
    const start = whiteBallBody.position;
    const direction = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle)).normalize();
    let minDistance = Infinity;
    let hitType = 'none';
    let hitObjectPosition = null;
    let hitNormal = new THREE.Vector3();

    for (const ball of balls) {
        if (ball.potted || ball.body === whiteBallBody) continue;
        const p = ball.body.position;
        const offset = new THREE.Vector3(p.x - start.x, 0, p.z - start.z);
        const projection = offset.dot(direction);
        if (projection < 0) continue;
        const perpendicularSq = offset.lengthSq() - projection * projection;
        const combinedRadius = BALL_RADIUS * 2;
        if (perpendicularSq > combinedRadius * combinedRadius) continue;
        const distance = projection - Math.sqrt(combinedRadius * combinedRadius - perpendicularSq);
        if (distance > 0 && distance < minDistance) {
            minDistance = distance;
            hitType = 'ball';
            hitObjectPosition = new THREE.Vector3(p.x, p.y, p.z);
        }
    }

    // Cushion limits are offset by the ball radius. Pocket openings are
    // deliberately not predicted as cushions in this prototype.
    const xLimit = HALF_WIDTH - BALL_RADIUS;
    const zLimit = HALF_LENGTH - BALL_RADIUS;
    if (direction.x < 0) {
        const t = (-xLimit - start.x) / direction.x;
        if (t > 0 && t < minDistance) { minDistance = t; hitType = 'cushion'; hitNormal.set(1, 0, 0); }
    } else if (direction.x > 0) {
        const t = (xLimit - start.x) / direction.x;
        if (t > 0 && t < minDistance) { minDistance = t; hitType = 'cushion'; hitNormal.set(-1, 0, 0); }
    }
    if (direction.z < 0) {
        const t = (-zLimit - start.z) / direction.z;
        if (t > 0 && t < minDistance) { minDistance = t; hitType = 'cushion'; hitNormal.set(0, 0, 1); }
    } else if (direction.z > 0) {
        const t = (zLimit - start.z) / direction.z;
        if (t > 0 && t < minDistance) { minDistance = t; hitType = 'cushion'; hitNormal.set(0, 0, -1); }
    }

    if (!Number.isFinite(minDistance)) {
        ghostBall.visible = mainLine.visible = false;
        return;
    }
    const startVector = new THREE.Vector3(start.x, start.y, start.z);
    const impactPosition = startVector.clone().add(direction.clone().multiplyScalar(minDistance));
    ghostBall.position.copy(impactPosition);
    mainLine.geometry.setFromPoints([startVector, impactPosition]);
    mainLine.computeLineDistances();

    if (hitType === 'ball') {
        cueDeflectionLine.visible = objectBallLine.visible = true;
        const objectDirection = hitObjectPosition.clone().sub(impactPosition).normalize();
        objectBallLine.geometry.setFromPoints([
            hitObjectPosition, hitObjectPosition.clone().add(objectDirection.multiplyScalar(4))
        ]);
        objectBallLine.computeLineDistances();
        const normal = hitObjectPosition.clone().sub(impactPosition).normalize();
        let cueDirection = direction.clone().sub(normal.clone().multiplyScalar(direction.dot(normal))).normalize();
        if (cueDirection.lengthSq() < 0.01) cueDirection = direction.clone();
        cueDeflectionLine.geometry.setFromPoints([
            impactPosition, impactPosition.clone().add(cueDirection.multiplyScalar(2))
        ]);
        cueDeflectionLine.computeLineDistances();
    } else if (hitType === 'cushion') {
        cueDeflectionLine.visible = true;
        objectBallLine.visible = false;
        const reflected = direction.clone().sub(hitNormal.clone().multiplyScalar(2 * direction.dot(hitNormal))).normalize();
        cueDeflectionLine.geometry.setFromPoints([
            impactPosition, impactPosition.clone().add(reflected.multiplyScalar(4))
        ]);
        cueDeflectionLine.computeLineDistances();
    } else {
        cueDeflectionLine.visible = objectBallLine.visible = false;
    }
}

function updateCamera() {
    if (testCameraPose) {
        camera.position.copy(testCameraPose.position);
        camera.up.copy(testCameraPose.up);
        camera.lookAt(testCameraPose.target);
        return;
    }
    if (!whiteBallBody) return;
    camera.position.set(
        whiteBallBody.position.x + Math.sin(cameraAngle) * Math.cos(cameraPitch) * cameraDistance,
        whiteBallBody.position.y + Math.sin(cameraPitch) * cameraDistance,
        whiteBallBody.position.z + Math.cos(cameraAngle) * Math.cos(cameraPitch) * cameraDistance
    );
    camera.lookAt(whiteBallBody.position.x, whiteBallBody.position.y, whiteBallBody.position.z);
    if (!isMoving) {
        const localZ = Math.sqrt(Math.max(0, BALL_RADIUS ** 2 - spinX ** 2 - spinY ** 2));
        strikeDot.visible = true;
        strikeDot.position.set(
            whiteBallBody.position.x + spinX * Math.cos(cameraAngle) + localZ * Math.sin(cameraAngle),
            whiteBallBody.position.y + spinY,
            whiteBallBody.position.z - spinX * Math.sin(cameraAngle) + localZ * Math.cos(cameraAngle)
        );
    } else {
        strikeDot.visible = false;
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

function animate(timestamp = 0) {
    requestAnimationFrame(animate);
    const elapsed = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, MAX_FRAME_DELTA) : 0;
    lastFrameTime = timestamp;
    accumulator += elapsed;
    while (accumulator >= FIXED_TIME_STEP) {
        world.step(FIXED_TIME_STEP);
        updatePocketing();
        accumulator -= FIXED_TIME_STEP;
    }

    updateMovementState();
    updateTrajectory();
    updateCamera();

    if (audioCtx && camera) {
        const listener = audioCtx.listener;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        listener.positionX.value = camera.position.x;
        listener.positionY.value = camera.position.y;
        listener.positionZ.value = camera.position.z;
        listener.forwardX.value = forward.x;
        listener.forwardY.value = forward.y;
        listener.forwardZ.value = forward.z;
        listener.upX.value = camera.up.x;
        listener.upY.value = camera.up.y;
        listener.upZ.value = camera.up.z;
    }

    for (const ball of balls) {
        if (ball.potted) continue;
        ball.mesh.position.copy(ball.body.position);
        ball.mesh.quaternion.copy(ball.body.quaternion);
    }
    renderer.render(scene, camera);
}
