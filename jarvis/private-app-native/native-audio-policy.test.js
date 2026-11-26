"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canStartListening, getAudioPrivacyPolicy } = require("./audio-policy");
const appConfig = require("./app.config");

test("microphone cannot start without explicit consent", () => {
  assert.equal(canStartListening({ platform: "ios", explicitConsent: false, permissionGranted: true }), false);
  assert.equal(canStartListening({ platform: "android", explicitConsent: false, permissionGranted: true }), false);
});

test("microphone cannot start when OS permission is denied", () => {
  assert.equal(canStartListening({ platform: "ios", explicitConsent: true, permissionGranted: false }), false);
  assert.equal(canStartListening({ platform: "android", explicitConsent: true, permissionGranted: false }), false);
});

test("microphone starts only after consent and permission on supported native platforms", () => {
  assert.equal(canStartListening({ platform: "ios", explicitConsent: true, permissionGranted: true }), true);
  assert.equal(canStartListening({ platform: "android", explicitConsent: true, permissionGranted: true }), true);
});

test("unknown platforms fail closed", () => {
  assert.equal(canStartListening({ platform: "windows", explicitConsent: true, permissionGranted: true }), false);
  assert.equal(canStartListening({ platform: "web", explicitConsent: true, permissionGranted: true }), false);
});

test("raw audio is never persisted or uploaded before wake", () => {
  const policy = getAudioPrivacyPolicy();
  assert.equal(policy.rawAudioPersistence, false);
  assert.equal(policy.rawAudioUploadBeforeWake, false);
  assert.equal(policy.detectionMode, "local-only");
});

test("capture never auto-starts or auto-restarts after force quit", () => {
  const policy = getAudioPrivacyPolicy();
  assert.equal(policy.autoStart, false);
  assert.equal(policy.autoRestartAfterForceQuit, false);
});

test("privacy policy requires explicit consent and a visible stop control", () => {
  const policy = getAudioPrivacyPolicy();
  assert.equal(policy.requiresExplicitConsent, true);
  assert.equal(policy.requiresMicrophonePermission, true);
  assert.equal(policy.requiresVisibleStopControl, true);
});

test("Expo config declares background recording, not background playback", () => {
  const config = appConfig({ config: {} });
  const audioPlugin = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-audio");
  assert.ok(audioPlugin);
  assert.equal(audioPlugin[1].enableBackgroundRecording, true);
  assert.equal(audioPlugin[1].enableBackgroundPlayback, false);
  assert.match(audioPlugin[1].microphonePermission, /マイク/);
});

test("iOS config requests tablet support and declares audio background mode", () => {
  const config = appConfig({ config: {} });
  assert.equal(config.ios.supportsTablet, true);
  assert.deepEqual(config.ios.infoPlist.UIBackgroundModes, ["audio"]);
  assert.match(config.ios.infoPlist.NSMicrophoneUsageDescription, /明示的/);
});

test("Android config declares recording and microphone foreground service permissions", () => {
  const config = appConfig({ config: {} });
  assert.ok(config.android.permissions.includes("android.permission.RECORD_AUDIO"));
  assert.ok(config.android.permissions.includes("android.permission.FOREGROUND_SERVICE"));
  assert.ok(config.android.permissions.includes("android.permission.FOREGROUND_SERVICE_MICROPHONE"));
});

test("audio workspace targets only iOS and Android native builds", () => {
  const config = appConfig({ config: {} });
  assert.deepEqual(config.platforms, ["ios", "android"]);
});

test("no production JARVIS API endpoint or secret is configured in native app", () => {
  const config = appConfig({ config: {} });
  assert.equal(config.extra.oneJarvis.cloudWakeWordDetection, false);
  assert.equal(config.extra.oneJarvis.localOnlyCapture, true);
  assert.equal(Object.hasOwn(config.extra.oneJarvis, "apiKey"), false);
});
