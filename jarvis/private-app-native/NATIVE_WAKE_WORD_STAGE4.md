# ONE JARVIS — Stage 4 Japanese wake-word feasibility and implementation record

Date: 2026-11-28
Repository: miyamotosakuya0427-png/line-ai-bot
PR: #88 (Draft; do not merge)
Scope: Japanese model feasibility, fail-closed model integrity/licensing gate, duplicate event suppression and CI coverage. No production integration.

## Executive decision

**No model is approved or bundled in this stage. No native microphone/KWS implementation is claimed.**

The current open-source candidates do not yet satisfy all gates at once: Japanese 「ジャービス」, publicly buildable iOS and Android native integration, offline operation, commercial redistribution rights, and validated wake-word false-accept/miss performance on target devices.

### Candidate comparison

| Candidate | Japanese evidence | Native/platform evidence | License / commercial / redistribution | Stage 4 decision |
|---|---|---|---|---|
| sherpa-onnx KWS | Open-vocabulary KWS can accept user-specified keyword strings without retraining, but the official pretrained KWS list currently shows Chinese/English models only. A Japanese acoustic model and tokenization path have not been validated for 「ジャービス」. | Project offers native APIs and platform builds including iOS/Android/Windows; actual app integration/build not performed. | Runtime project Apache-2.0; each model/weights/tokenizer asset needs separate license and redistribution review. | Keep as preferred research runtime, but do not ship a model or claim Japanese support without a Japanese acoustic model and corpus evaluation. |
| Vosk small Japanese ASR | Official model catalogue lists vosk-model-small-ja-0.22 (48 MB) and vosk-model-ja-0.22 (1 GB), both listed Apache-2.0. Catalogue reports CER 9.52 (CSJ) / 17.07 (TED10k) for the small model. These are ASR corpus metrics, **not** wake-word precision/false-accept metrics. | Vosk advertises offline Android/iOS. Android artifact is documented via Maven Central. Its iOS build is documented as available on request; this is not a public drop-in iOS SDK. Windows x86/x64 is supported for its documented Python installation; Windows ARM64 is not. | Runtime and listed Japanese models are shown as Apache-2.0. Model redistribution still requires checking the actual archive's included notices and provenance before bundling. | Useful Android/desktop ASR-based research fallback, but not selected as cross-platform KWS because iOS delivery is gated and streaming ASR is not a dedicated low-power wake-word detector. |
| Picovoice Porcupine | Japanese is listed as a supported language in its model API. | iOS, Android, Windows are listed as model targets. | Model training API requires AccessKey and a remote request to Picovoice. Current terms reserve IP, make use subject to applicable fees/agreements, permit revocable/non-transferable rights, and restrict redistribution/sublicensing; free trial is limited and revocable. | Not used. No account, key, model training request, SDK contract, paid service or remote model generation was performed. |
| openWakeWord / community KWS | No first-party Japanese model with verified licensing and performance for this keyword was established in this audit. | Platform coverage varies by project/fork. | Model and training-data terms vary; each artifact needs review. | Not selected. |

### Source evidence

- sherpa-onnx KWS supports open-vocabulary keyword strings and exposes trigger/boosting thresholds; official pretrained examples are Chinese/English: https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- Vosk offline/mobile and streaming capabilities: https://alphacephei.com/vosk/
- Vosk Japanese model sizes, CER and model licenses: https://alphacephei.com/vosk/models
- Vosk Android Maven dependency and iOS build availability on request: https://alphacephei.com/vosk/install
- Porcupine Model API requires AccessKey and remote model generation; Japanese and iOS/Android/Windows are listed: https://picovoice.ai/docs/model-api/porcupine/
- Picovoice terms effective 2026-03-30: https://picovoice.ai/docs/terms-of-use/
- Expo Modules API local native module guidance: https://docs.expo.dev/modules/overview/ and https://docs.expo.dev/modules/get-started/

No candidate was benchmarked on physical devices in this stage. No false-accept, recall, latency, CPU, RAM, battery or thermal value is inferred from general model/ASR metrics.

## Implemented in this stage

1. wake-word-model-manifest.js
   - Validates the exact keyword, model ID, engine, relative model path, SHA-256, model/runtime license declarations, commercial-use and redistribution approvals, and license evidence.
   - Resolves real filesystem paths and rejects traversal/symlink escapes.
   - Hashes the actual model file and rejects mismatches.
   - Returns a verified descriptor only after all checks pass.
   - This verifies supplied evidence and bytes; it does not independently determine whether a license statement is legally correct. Human legal review remains required.

2. wake-word-model-manifest.test.js
   - Uses synthetic non-audio fixture bytes only.
   - Covers successful integrity verification, tampered bytes, unapproved redistribution, path traversal, wrong keyword and malformed hash.
   - No model/audio corpus is downloaded or committed.

3. wake-word-engine.js
   - Adds a configurable duplicate-event cooldown (default 1500 ms).
   - Keeps the fail-closed behavior; no native module/model means no listening start.

4. wake-word-engine.test.js
   - Covers duplicate event suppression and invalid cooldown settings.

5. package.json
   - Adds an isolated npm test command for the native-app contract tests.

6. .github/workflows/jarvis-tests.yml
   - Adds a separate CI job to run the private native app's Node contract tests without installing or building native SDKs.

## Model and artifact status

- No Japanese wake-word model is bundled.
- No model SHA-256 is reported because no model artifact has been approved or downloaded.
- No audio data or speaker recordings are committed.
- The manifest verifier is tested against synthetic bytes, not a real ONNX/Vosk/Porcupine model.
- Model licensing metadata is a gate; a manifest cannot replace legal review of the actual model archive and all notices.

## Native / OS status

- iOS/iPadOS: no Swift KWS/audio capture module added; no Xcode build or device validation. Vosk iOS package is available on request according to its installation page; no request was made.
- Android: no Kotlin KWS/audio capture module added; no Gradle build or device validation. Vosk Android is a possible future experiment, not an adopted engine.
- React Native: existing adapter retained; it accepts only a native event and never receives PCM.
- Windows: existing PWA unchanged.
- No native model inference, microphone background test, 30/60/120-minute soak test, battery or thermal test is claimed.

## Security and production impact

- No audio recording, audio file storage, cloud audio upload or wake-triggered task execution was added.
- No AccessKey, API token or paid service was obtained or used.
- No LINE production, Google Sheets production data, Neon production DDL/DML/migration, Render configuration/deployment, billing, PR merge, force-push or branch deletion was performed.

## Exit status

**Partial / blocked on a legally cleared Japanese KWS model and buildable native runtimes.**

The new model-integrity gate and duplicate suppression are implemented. The actual Japanese wake-word detector is not implemented. Do not describe the app as recognizing 「ジャービス」 until the model is integrated and the physical-device benchmark passes.
