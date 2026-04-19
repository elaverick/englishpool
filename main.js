import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import * as CANNON from 'https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js';

// --- Configuration ---
const BALL_RADIUS = 0.25;
const TABLE_WIDTH = 10;
const TABLE_LENGTH = 20;
const MAX_POWER = 12; // Maximum impulse power applied to the white ball
const MAX_SPIN_RADIUS = BALL_RADIUS * 0.75; // Clamps dot to 75% of the ball's radius

// --- Animation Loop ---
const timeStep = 1 / 60;

// --- Audio ---
let audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// --- Globals ---
let scene, camera, renderer, world;
let balls = [];
let whiteBallBody;
let mainLine, cueDeflectionLine, objectBallLine, ghostBall;
let isMoving = false;
let cameraAngle = 0;
let cameraPitch = 0.6; // Vertical camera angle
let cameraDistance = 6;
let strikeDot; // Visual marker for where the cue hits
let spinX = 0; // Left/Right spin (English)
let spinY = 0; // Top/Bottom spin

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
    
    // NEW: Trajectory Visuals
    const lineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.2, gapSize: 0.1 });
    const objLineMat = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 0.2, gapSize: 0.1 }); // Orange for object ball

    mainLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    cueDeflectionLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    objectBallLine = new THREE.Line(new THREE.BufferGeometry(), objLineMat);

    const ghostGeo = new THREE.SphereGeometry(BALL_RADIUS, 16, 16);
    const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, wireframe: true });
    ghostBall = new THREE.Mesh(ghostGeo, ghostMat);

    scene.add(mainLine);
    scene.add(cueDeflectionLine);
    scene.add(objectBallLine);
    scene.add(ghostBall);
    
    // Create the Strike Dot
    const dotGeo = new THREE.SphereGeometry(0.015, 16, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x8d0000, depthTest: false }); // depthTest: false forces it to render on top
    strikeDot = new THREE.Mesh(dotGeo, dotMat);
    strikeDot.renderOrder = 999;
    scene.add(strikeDot);

    // 4. Input Listeners
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onMouseWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
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

