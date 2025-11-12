import './style.css'

import $ from 'jquery';
import { Subscription, interval } from 'rxjs';
import { TwistyPlayer } from 'cubing/twisty';
import { experimentalSolve3x3x3IgnoringCenters } from 'cubing/search';
import * as THREE from 'three';

import {
  now,
  connectGanCube,
  GanCubeConnection,
  GanCubeEvent,
  GanCubeMove,
  MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampCalcSkew,
  cubeTimestampLinearFit
} from 'gan-web-bluetooth';

import { faceletsToPattern, patternToFacelets } from './utils';

const SOLVED_STATE =
  'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

const twistyPlayer = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  hintFacelets: 'none',
  experimentalDragInput: 'none',
  tempoScale: 5,
});

$('#cube').append(twistyPlayer);
$('#cube').append(twistyPlayer);

// Wait for TwistyPlayer to fully initialize before logging
(async () => {
  // Wait for a valid vantage
  let vantages = [];
  for (let i = 0; i < 20; i++) { // up to ~2 seconds total
    vantages = await twistyPlayer.experimentalCurrentVantages();
    if (vantages.length > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }

  if (!vantages.length) {
    console.error("No vantages available — TwistyPlayer scene not initialized.");
    return;
  }

  const vantage = vantages[0];
  const scene = await vantage.scene.scene();

  console.group("Twisty Scene Children");
  scene.children.forEach((child, i) => {
    console.log(i, child.name || child.type);
  });
  console.groupEnd();

  console.log("✅ TwistyPlayer scene is ready.");
})();







// --- GLOBALS ---
let conn: GanCubeConnection | null = null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let twistyScene: THREE.Scene | null = null;
let twistyVantage: any = null;
let cubeGroup: THREE.Object3D | null = null; // ✅ The real cube mesh container
let basis: THREE.Quaternion | null = null;
let cubeStateInitialized = false;

// --- Orientation target: White front, Blue top ---
const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(Math.PI / 2, 0, Math.PI) // +90° X, +180° Z
);
let cubeQuaternion = new THREE.Quaternion().copy(HOME_ORIENTATION);

// --- Initialize and capture cube mesh ---
(async () => {
  const vList = await twistyPlayer.experimentalCurrentVantages();
  twistyVantage = [...vList][0];
  twistyScene = await twistyVantage.scene.scene();

  // ✅ Find the actual cube mesh (Cubing.js 0.28+ wraps the 3D model under children)
  cubeGroup =
    twistyScene?.children.find((obj) =>
      obj.name.toLowerCase().includes('puzzle')
    ) || twistyScene?.children[0];

  if (!cubeGroup) {
    console.warn('⚠️ Could not find cubeGroup! Orientation might fail.');
    cubeGroup = twistyScene;
  }

  // Apply orientation directly to cube mesh
  cubeGroup.quaternion.copy(HOME_ORIENTATION);
  cubeQuaternion.copy(HOME_ORIENTATION);
  twistyVantage.render();

  console.log('%c✅ CubeGroup orientation fixed: White front, Blue top', 'color:#0f0;font-weight:bold;');
})();

// --- Animate cube orientation (driven by gyro) ---
function animateCubeOrientation() {
  if (cubeGroup && twistyVantage) {
    cubeGroup.quaternion.slerp(cubeQuaternion, 0.25);
    twistyVantage.render();
  }
  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

// --- GANCUBE EVENTS ---
async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') {
    const { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();

    if (!basis) basis = quat.clone().conjugate();

    // Apply gyro relative to home orientation
    cubeQuaternion.copy(quat.premultiply(basis).premultiply(HOME_ORIENTATION));
  }
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type === 'MOVE') {
    if (timerState === 'READY') setTimerState('RUNNING');
    twistyPlayer.experimentalAddMove(event.move, { cancel: false });
    lastMoves.push(event);
    if (timerState === 'RUNNING') solutionMoves.push(event);
    if (lastMoves.length > 256) lastMoves = lastMoves.slice(-256);
  }
}

