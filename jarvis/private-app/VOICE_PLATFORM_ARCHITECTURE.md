# ONE JARVIS Private App — Voice Platform Architecture (Decision Record)

Status: proposed implementation baseline; no native application or production configuration is enabled by this document.
Date: 2026-11-26
Parent work: private-app Stage 1 PWA shell / PR #88

## 1. Owner-selected requirements

- Voice mode: B — the user wants to say 「ジャービス」 while the phone is locked or another app is active.
- Delivery: complete product, not a quick PWA-only release.
- Targets: iPhone, iPad, Android phones/tablets, and Windows.
- Privacy: employee-only access; explicit microphone consent; local wake-word detection; no silent audio upload or raw-audio retention.
- Existing ONE JARVIS GitHub / Render / Neon architecture remains the source of truth.
- Existing LINE production, Google Sheets, Neon production, Render production configuration, and billing must remain unchanged during development.

## 2. Architecture decision

Use a shared React Native + Expo application with native builds for iOS and Android, plus a Windows desktop/browser client sharing the same authenticated API contract and visual design system.

The current PWA remains a browser-accessible fallback and UI prototype. It is not the implementation of locked-screen wake-word listening.

Proposed layers:

1. Shared app UI and navigation: React Native / Expo.
2. Native audio capture: platform-specific audio session and recording service.
3. Local wake-word engine: a replaceable native adapter. Benchmark offline engines (for example, sherpa-onnx or a licensed engine) using Japanese 「ジャービス」 samples before selecting one. Do not transmit continuous audio to a cloud speech service for wake-word detection.
4. Speech recognition: local-first where accuracy is acceptable; authenticated server transcription/assistant request only after wake word and explicit user interaction/consent. Any cloud provider requires separate privacy/cost review.
5. JARVIS integration: server-side authenticated session and API adapter. No API keys, Owner tokens, database credentials, or long-lived bearer tokens in app storage.
6. Voice response: native audio output with interruption/stop controls.
7. Windows: shared API and UI behavior, with desktop microphone permission and a visible tray/running state where supported. Do not claim background wake word after the desktop process has exited.

## 3. Platform feasibility and hard limits

### iOS / iPadOS

- A native app can request microphone access and use a supported background audio-recording configuration, but this is not equivalent to an OS-level always-on hotword entitlement.
- Background microphone operation must be a core, clearly disclosed feature, explicitly enabled by the user, visibly indicated, and reviewed against current App Store rules. Background modes may only be used for their intended purposes.
- The app must provide an obvious stop/pause control, privacy explanation, microphone state indicator, and battery-use disclosure.
- User force-quit, OS termination, permission revocation, low-memory behavior, calls/audio-session interruptions, and OS updates can stop listening. Do not promise wake-word operation after force-quit or guaranteed operation after reboot.
- If App Review or device testing does not permit the required background listening behavior, provide a supported fallback: app open, lock-screen/notification action, Shortcuts/App Intents where available, or a hardware action. Do not bypass iOS restrictions.

### Android

- A microphone foreground service may continue recording with an ongoing notification and the required microphone service type/permissions.
- The service must be started while the app is visible unless a documented OS exemption applies. A background app cannot freely start a microphone foreground service.
- Android 14+ requires the microphone foreground-service type and permission; RECORD_AUDIO remains subject to while-in-use restrictions.
- Force-stop, user termination, permission revocation, battery optimization, OEM background restrictions, and reboot may stop listening. No silent restart or hidden microphone behavior.
- Provide persistent notification, one-tap stop, battery-use guidance, and device-specific acceptance testing.

### Windows

- Provide a Windows desktop/PWA client with explicit microphone permission and a visible listening state.
- Background wake-word support is conditional on a running desktop process, Windows microphone privacy settings, audio-device availability, and packaging/runtime behavior.
- Do not promise listening while the application is fully exited, Windows is sleeping, or microphone access is disabled.
- Validate tray/minimize behavior and Windows startup behavior separately; automatic startup must be opt-in.

