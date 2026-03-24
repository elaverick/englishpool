import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import * as CANNON from 'https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js';

// --- Configuration ---
const BALL_RADIUS = 0.25;
const TABLE_WIDTH = 10;
const TABLE_LENGTH = 20;
const MAX_POWER = 12; // Maximum impulse power applied to the white ball

// --- Animation Loop ---
const timeStep = 1 / 60;

// --- Audio ---
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// --- Globals ---
let scene, camera, renderer, world;
let balls = []; // Will store objects like: { mesh: THREE.Mesh, body: CANNON.Body }
let whiteBallBody;
let aimingLine;
let cameraAngle = 0;
let cameraDistance = 6;

// Controls
let isAiming = false;
let isCharging = false;
let startDragY = 0;
let chargePower = 0;

const powerBarContainer = document.getElementById('power-bar-container');
const powerBar = document.getElementById('power-bar');

init();
animate();

function init() {
    // 1. Three.js Scene Setup
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 15, 5);
    dirLight.castShadow = true;
    dirLight.shadow.camera.left = -15;
    dirLight.shadow.camera.right = 15;
    dirLight.shadow.camera.top = 15;
    dirLight.shadow.camera.bottom = -15;
    scene.add(dirLight);

    // 2. Cannon-es Physics World Setup
    world = new CANNON.World({
        gravity: new CANNON.Vec3(0, -9.82, 0), // Real world gravity
    });

    // Materials dictate how objects interact (friction & bounciness)
    const physicsMaterials = setupPhysicsMaterials();

    // 3. Build the World
    buildTable(physicsMaterials);
    buildBalls(physicsMaterials.ballMat);
    createAimingLine();

    // 4. Input Listeners
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onMouseWheel, { passive: false });
}

// Procedural impact sound generator
function playImpactSound(impactStrength, x, y, z) {
    if (impactStrength < 0.03) return;

    const ctx = audioCtx;

    // MUCH quieter overall
    const duration = 0.06 + impactStrength * 0.03;

    const panner = ctx.createPanner();
    panner.panningModel = "HRTF";
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;

    // GLOBAL GAIN (now subtle)
    const master = ctx.createGain();
    master.gain.value = 0.15 + impactStrength * 0.35;  // was ~1.5
    master.connect(panner).connect(ctx.destination);

    // BROADBAND noise
    const noise = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const d = nbuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random()*2 - 1);
    noise.buffer = nbuf;

    // Helper for subtle resonances
    function mode(freq, q, gainValue, decay) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = freq;
        bp.Q.value = q;

        const g = ctx.createGain();

        // soft attack
        const now = ctx.currentTime;
        g.gain.setValueAtTime(0.00001, now);
        g.gain.exponentialRampToValueAtTime(gainValue, now + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, now + decay);

        bp.connect(g).connect(master);
        return bp;
    }

    const impact = impactStrength;

    // MUCH QUIETER + LESS Q
    const res1 = mode(430 + impact * 40, 0.7, 0.08 + impact * 0.1, duration);
    const res2 = mode(900 + impact * 60, 0.9, 0.05 + impact * 0.08, duration*0.8);
    const res3 = mode(1500 + impact * 80, 1.0, 0.03 + impact * 0.06, duration*0.6);

    noise.connect(res1);
    noise.connect(res2);
    noise.connect(res3);

    // Very quiet transient
    const click = ctx.createOscillator();
    const cg = ctx.createGain();

    click.type = "square";
    click.frequency.setValueAtTime(2800, ctx.currentTime);
    cg.gain.setValueAtTime(0.002 + impact*0.008, ctx.currentTime);
    cg.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.01);

    click.connect(cg).connect(master);
    click.start();
    click.stop(ctx.currentTime + 0.02);

    noise.start();
    noise.stop(ctx.currentTime + duration);
}

function createAimingLine() {
    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -10)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.3, gapSize: 0.2 });
    aimingLine = new THREE.Line(geometry, material);
    aimingLine.computeLineDistances();
    scene.add(aimingLine);
}

