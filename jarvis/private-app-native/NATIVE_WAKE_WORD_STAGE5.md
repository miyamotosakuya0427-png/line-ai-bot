# ONE JARVIS — Stage 5 Japanese wake-word model proof and native feasibility audit

Date: 2026-11-28
Repository: miyamotosakuya0427-png/line-ai-bot
PR: #88 (Draft / Open / unmerged)
Branch: feature/one-jarvis-private-app-pwa-20261126
Audited HEAD: 653a260ad453863e0134df676320a931ee0b91b5
Keyword: ジャービス

## 1. Executive decision

**No production or development wake-word engine/model is adopted in this stage. The actual Japanese wake-word detector remains unimplemented.**

Preferred future route: sherpa-onnx native runtime plus a separately sourced/trained and validated Japanese KWS acoustic model. The runtime has Android/iOS support and native C/C++/Kotlin/Swift interfaces, but the official KWS model catalogue currently lists Chinese/English pretrained models, not a validated Japanese acoustic model for 「ジャービス」. Open-vocabulary keyword input does not itself establish that an acoustic model understands Japanese.

Vosk is retained only as a possible Android/desktop ASR research fallback, not as the cross-platform KWS solution. Its Japanese ASR model is not a dedicated wake-word model, and its iOS build is not publicly distributed as a normal drop-in SDK.

Porcupine remains comparison-only. No account, AccessKey, remote model generation, paid SDK, or vendor contact was used.

## 2. Read-only repository and PR audit

- PR #88: Open, Draft, unmerged; head `653a260ad453863e0134df676320a931ee0b91b5`; base `integration/one-jarvis-command-center-ui` at `1f279f1fe295c76d41c7c964309ee32ecc964cda`.
- PR #78: Open, Draft, unmerged; head `b17b6184f064f8dffba5b32f440caf0b5f40d556`; base `integration/one-jarvis-stage5-dispatcher-state-machine` at `8ae79283f1b12025e395e2b5ff28efb8ce16e68f`.
- Changed filename lists were compared; no file path overlaps were found between PR #88 and PR #78.
- No rebase, force-push, merge, branch deletion, or other branch mutation was performed.
- PR #88 exact-head CI: `ONE JARVIS tests` and `JARVIS tests` completed successfully. The `private-native-contract` job succeeded.
- Private native contract job: 31 tests, 31 passed, 0 failed, 0 skipped.
- JARVIS general job: 374 tests, 370 passed, 0 failed, 4 skipped.
- ONE JARVIS general job: 374 tests, 370 passed, 0 failed, 4 skipped.

## 3. SDK and current native app workspace

The isolated app workspace is `jarvis/private-app-native/`:
- Expo SDK `~58.0.26`
- React Native `0.88.0`
- Expo Audio `~58.0.12`
- React `19.3.0`
- Native app test command: `node --test *.test.js`

No sherpa-onnx, Vosk, ONNX Runtime, or dedicated KWS dependency is currently present in this package manifest. No generated Android/iOS native project or local Expo Swift/Kotlin KWS module is included in PR #88.

The existing `App.js` is an explicit-consent audio capture capability test. It omits the PCM callback and does not send continuous PCM into JavaScript. It explicitly tells the user that no wake-word model is installed. This is not a wake-word detector.

The existing `wake-word-engine.js` is an adapter contract only. It fails closed without a native module and a verified model descriptor. Its event boundary filters for the exact keyword and suppresses duplicate detections with a default 1500 ms cooldown. It does not perform inference.

## 4. Candidate findings

### A. sherpa-onnx

