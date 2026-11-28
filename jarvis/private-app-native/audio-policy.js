"use strict";

const PLATFORM_ALLOWLIST = Object.freeze(["ios", "android"]);

function canStartListening({ platform, explicitConsent, permissionGranted }) {
  return PLATFORM_ALLOWLIST.includes(platform) &&
    explicitConsent === true &&
    permissionGranted === true;
}

function getAudioPrivacyPolicy() {
  return Object.freeze({
    wakeWord: "ジャービス",
    detectionMode: "local-only",
    rawAudioPersistence: false,
    rawAudioUploadBeforeWake: false,
    autoStart: false,
    autoRestartAfterForceQuit: false,
    requiresExplicitConsent: true,
    requiresMicrophonePermission: true,
    requiresVisibleStopControl: true
  });
}

module.exports = Object.freeze({ canStartListening, getAudioPrivacyPolicy });