function updateTrajectory() {
    if (isMoving) {
        ghostBall.visible = mainLine.visible = cueDeflectionLine.visible = objectBallLine.visible = false;
        return;
    }

    ghostBall.visible = mainLine.visible = true;

    const start = whiteBallBody.position;
    const dir = new THREE.Vector3(-Math.sin(cameraAngle), 0, -Math.cos(cameraAngle)).normalize();

    let minT = Infinity;
    let hitType = 'none'; 
    let hitObjPos = null;
    let hitNormal = new THREE.Vector3();

    // 1. Math-based Sphere Cast against all other balls
    for (const ball of balls) {
        if (ball.body === whiteBallBody) continue;
        
        const bPos = ball.body.position;
        const L = new THREE.Vector3(bPos.x - start.x, bPos.y - start.y, bPos.z - start.z);
        const tca = L.dot(dir);
        
        if (tca < 0) continue; // Ball is behind the aim direction

        const d2 = L.lengthSq() - tca * tca;
        const radius2 = (BALL_RADIUS * 2) ** 2; // Hitbox is 2x radius (cue ball + object ball)
        
        if (d2 > radius2) continue; // Ray misses the expanded hitbox

        const thc = Math.sqrt(radius2 - d2);
        const t0 = tca - thc; // Distance to impact
        
        if (t0 > 0 && t0 < minT) {
            minT = t0;
            hitType = 'ball';
            hitObjPos = new THREE.Vector3(bPos.x, bPos.y, bPos.z);
        }
    }

    // 2. Raycast against Cushions (Offset by ball radius)
    if (dir.x < 0) {
        const t = (-TABLE_WIDTH/2 + BALL_RADIUS - start.x) / dir.x;
        if (t > 0 && t < minT) { minT = t; hitType = 'cushion'; hitNormal.set(1,0,0); }
    } else if (dir.x > 0) {
        const t = (TABLE_WIDTH/2 - BALL_RADIUS - start.x) / dir.x;
        if (t > 0 && t < minT) { minT = t; hitType = 'cushion'; hitNormal.set(-1,0,0); }
    }

    if (dir.z < 0) {
        const t = (-TABLE_LENGTH/2 + BALL_RADIUS - start.z) / dir.z;
        if (t > 0 && t < minT) { minT = t; hitType = 'cushion'; hitNormal.set(0,0,1); }
    } else if (dir.z > 0) {
        const t = (TABLE_LENGTH/2 - BALL_RADIUS - start.z) / dir.z;
        if (t > 0 && t < minT) { minT = t; hitType = 'cushion'; hitNormal.set(0,0,-1); }
    }

    // 3. Draw Main Line and Ghost Ball
    const startVec = new THREE.Vector3(start.x, start.y, start.z);
    const impactPos = startVec.clone().add(dir.clone().multiplyScalar(minT));
    ghostBall.position.copy(impactPos);

    mainLine.geometry.setFromPoints([startVec, impactPos]);
    mainLine.computeLineDistances(); // Required for dashed lines to render properly

    // 4. Calculate and Draw Deflection Lines
    if (hitType === 'ball') {
        cueDeflectionLine.visible = true;
        objectBallLine.visible = true;

        // Object ball trajectory (straight line from impact pos through object ball center)
        const objDir = hitObjPos.clone().sub(impactPos).normalize();
        const objEnd = hitObjPos.clone().add(objDir.multiplyScalar(4)); 
        objectBallLine.geometry.setFromPoints([hitObjPos, objEnd]);
        objectBallLine.computeLineDistances();

        // Cue ball deflection (Tangent to the impact normal)
        const normal = hitObjPos.clone().sub(impactPos).normalize();
        const dot = dir.dot(normal);
        let cueDir = dir.clone().sub(normal.clone().multiplyScalar(dot)).normalize();
        
        // Prevent graphical glitch on dead-on shots
        if (cueDir.lengthSq() < 0.01) cueDir = dir.clone(); 

        const cueEnd = impactPos.clone().add(cueDir.multiplyScalar(2));
        cueDeflectionLine.geometry.setFromPoints([impactPos, cueEnd]);
        cueDeflectionLine.computeLineDistances();

    } else if (hitType === 'cushion') {
        cueDeflectionLine.visible = true;
        objectBallLine.visible = false;

        // Reflection formula: R = V - 2(V dot N)N
        const dot = dir.dot(hitNormal);
        const cueDir = dir.clone().sub(hitNormal.clone().multiplyScalar(2 * dot)).normalize();
        
        const cueEnd = impactPos.clone().add(cueDir.multiplyScalar(4));
        cueDeflectionLine.geometry.setFromPoints([impactPos, cueEnd]);
        cueDeflectionLine.computeLineDistances();
    } else {
        // Shooting into the void (shouldn't happen with full cushions)
        cueDeflectionLine.visible = objectBallLine.visible = false;
    }
}

function setupPhysicsMaterials() {
    const ballMat = new CANNON.Material('ball');
    const tableMat = new CANNON.Material('table');
    const cushionMat = new CANNON.Material('cushion');

    // Ball hitting Ball (High bounce, low friction)
    const ballBallContact = new CANNON.ContactMaterial(ballMat, ballMat, { friction: 0.1, restitution: 0.9 });
    // Ball hitting Cloth (Medium friction, low bounce)
    const ballTableContact = new CANNON.ContactMaterial(ballMat, tableMat, { friction: 0.4, restitution: 0.1 });
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
            linearDamping: 0.5,  // Simulates friction dragging the ball to a stop
            angularDamping: 0.1  // Slows down the rolling spin
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
        [c.r, c.b, c.y],
        [c.y, c.r, c.y, c.r],
        [c.r, c.y, c.r, c.y, c.y]
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
    } else if (e.button === 0 && !isMoving) { 
        isCharging = true;
        startDragY = e.clientY;
        powerBarContainer.style.display = 'block';
    }
}

