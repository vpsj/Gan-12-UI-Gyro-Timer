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

// ✅ Setup TwistyPlayer
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

//
// 🔄 Cube rotation animation setup
//
let conn: GanCubeConnection | null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let twistyScene: THREE.Scene;
let twistyVantage: any;

/**
 * ✅ Force correct cube orientation:
 * - White = Front
 * - Blue = Top
 * 
 * Verified for Cubing.js coordinate system:
 *   X axis → right (red)
 *   Y axis → up (white by default)
 *   Z axis → toward camera (green by default)
 * 
 * So we rotate:
 *   -90° around X → move white to front
 *   +90° around Z → move blue to top
 */
const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2)
);

// Start cubeQuaternion aligned to that home orientation
let cubeQuaternion: THREE.Quaternion = new THREE.Quaternion().copy(HOME_ORIENTATION);

async function animateCubeOrientation() {
  if (!twistyScene || !twistyVantage) {
    const vantageList = await twistyPlayer.experimentalCurrentVantages();
    twistyVantage = [...vantageList][0];
    twistyScene = await twistyVantage.scene.scene();

    // Apply instantly
    twistyScene.quaternion.copy(cubeQuaternion);
    twistyVantage.render();

    console.log('✅ Orientation forced: White front, Blue top');
  }

  twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
  twistyVantage.render();
  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, -Math.PI / 2, 0) // X, Y, Z in radians
);

// The cubeQuaternion will start at the home orientation
let cubeQuaternion: THREE.Quaternion = new THREE.Quaternion().copy(HOME_ORIENTATION);

async function animateCubeOrientation() {
  if (!twistyScene || !twistyVantage) {
    const vantageList = await twistyPlayer.experimentalCurrentVantages();
    twistyVantage = [...vantageList][0];
    twistyScene = await twistyVantage.scene.scene();

    // Apply the correct starting orientation instantly
    twistyScene.quaternion.copy(cubeQuaternion);
    twistyVantage.render();

    console.log('✅ Default orientation: White front, Blue top');
  }

  // Smooth transitions on updates
  twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
  twistyVantage.render();
  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

//
// ⚙️ Handle GanCube events
//
let basis: THREE.Quaternion | null;

async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') {
    const { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();

    if (!basis) {
      basis = quat.clone().conjugate();
    }

    // Apply the new gyro rotation relative to the home orientation
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

let cubeStateInitialized = false;

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

// ✅ Keep your working MAC handler
const customMacAddressProvider: MacAddressProvider = async (
  device,
  isFallbackCall
): Promise<string | null> => {
  const savedMac = localStorage.getItem('gan_cube_mac');
  if (savedMac && !isFallbackCall) {
    console.log(`Using saved MAC: ${savedMac}`);
    return savedMac;
  }

  const manualMac = prompt(
    'Please enter your cube’s MAC address (e.g., F0:AB:12:34:56:78):'
  );
  if (manualMac) {
    localStorage.setItem('gan_cube_mac', manualMac);
    console.log(`Saved MAC: ${manualMac}`);
    return manualMac;
  }

  return null;
};

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
  } else {
    conn = await connectGanCube(customMacAddressProvider);
    conn.events$.subscribe(handleCubeEvent);
    await conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
    $('#connect').html('Disconnect');
  }
});

//
// 🕒 Timer logic
//
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
  localTimer = interval(30).subscribe(() =>
    setTimerValue(now() - startTime)
  );
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
