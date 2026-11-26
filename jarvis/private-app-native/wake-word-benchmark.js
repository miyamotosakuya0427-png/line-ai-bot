"use strict";

function summarizeWakeWordTrials(trials, observationHours) {
  if (!Array.isArray(trials)) throw new TypeError("TRIALS_MUST_BE_ARRAY");
  if (!Number.isFinite(observationHours) || observationHours <= 0) {
    throw new RangeError("OBSERVATION_HOURS_MUST_BE_POSITIVE");
  }
  let truePositive = 0, falseNegative = 0, falsePositive = 0, trueNegative = 0;
  let latencyTotal = 0, latencyCount = 0;
  for (const trial of trials) {
    if (!trial || typeof trial.expectedWake !== "boolean" ||
        typeof trial.detected !== "boolean") throw new TypeError("INVALID_TRIAL_LABELS");
    if (trial.expectedWake && trial.detected) {
      truePositive += 1;
      if (Number.isFinite(trial.latencyMs) && trial.latencyMs >= 0) {
        latencyTotal += trial.latencyMs; latencyCount += 1;
      }
    } else if (trial.expectedWake && !trial.detected) falseNegative += 1;
    else if (!trial.expectedWake && trial.detected) falsePositive += 1;
    else trueNegative += 1;
  }
  const positiveTotal = truePositive + falseNegative;
  const negativeTotal = falsePositive + trueNegative;
  return Object.freeze({
    trialCount: trials.length, truePositive, falseNegative, falsePositive, trueNegative,
    recall: positiveTotal ? truePositive / positiveTotal : null,
    falseAcceptanceRate: negativeTotal ? falsePositive / negativeTotal : null,
    falseActivationsPerHour: falsePositive / observationHours,
    meanDetectionLatencyMs: latencyCount ? latencyTotal / latencyCount : null,
    rawAudioRequired: false, audioStored: false
  });
}
module.exports = Object.freeze({ summarizeWakeWordTrials });
