const microphonePermission =
  "ONE JARVISは、ユーザーが明示的に音声待機を開始した場合に限り、端末内で「ジャービス」の呼びかけを検出するためマイクを使用します。待機中は画面とOS通知に状態を表示し、いつでも停止できます。音声データは原則端末内のメモリで処理し、保存・送信しません。";

module.exports = ({ config = {} } = {}) => ({
  ...config,
  name: "ONE JARVIS",
  slug: "one-jarvis-private",
  scheme: "onejarvis",
  version: "0.1.0",
  orientation: "default",
  userInterfaceStyle: "dark",
  platforms: ["ios", "android"],
  ios: {
    ...config.ios,
    supportsTablet: true,
    infoPlist: {
      ...(config.ios && config.ios.infoPlist ? config.ios.infoPlist : {}),
      NSMicrophoneUsageDescription: microphonePermission,
      UIBackgroundModes: ["audio"]
    }
  },
  android: {
    ...config.android,
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MICROPHONE",
      "android.permission.POST_NOTIFICATIONS"
    ]
  },
  plugins: [
    ...(config.plugins || []).filter((plugin) =>
      Array.isArray(plugin) ? plugin[0] !== "expo-audio" : plugin !== "expo-audio"
    ),
    [
      "expo-audio",
      {
        microphonePermission,
        recordAudioAndroid: true,
        enableBackgroundRecording: true,
        enableBackgroundPlayback: false
      }
    ]
  ],
  extra: {
    ...(config.extra || {}),
    oneJarvis: {
      nativeAudioStage: 2,
      wakeWord: "ジャービス",
      localOnlyCapture: true,
      cloudWakeWordDetection: false
    }
  }
});