## 4. Consent, security, and privacy requirements

- Wake-word detection runs locally; raw audio is processed in memory and is not written to disk by default.
- No audio upload before local wake-word detection. After wake, show/listen indication and use a bounded capture window.
- No hidden/continuous server-side recording. Do not retain raw audio unless the Owner separately approves a documented retention policy.
- Microphone permission must be requested only after an explanatory screen and explicit action.
- Provide a persistent visible state and a reliable stop action on every platform.
- App lock/logout immediately stops capture and clears in-memory audio buffers.
- Authenticated API uses secure, revocable server sessions; browser/app storage never contains service secrets or Owner credentials.
- Role checks happen server-side on every protected request. Client UI visibility is not authorization.
- Every consequential external action remains approval-gated and auditable.

## 5. Acceptance matrix

A platform is not marked complete until tested on physical devices, not just simulators or automated unit tests.

| Scenario | iOS/iPadOS | Android | Windows |
|---|---|---|---|
| App foreground, wake phrase | Required | Required | Required |
| Screen locked / another app active | Required, subject to Apple policy/device validation | Required with foreground-service notification | Required only while desktop process is running |
| App force-quit / force-stopped | Must stop; disclose limitation | Must stop; disclose limitation | Must stop when process exits |
| Microphone permission revoked | Stop and fail closed | Stop and fail closed | Stop and fail closed |
| Incoming call / audio interruption | Stop or recover safely | Stop or recover safely | Handle device/audio interruption |
| Battery / thermal soak | Measure | Measure across OEM devices | Measure |
| Network unavailable | Wake detection remains local; explain AI unavailable | Same | Same |
| Logout / session revocation | Stop mic and reject API | Same | Same |
| Cross-user / role isolation | Required | Required | Required |

Required device evidence: OS/version, app build, permission state, screen state, test duration, wake false-positive/false-negative counts, battery delta, thermal state, crash/ANR logs, and redacted API outcomes. Do not include audio samples or secrets in CI artifacts.

## 6. Delivery sequence

1. Stage 2 — identity and secure session integration design/implementation, isolated tests only. Existing Owner OIDC primitives and LINE identity verification must be reused only after verifying their exact contracts. Do not configure a live IdP or modify production environment variables.
2. Stage 3 — native app workspace and platform capability spike: Expo prebuild/dev builds, audio permission UX, foreground/background audio proof, local wake-engine interface, no JARVIS API connection yet.
3. Stage 4 — local wake-word benchmark and native integration. Japanese 「ジャービス」 accuracy, false activations, battery and privacy gates.
4. Stage 5 — authenticated JARVIS conversation adapter, speech recognition, text/audio response, server-side roles and approval-gated actions.
5. Stage 6 — Windows client and cross-platform design parity.
6. Stage 7 — physical-device matrix, security review, accessibility, privacy disclosures, crash/battery/thermal testing.
7. Stage 8 — release packaging and publication readiness. Publishing, store submission, DNS, Render deployment, production DB changes, and billing require separate explicit approval.

## 7. No-go conditions

- Do not use a PWA-only implementation to claim locked-screen wake-word support.
- Do not upload always-on microphone audio to a third party for keyword spotting.
- Do not bypass OS microphone permission, background execution, foreground-service, or App Store review requirements.
- Do not enable a paid wake-word or speech API without approval.
- Do not create a second database or duplicate JARVIS backend.
- Do not deploy, publish, merge, apply production migrations, modify Render settings, write to production Sheets, or change billing under this stage.

## 8. Current state

- Stage 1 PWA shell exists in PR #88 and remains Draft/unmerged.
- The PWA intentionally stops listening when hidden; it does not implement locked-screen listening.
- This decision record is a design baseline only. It does not prove native background audio, local wake-word accuracy, App Store acceptance, Android OEM reliability, or physical-device behavior.