- Official KWS documentation describes open-vocabulary/custom KWS, with per-keyword boosting score and trigger threshold.
- Official pretrained KWS examples currently listed: Chinese/English, Chinese Wenetspeech, and English GigaSpeech.
- The documentation lists tokenization methods including CJK character, BPE, full/partial pinyin and phone+pinyin. This is a tokenization capability, not proof of Japanese acoustic-model performance.
- sherpa-onnx provides native C/C++ and platform bindings including Android, iOS, Kotlin and Swift. Its iOS Swift package exposes static/shared XCFramework products.
- A local Expo module can be implemented in Swift/Kotlin; C++-heavy integration may instead use a TurboModule/JSI-oriented boundary.
- iOS build guidance requires macOS, Xcode and CMake. These build prerequisites and a physical iOS device were not available in this GitHub-only stage.
- Runtime project licensing is Apache-2.0; model weights, tokenizer assets and training data require separate provenance and license checks.
- Decision: preferred technical runtime for future Japanese KWS work, but no Japanese model artifact is currently approved or validated.

### B. Vosk Japanese model

Official model catalogue:
- `vosk-model-small-ja-0.22`: listed as 48 MB, Apache 2.0.
- `vosk-model-ja-0.22`: listed as 1 GB, Apache 2.0.
- Small models are described generically as requiring about 300 MB runtime memory; this is not a device-specific measurement for this model. Large models can require up to 16 GB.
- Reported Japanese CER values (small: 9.52 CSJ / 17.07 TED10k; large: 8.40 CSJ / 13.91 TED10k) are ASR character error rates only. They are not wake-word recall, false acceptance, false activations/hour, or latency.

Distribution and integrity:
- Official model listing links the small model archive at `https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip`.
- The official listing marks the model Apache 2.0, but the archive itself and any included LICENSE/NOTICE files could not be retrieved and inspected in this environment because the model host was unreachable from the execution container.
- Consequently no archive SHA-256 is claimed, no archive NOTICE is claimed as inspected, and no model files were added to the repository. Do not bundle or redistribute this artifact until the actual archive, included notices, provenance and redistribution conditions have been inspected.

Android:
- Official install documentation lists Maven Central artifact `com.alphacephei:vosk-android` version `0.3.32+`.
- Official Android demo and native library build instructions exist. Kotlin/Java integration is technically feasible, but was not implemented or built in this stage.

iOS:
- Official Vosk install documentation says the iOS build is available on request. It is not currently documented as a publicly available drop-in SDK.
- No vendor inquiry was made, per instruction. Required next information if the user later authorizes contact: organization, intended private-company assistant use, deployment targets, commercial distribution scope, supported architectures, binary/source availability, license/NOTICE terms, model redistribution rights, maintenance and pricing.

Japanese phrase suitability:
- A Japanese ASR model may decode Japanese speech, but successful recognition of the particular word 「ジャービス」 is not established by the model listing.
- Streaming ASR is not a dedicated wake-word detector. Continuous decoding can emit partial/repeated hypotheses and ordinary speech that resembles the keyword; noisy or clipped utterances can create false triggers. A grammar/phrase filter may reduce but cannot eliminate false acceptance. No Japanese keyword corpus experiment was run.

### C. Porcupine and other offline KWS

- Porcupine lists Japanese and iOS/Android/Windows targets, but model creation requires an AccessKey and remote model-generation workflow. It remains comparison-only; no account/key/contract/remote request was used.
- No other free, offline, Japanese 「ジャービス」 model with verified model-level license, redistribution permission and measured false-accept performance was established in this audit.

## 5. Android implementation feasibility

Technically feasible components:
- Kotlin local Expo module or native Android module.
- Native AudioRecord capture, on-device model inference and bounded event delivery.
- Microphone foreground service with the required service type/permissions and persistent notification on supported Android versions.
- Explicit visible start, visible stop, permission checks, audio-focus/interruption handling and idempotent teardown.

Not implemented / not proven:
- No Kotlin module, AudioRecord pipeline, sherpa/Vosk inference, model loading, custom foreground service, or notification stop action was added.
- Existing Expo Audio configuration requests recording/foreground-service permissions and background recording behavior, but that is not a verified wake-word service and has no integrated KWS inference.
- No Gradle build, Android SDK build, emulator/device test, lock-screen test, OEM battery test, reboot test or 30/60/120-minute soak test was run.
- Do not describe Android as supporting lock-screen wake-word activation.

## 6. iOS implementation feasibility

