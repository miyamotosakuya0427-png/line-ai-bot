"use strict";

/**
 * Native-only wake-word boundary.
 * Production inference and microphone capture must stay in Swift/Kotlin/C++;
 * raw PCM must never cross the React Native bridge.
 */
const DEFAULT_KEYWORD = "ジャービス";

function createWakeWordEngine({ nativeModule, modelManifest } = {}) {
  let state = "idle";
  let listener = null;

  function getStatus() {
    const ready = Boolean(nativeModule && modelManifest &&
      modelManifest.status === "verified" &&
      modelManifest.keyword === DEFAULT_KEYWORD &&
      modelManifest.sha256 && modelManifest.license);
    return Object.freeze({ state, ready, keyword: DEFAULT_KEYWORD,
      mode: "on-device",
      reason: ready ? null : "NATIVE_ENGINE_OR_VERIFIED_MODEL_UNAVAILABLE" });
  }

  async function start({ explicitConsent, permissionGranted, onDetected } = {}) {
    if (state === "listening") return getStatus();
    if (explicitConsent !== true || permissionGranted !== true) {
      throw new Error("WAKE_WORD_CONSENT_OR_PERMISSION_REQUIRED");
    }
    const status = getStatus();
    if (!status.ready) {
      state = "unavailable";
      throw new Error(status.reason);
    }
    if (typeof nativeModule.start !== "function" ||
        typeof nativeModule.stop !== "function" ||
        typeof nativeModule.addListener !== "function") {
      state = "unavailable";
      throw new Error("NATIVE_WAKE_WORD_MODULE_CONTRACT_INVALID");
    }
    listener = nativeModule.addListener("onWakeWordDetected", (event) => {
      if (state !== "listening" || !event || event.keyword !== DEFAULT_KEYWORD) return;
      if (typeof onDetected === "function") onDetected(Object.freeze({
        keyword: DEFAULT_KEYWORD,
        detectedAtMonotonicMs: Number.isFinite(event.detectedAtMonotonicMs)
          ? event.detectedAtMonotonicMs : null
      }));
    });
    try {
      await nativeModule.start({ keyword: DEFAULT_KEYWORD,
        modelPath: modelManifest.modelPath, localOnly: true,
        persistAudio: false, uploadAudio: false });
      state = "listening";
      return getStatus();
    } catch (error) {
      if (listener && typeof listener.remove === "function") listener.remove();
      listener = null;
      state = "idle";
      throw error;
    }
  }

  async function stop() {
    if (listener && typeof listener.remove === "function") listener.remove();
    listener = null;
    if (nativeModule && typeof nativeModule.stop === "function") await nativeModule.stop();
    state = "idle";
    return getStatus();
  }
  return Object.freeze({ getStatus, start, stop });
}

module.exports = Object.freeze({ DEFAULT_KEYWORD, createWakeWordEngine });