function onMouseMove(e) {
    if (isAiming) {
        cameraAngle -= e.movementX * 0.005;
        cameraPitch += e.movementY * 0.005;
        // Clamp the vertical angle so it doesn't go under the table or directly overhead
        cameraPitch = Math.max(0.1, Math.min(cameraPitch, 1.4)); 
    }

    if (isCharging) {
        const dragDist = Math.max(0, e.clientY - startDragY); 
        chargePower = Math.min(dragDist * 0.05, MAX_POWER);
        
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
            const forceX = -Math.sin(cameraAngle) * chargePower;
            const forceZ = -Math.cos(cameraAngle) * chargePower;
            const forceY = 0; // Keep horizontal so we don't smash the ball into the baize
            
            // Calculate physics contact point relative to ball center
            const localZ = Math.sqrt(Math.max(0, BALL_RADIUS**2 - spinX**2 - spinY**2));
            const contactOffsetX = spinX * Math.cos(cameraAngle) + localZ * Math.sin(cameraAngle);
            const contactOffsetY = spinY;
            const contactOffsetZ = -spinX * Math.sin(cameraAngle) + localZ * Math.cos(cameraAngle);

            const contactPoint = new CANNON.Vec3(contactOffsetX, contactOffsetY, contactOffsetZ);

            whiteBallBody.applyImpulse(
                new CANNON.Vec3(forceX, forceY, forceZ),
                contactPoint
            );
            
            chargePower = 0;
            
            // RESET SPIN FOR THE NEXT SHOT
            spinX = 0;
            spinY = 0;
        }
    }
}

function onMouseWheel(e) {
    e.preventDefault();
    cameraDistance += e.deltaY * 0.005;
    cameraDistance = Math.max(2, Math.min(cameraDistance, 18));
}

function onKeyDown(e) {
    // Only allow spin changes if the player is aiming and the ball is still
    if (isMoving) return;

    const spinSpeed = 0.01;
    
    if (e.key === 'ArrowUp' || e.key === 'w') spinY += spinSpeed;
    if (e.key === 'ArrowDown' || e.key === 's') spinY -= spinSpeed;
    if (e.key === 'ArrowLeft' || e.key === 'a') spinX -= spinSpeed;
    if (e.key === 'ArrowRight' || e.key === 'd') spinX += spinSpeed;

    // Clamp the spin to prevent impossible shots (cueing through the ball)
    const currentRadius = Math.sqrt(spinX**2 + spinY**2);
    if (currentRadius > MAX_SPIN_RADIUS) {
        // Normalize the vector and multiply by our max radius
        spinX = (spinX / currentRadius) * MAX_SPIN_RADIUS;
        spinY = (spinY / currentRadius) * MAX_SPIN_RADIUS;
    }
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

    // Sync Three.js visual meshes with Cannon.js rigid bodies
    for (const ball of balls) {
        ball.mesh.position.copy(ball.body.position);
        ball.mesh.quaternion.copy(ball.body.quaternion);
    }

    // Determine if balls are rolling
    isMoving = whiteBallBody.velocity.length() > 0.01;

    // Update trajectory math
    updateTrajectory();

    // NEW: Calculate Strike Point Offset
    const normalizedPitch = (cameraPitch - 0.1) / 1.3; 

    // Calculate dot position on the ball surface facing the camera
    const dirX = Math.sin(cameraAngle);
    const dirZ = Math.cos(cameraAngle);


    // NEW: Update Camera Position using Spherical Coordinates
    camera.position.x = whiteBallBody.position.x + Math.sin(cameraAngle) * Math.cos(cameraPitch) * cameraDistance;
    camera.position.y = whiteBallBody.position.y + Math.sin(cameraPitch) * cameraDistance;
    camera.position.z = whiteBallBody.position.z + Math.cos(cameraAngle) * Math.cos(cameraPitch) * cameraDistance; 
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