async function handleFaceletsEvent(event: GanCubeEvent) {
  if (event.type === 'FACELETS' && !cubeStateInitialized) {
    if (event.facelets !== SOLVED_STATE) {
      const kpattern = faceletsToPattern(event.facelets);
      const solution = await experimentalSolve3x3x3IgnoringCenters(kpattern);
      twistyPlayer.alg = solution.invert();
    } else {
      twistyPlayer.alg = '';
    }
    cubeStateInitialized = true;
  }
}

function handleCubeEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') handleGyroEvent(event);
  else if (event.type === 'MOVE') handleMoveEvent(event);
  else if (event.type === 'FACELETS') handleFaceletsEvent(event);
  else if (event.type === 'DISCONNECT') {
    twistyPlayer.alg = '';
    $('#connect').html('Connect');
  }
}

// --- MAC persistence ---
const customMacAddressProvider: MacAddressProvider = async (device, isFallbackCall): Promise<string | null> => {
  const savedMac = localStorage.getItem('gan_cube_mac');
  if (savedMac && !isFallbackCall) return savedMac;

  const manualMac = prompt('Please enter your cube’s MAC address:');
  if (manualMac) {
    localStorage.setItem('gan_cube_mac', manualMac);
    return manualMac;
  }
  return null;
};

// --- UI Buttons ---
$('#reset-state').on('click', async () => {
  await conn?.sendCubeCommand({ type: 'REQUEST_RESET' });
  twistyPlayer.alg = '';
});

$('#reset-gyro').on('click', async () => {
  basis = null;
});

$('#connect').on('click', async () => {
  if (conn) {
    conn.disconnect();
    conn = null;
    $('#connect').html('Connect');
  } else {
    conn = await connectGanCube(customMacAddressProvider);
    conn.events$.subscribe(handleCubeEvent);
    await conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
    $('#connect').html('Disconnect');
  }
});

// --- Timer logic ---
let timerState: 'IDLE' | 'READY' | 'RUNNING' | 'STOPPED' = 'IDLE';

function setTimerState(state: typeof timerState) {
  timerState = state;
  switch (state) {
    case 'IDLE':
      stopLocalTimer();
      $('#timer').hide();
      break;
    case 'READY':
      setTimerValue(0);
      $('#timer').show().css('color', '#0f0');
      break;
    case 'RUNNING':
      solutionMoves = [];
      startLocalTimer();
      $('#timer').css('color', '#999');
      break;
    case 'STOPPED':
      stopLocalTimer();
      $('#timer').css('color', '#fff');
      const fittedMoves = cubeTimestampLinearFit(solutionMoves);
      const lastMove = fittedMoves.slice(-1).pop();
      setTimerValue(lastMove ? lastMove.cubeTimestamp! : 0);
      break;
  }
}

twistyPlayer.experimentalModel.currentPattern.addFreshListener(async (kpattern) => {
  const facelets = patternToFacelets(kpattern);
  if (facelets === SOLVED_STATE && timerState === 'RUNNING') {
    setTimerState('STOPPED');
    twistyPlayer.alg = '';
  }
});

function setTimerValue(timestamp: number) {
  const t = makeTimeFromTimestamp(timestamp);
  $('#timer').html(
    `${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds
      .toString(10)
      .padStart(3, '0')}`
  );
}

let localTimer: Subscription | null = null;
function startLocalTimer() {
  const startTime = now();
  localTimer = interval(30).subscribe(() => setTimerValue(now() - startTime));
}
function stopLocalTimer() {
  localTimer?.unsubscribe();
  localTimer = null;
}
function activateTimer() {
  if (timerState === 'IDLE' && conn) setTimerState('READY');
  else setTimerState('IDLE');
}
$(document).on('keydown', (event) => {
  if (event.which === 32) {
    event.preventDefault();
    activateTimer();
  }
});
$('#cube').on('touchstart', () => {
  activateTimer();
});