function setupPhysicsMaterials() {
    const ballMat = new CANNON.Material('ball');
    const tableMat = new CANNON.Material('table');
    const cushionMat = new CANNON.Material('cushion');

    // Ball hitting Ball (High bounce, low friction)
    const ballBallContact = new CANNON.ContactMaterial(ballMat, ballMat, { friction: 0.1, restitution: 0.9 });
    // Ball hitting Cloth (Medium friction, low bounce)
    const ballTableContact = new CANNON.ContactMaterial(ballMat, tableMat, { friction: 0.3, restitution: 0.1 });
    // Ball hitting Cushion (Low friction, decent bounce)
    const ballCushionContact = new CANNON.ContactMaterial(ballMat, cushionMat, { friction: 0.1, restitution: 0.8 });

    world.addContactMaterial(ballBallContact);
    world.addContactMaterial(ballTableContact);
    world.addContactMaterial(ballCushionContact);

    return { ballMat, tableMat, cushionMat };
}

function createBaizeMaterial(size = 512, repeat = 4) {
    // --- Color / diffuse ---
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');

    // base green
    ctx.fillStyle = '#054215';
    ctx.fillRect(0, 0, size, size);

    // directional fibers
    const fiberCount = 4000;
    for (let i = 0; i < fiberCount; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const length = Math.random() * 2 + 1;
        const angle = (Math.random() - 0.5) * 0.3; // mostly vertical
        const alpha = Math.random() * 0.15;

        ctx.strokeStyle = `rgba(0,80,20,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + length * Math.cos(angle), y + length * Math.sin(angle));
        ctx.stroke();
    }

    // slight random noise overlay
    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
        const rand = (Math.random() - 0.5) * 15;
        data[i] = data[i] + rand;
        data[i+1] = data[i+1] + rand;
        data[i+2] = data[i+2] + rand;
    }
    ctx.putImageData(imgData, 0, 0);

    const map = new THREE.CanvasTexture(canvas);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeat, repeat);
    map.anisotropy = 16;

    // --- Normal map ---
    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = size;
    const nctx = normalCanvas.getContext('2d');
    const nData = nctx.createImageData(size, size);

    for (let i = 0; i < data.length; i += 4) {
        const v = data[i] / 255 * 255;
        nData.data[i] = 127 + v*0.25;      // X
        nData.data[i+1] = 127 + v*0.25;    // Y
        nData.data[i+2] = 255;             // Z
        nData.data[i+3] = 255;
    }
    nctx.putImageData(nData, 0, 0);

    const normalMap = new THREE.CanvasTexture(normalCanvas);
    normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.repeat.set(repeat, repeat);
    normalMap.anisotropy = 16;

    // --- Roughness map (anisotropic fibers) ---
    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = roughCanvas.height = size;
    const rctx = roughCanvas.getContext('2d');
    const roughData = rctx.createImageData(size, size);
    for (let i = 0; i < data.length; i += 4) {
        const v = data[i] / 255 * 255;
        // directionally brighter fibers = slightly shinier
        const rough = 0.6 + (v / 255) * 0.2; 
        roughData.data[i] = rough * 255;
        roughData.data[i+1] = rough * 255;
        roughData.data[i+2] = rough * 255;
        roughData.data[i+3] = 255;
    }
    rctx.putImageData(roughData, 0, 0);

    const roughnessMap = new THREE.CanvasTexture(roughCanvas);
    roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
    roughnessMap.repeat.set(repeat, repeat);
    roughnessMap.anisotropy = 16;

    // --- Compose material ---
    const material = new THREE.MeshStandardMaterial({
        map: map,
        normalMap: normalMap,
        roughnessMap: roughnessMap,
        roughness: 0.7,
        metalness: 0.05
    });

    return material;
}

function buildTable(mats) {
    // A. Visual Table Bed
    const bedGeo = new THREE.BoxGeometry(TABLE_WIDTH, 0.5, TABLE_LENGTH);
    const baize = createBaizeMaterial(512, 4);
    const bedMat = new THREE.MeshStandardMaterial({
        map: baize.map,
        normalMap: baize.normalMap,
        roughness: 0.8,
        metalness: 0.1
    });

    const bedMesh = new THREE.Mesh(
        new THREE.BoxGeometry(TABLE_WIDTH, 0.5, TABLE_LENGTH),
        bedMat
    );
    bedMesh.position.y = -0.25;
    bedMesh.receiveShadow = true;
    scene.add(bedMesh);

    // B. Physics Table Bed (Static Plane)
    const bedBody = new CANNON.Body({
        mass: 0, // 0 mass makes it static
        shape: new CANNON.Box(new CANNON.Vec3(TABLE_WIDTH / 2, 0.25, TABLE_LENGTH / 2)),
        position: new CANNON.Vec3(0, -0.25, 0),
        material: mats.tableMat
    });
    world.addBody(bedBody);

    // C. Cushions
    const cushionMatVis = new THREE.MeshStandardMaterial({ color: 0x5c3a21 });
    const thickness = 1;
    const height = 0.6; // Slightly higher than the ball radius

    function addCushion(x, z, width, length) {
        // Visual
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), cushionMatVis);
        mesh.position.set(x, height / 2, z);
        mesh.castShadow = true;
        scene.add(mesh);

        // Physics
        const body = new CANNON.Body({
            mass: 0,
            shape: new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, length / 2)),
            position: new CANNON.Vec3(x, height / 2, z),
            material: mats.cushionMat
        });
        world.addBody(body);
    }

    // Top/Bottom
    addCushion(0, -TABLE_LENGTH/2 - thickness/2, TABLE_WIDTH + thickness * 2, thickness);
    addCushion(0, TABLE_LENGTH/2 + thickness/2, TABLE_WIDTH + thickness * 2, thickness);
    // Left/Right
    addCushion(-TABLE_WIDTH/2 - thickness/2, 0, thickness, TABLE_LENGTH);
    addCushion(TABLE_WIDTH/2 + thickness/2, 0, thickness, TABLE_LENGTH);
}

function buildBalls(ballPhysMat) {
    const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
    
    function createBall(color, x, z, isWhite = false) {
        // Visual
        const mat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.2, metalness: 0.1 });
        const mesh = new THREE.Mesh(ballGeo, mat);
        mesh.castShadow = true;
        scene.add(mesh);

        // Physics
        const body = new CANNON.Body({
            mass: 0.17, // roughly 170 grams
            shape: new CANNON.Sphere(BALL_RADIUS),
            position: new CANNON.Vec3(x, BALL_RADIUS, z),
            material: ballPhysMat,
            linearDamping: 0.4,  // Simulates friction dragging the ball to a stop
            angularDamping: 0.4  // Slows down the rolling spin
        });
        world.addBody(body);

        // Procedural sound on collision
        body.addEventListener("collide", e => {
            const contact = e.contact;
            const impact = Math.abs(contact.getImpactVelocityAlongNormal());
            const pos = body.position;

            let cushionHit = false;

            const aMat = contact.bi.material?.name;
            const bMat = contact.bj.material?.name;

            if (aMat === "cushion" || bMat === "cushion") cushionHit = true;

            // Slightly soften cushion impact
            const modifiedImpact = cushionHit ? impact * 0.6 : impact;

            playImpactSound(modifiedImpact, pos.x, pos.y, pos.z);
        });

        balls.push({ mesh, body });
        return body;
    }

    // 1. White Ball (Baulk line)
    whiteBallBody = createBall(0xffffff, 0, TABLE_LENGTH * 0.25, true);

    // 2. English 8-ball Rack (Red & Yellow)
    const c = { r: 0xd32f2f, y: 0xfbc02d, b: 0x111111 };
    const pattern = [
        [c.r],
        [c.y, c.r],
        [c.y, c.b, c.y],
        [c.r, c.y, c.r, c.r],
        [c.y, c.r, c.y, c.r, c.y]
    ];

    const startZ = -TABLE_LENGTH * 0.25;
    const spacing = BALL_RADIUS * 2.01; // Slight gap to prevent physics explosions on spawn

    for (let row = 0; row < pattern.length; row++) {
        const rowZ = startZ - row * (spacing * Math.sqrt(3) / 2);
        const startX = - (row * spacing) / 2;

        for (let col = 0; col < pattern[row].length; col++) {
            createBall(pattern[row][col], startX + col * spacing, rowZ);
        }
    }
}

// --- Controls & Interaction ---
function onMouseDown(e) {
    if (e.button === 2) { 
        isAiming = true;
    } else if (e.button === 0 && aimingLine.visible) { 
        isCharging = true;
        startDragY = e.clientY;
        powerBarContainer.style.display = 'block';
    }
}

function onMouseMove(e) {
    if (isAiming) {
        cameraAngle -= e.movementX * 0.005;
    }

    if (isCharging) {
        const dragDist = Math.max(0, e.clientY - startDragY); 
        chargePower = Math.min(dragDist * 0.05, MAX_POWER); // Cap power at MAX_POWER
        
        const powerPercentage = (chargePower / MAX_POWER) * 100;
        if (chargePower > 0.5)
            powerBar.style.width = `${powerPercentage}%`;
        else
            powerBar.style.width = '0%';
    }
}

function onMouseUp(e) {
    if (e.button === 2) {
        isAiming = false;
    } else if (e.button === 0) {
        isCharging = false;
        powerBarContainer.style.display = 'none';
        powerBar.style.width = '0%';
        
        if (chargePower > 0.5) {
            // Calculate force direction based on camera angle
            const forceX = -Math.sin(cameraAngle) * chargePower;
            const forceZ = -Math.cos(cameraAngle) * chargePower;
            
            // Apply impulse to the center of the white ball
            whiteBallBody.applyImpulse(
                new CANNON.Vec3(forceX, 0, forceZ),
                new CANNON.Vec3(0, 0, 0)
            );
            chargePower = 0;
        }
    }
}

function onMouseWheel(e) {
    e.preventDefault();
    cameraDistance += e.deltaY * 0.005;
    cameraDistance = Math.max(2, Math.min(cameraDistance, 18));
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    // Step the physics world forward
    world.step(timeStep);

    // Sync Three.js visual meshes with Cannon.js rigid bodies
    for (const ball of balls) {
        ball.mesh.position.copy(ball.body.position);
        ball.mesh.quaternion.copy(ball.body.quaternion);
    }

    // Update Aiming Line
    aimingLine.position.copy(whiteBallBody.position);
    aimingLine.rotation.y = cameraAngle;
    // Only show line if white ball is mostly still
    aimingLine.visible = whiteBallBody.velocity.length() < 0.01;

    // Update Camera Position
    const camHeight = 3.5;
    
    // Camera chase logic
    camera.position.x = whiteBallBody.position.x + Math.sin(cameraAngle) * cameraDistance;
    camera.position.z = whiteBallBody.position.z + Math.cos(cameraAngle) * cameraDistance;
    camera.position.y = cameraDistance * 0.65; 
    camera.lookAt(whiteBallBody.position.x, whiteBallBody.position.y, whiteBallBody.position.z);

    // Update audio listener to camera position
    const listener = audioCtx.listener;
    listener.positionX.value = camera.position.x;
    listener.positionY.value = camera.position.y;
    listener.positionZ.value = camera.position.z;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);

    listener.forwardX.value = forward.x;
    listener.forwardY.value = forward.y;
    listener.forwardZ.value = forward.z;

    listener.upX.value = camera.up.x;
    listener.upY.value = camera.up.y;
    listener.upZ.value = camera.up.z;

    // Render
    renderer.render(scene, camera);
}