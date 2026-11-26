# ONE JARVIS — Stage 3 wake-word engine decision

Date: 2026-11-26
Repository: miyamotosakuya0427-png/line-ai-bot
Scope: offline wake-word engine selection, safe adapter contract and benchmark harness. No production integration.

## Decision

**No inference engine is approved for production integration yet.** The native adapter contract and privacy-safe benchmark harness are implemented, but the model gate remains closed.

## Candidate comparison

| Candidate | Japanese 「ジャービス」 | iOS / Android / Windows | License and model | Decision |
|---|---|---|---|---|
| sherpa-onnx | KWS API exists, but official KWS model catalogue shows Chinese/English pretrained examples; no validated Japanese KWS model for this phrase found | Project supports iOS, Android and Windows; C/C++ APIs | Runtime Apache-2.0. Each model/weights asset needs its own license and redistribution review | Preferred no-cost research candidate; do not ship before a Japanese model is trained/evaluated and rights checked |
| Picovoice Porcupine | Japanese language is supported; custom phrase training documented | iOS, Android, Windows supported | Proprietary SDK integration uses AccessKey; model creation/download uses authenticated service. Contract/pricing and redistribution terms need review | Best documented Japanese fit; not used because no key, account, contract or paid service was authorized |
| PocketSphinx / Vosk | Not selected; no verified Japanese custom wake-word model for this phrase established in this assessment | Bindings vary | Separate model and SDK review required | Not preferred |

Evidence:
- sherpa-onnx KWS API and models: https://k2-fsa.github.io/sherpa/onnx/c-api/html/keyword_spotting.html and https://k2-fsa.github.io/sherpa/onnx/kws/index.html
- sherpa-onnx runtime license/platforms: https://github.com/k2-fsa/sherpa-onnx
- Porcupine language support: https://picovoice.ai/docs/faq/porcupine/
- Porcupine Model API requires AccessKey: https://picovoice.ai/docs/model-api/porcupine/

No public evidence supports numeric accuracy, false-accept, latency, CPU, memory, battery or thermal claims for target devices. No such values are fabricated.

## Implemented

- wake-word-engine.js: fail-closed native engine boundary. Requires explicit consent, OS permission, native module and verified/licensed model manifest. It does not emulate recognition in JavaScript.
- wake-word-benchmark.js: computes recall, false acceptance rate, false activations/hour and mean detection latency from labels/timestamps only; it does not accept or store raw audio.
- wake-word-engine.test.js: lifecycle, consent, permission, missing-model, event filtering, stop and benchmark tests.
- This decision record.

## Critical integration boundary

Stage 2 Expo Audio useAudioStream callback delivers PCM to JavaScript. Feeding a continuous microphone stream through the JS bridge is not accepted as the final architecture because it increases bridge/CPU overhead and cannot guarantee inference continuity when JS is suspended.

Final architecture must place microphone capture and KWS inference in Swift/Kotlin/C++, exposing only state and a timestamped detection event to React Native. Native module must release audio resources on explicit stop, logout, permission revocation and audio-session failure.

No native KWS implementation or model is included because no verified Japanese model has passed licensing/accuracy gates. The adapter intentionally fails closed rather than pretending it detected the wake word.

## Benchmark protocol

- Build a licensed corpus with consented speakers and negative utterances, including phonetic near-misses.
- Keep labels, trial IDs and monotonic timestamps; do not commit audio samples or speaker identities.
- Report TP, FN, FP, TN, recall, false acceptance rate, false activations/hour and mean detection latency.
- Run offline and verify network-disabled operation.
- Measure CPU, RSS memory, battery and thermal state on target devices over fixed durations.
- No physical-device measurements were available during this GitHub-only stage.

## Platform / production status

- iOS/iPadOS: no native model integration or device validation.
- Android: no native model integration or device validation.
- Windows: unchanged; existing PWA retained.
- No Expo prebuild, Xcode/Gradle build, physical-device test, paid SDK, model download, AccessKey, audio upload or cloud inference was performed.
- No Render, Neon, LINE, Google Sheets, deployment, production DB, billing or store publication change was performed.

## Exit status

**Partial / blocked on model and native module integration.** Adapter and benchmark tests are ready; actual Japanese wake-word recognizer is not implemented. Do not advertise 「ジャービス」 detection or lock-screen wake-word operation until native builds and physical-device benchmarks pass.