Technically feasible path:
- sherpa-onnx Swift package / XCFramework or C API, wrapped in a local Expo Swift module.
- AVAudioEngine input tap feeding native inference; only state, event, monotonic detection time and error code cross into React Native.
- AVAudioSession interruption and route-change notifications must stop or safely reinitialize the capture pipeline.

Constraints:
- Building sherpa-onnx iOS binaries requires macOS, Xcode and CMake.
- The current Expo config contains `UIBackgroundModes: ["audio"]` and microphone disclosure, but background audio mode is not a universal OS-level always-on hotword entitlement. App Review, user-visible microphone use, audio-session interruptions, force-quit and permission revocation remain limiting conditions.
- No Swift module, AVAudioEngine pipeline, iOS build, simulator run or physical-device test was performed.
- Vosk iOS build is available only on request according to its official install documentation; no request was sent.

## 7. React Native and privacy boundary

The existing adapter remains unchanged:
- Explicit user consent and OS microphone permission are required.
- Raw PCM/audio payloads are not forwarded to JavaScript by the current screen.
- The adapter exposes only the exact wake phrase event and timestamp; no audio property is forwarded.
- No wake event calls JARVIS API, LINE, Google Sheets, or any business task.
- No audio recording file, persistent audio, transcript, cloud audio upload, or remote inference was added.

## 8. Benchmark and physical-device evidence

No licensed audio corpus or consented speaker recordings were available. No physical devices were connected. Therefore all of the following remain **NOT MEASURED**:
- true positives, false positives, false negatives, true negatives
- Recall, False Acceptance Rate, false activations/hour
- mean detection latency
- CPU, RSS memory, battery consumption, thermal state
- speaker, speed, distance, noise, near-homophone, silence, offline/network-disconnect conditions
- Android 30/60/120-minute tests and iOS lifecycle/interruption tests

The current benchmark utility is a label/timestamp calculator tested with synthetic records; it does not perform acoustic recognition and its synthetic test values are not product performance measurements.

## 9. Windows and production impact

- Windows PWA/browser client remains unchanged. No Windows native recognizer or ARM64 claim is added.
- No LINE production change, Google Sheets production write, Neon production DDL/DML/migration, Render setting/deployment, billing change, paid SDK, API key, secret display, PR merge, force-push, rebase, or branch deletion was performed.
- No real audio was recorded or transmitted.

## 10. Stage 5 exit decision

**Partial / blocked.** The native architecture and integration feasibility are established at design level, the exact PR head CI passes, and the existing fail-closed adapter/benchmark contracts remain covered. The core user-visible requirement—real local recognition of 「ジャービス」 while locked or in another app—is not implemented or tested.

Next gates:
1. Obtain a Japanese KWS acoustic model with verifiable source, model hash, license, NOTICE and commercial redistribution rights; or authorize a separately budgeted, licensed model-training route.
2. Build a native Android proof with Kotlin + native capture + model inference and test it on a real Android device.
3. Build the iOS Swift module with sherpa-onnx on macOS/Xcode and test foreground/background/interruption behavior on a real iPhone.
4. Only after real audio corpus evaluation, publish measured precision/recall/false activations/latency and power/thermal metrics.
5. Keep all wake-word events local and inert until the separate employee-authentication and approval-gated action stages are independently complete.

## Official references

- sherpa-onnx KWS: https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- sherpa-onnx iOS Swift package: https://github.com/k2-fsa/sherpa-onnx/tree/master/ios-swiftui
- sherpa-onnx iOS build prerequisites: https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/ios/build-sherpa-onnx-swift.rst
- Vosk models: https://alphacephei.com/vosk/models
- Vosk install / Android Maven artifact / iOS build availability: https://alphacephei.com/vosk/install
- Vosk Android demo: https://alphacephei.com/vosk/android
- Expo Modules API: https://docs.expo.dev/modules/overview/
- Expo local native modules: https://docs.expo.dev/workflow/customizing/
- Apple AVAudioSession: https://developer.apple.com/documentation/AVFAudio/AVAudioSession
- Apple background execution modes: https://developer.apple.com/documentation/xcode/configuring-background-execution-modes
