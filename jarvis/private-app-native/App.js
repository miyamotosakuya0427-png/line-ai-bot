import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream
} from "expo-audio";
import { canStartListening } from "./audio-policy";

export default function App() {
  const [status, setStatus] = useState("停止中");
  const [consent, setConsent] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [busy, setBusy] = useState(false);

  // Deliberately omit onBuffer: continuous PCM must not cross into JavaScript.
  // Native capture remains a Stage 2 capability test; no KWS model is bundled.
  const { stream, isStreaming } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: "int16"
  });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => () => {
    try { stream.stop(); } catch (_) {}
  }, [stream]);

  const stopListening = useCallback(async (reason = "停止しました") => {
    try { stream.stop(); } catch (_) {}
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        allowsBackgroundRecording: false
      });
    } catch (_) {}
    setStatus(reason);
  }, [stream]);

  const startListening = useCallback(async () => {
    if (busy || isStreaming) return;
    setBusy(true);
    try {
      // Permission prompt is only reached after the explicit consent checkbox and button.
      const result = await requestRecordingPermissionsAsync();
      if (!canStartListening({
        platform: require("react-native").Platform.OS,
        explicitConsent: consent,
        permissionGranted: Boolean(result.granted)
      })) {
        setStatus(result.granted ? "同意が必要です" : "マイク権限がありません");
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        allowsBackgroundRecording: true,
        interruptionMode: "doNotMix"
      });
      await stream.start();
      setStatus("マイク動作テスト中（ネイティブ取得・PCM非転送）");
    } catch (_) {
      setStatus("音声を開始できません。権限・端末状態を確認してください");
      try { stream.stop(); } catch (_) {}
    } finally {
      setBusy(false);
    }
  }, [busy, consent, isStreaming, stream]);

  const finishSession = useCallback(async () => {
    await stopListening("セッションを終了しました");
    setConsent(false);
  }, [stopListening]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <Text style={styles.eyebrow}>PRIVATE COMPANY ASSISTANT</Text>
        <Text style={styles.title}>ONE JARVIS</Text>
        <Text style={styles.subtitle}>ネイティブ音声基盤・第2工程／第3工程準備</Text>

        <View style={styles.panel}>
          <View style={styles.row}>
            <View style={[styles.dot, isStreaming ? styles.activeDot : styles.idleDot]} />
            <Text style={styles.status}>{status}</Text>
          </View>
          <Text style={styles.note}>
            {isStreaming
              ? "マイク使用中です。停止ボタンでいつでも終了できます。"
              : "音声待機は初期状態で停止しています。"}
          </Text>
          <Text style={styles.meta}>アプリ状態: {appState} ／ 音声取得: {isStreaming ? "稼働" : "停止"}</Text>
        </View>

        <View style={styles.consentPanel}>
          <Text style={styles.sectionTitle}>マイク利用について</Text>
          <Text style={styles.note}>
            同意後、OSのマイク権限を要求します。音声取得はネイティブ側で行い、連続PCMをJavaScriptへ転送しません。
            この試作には「ジャービス」を判定するウェイクワードモデルはまだ組み込まれていません。
            音声ファイルの保存やクラウド送信は行いません。
          </Text>
          <TouchableOpacity
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent }}
            style={styles.checkRow}
            onPress={() => setConsent((value) => !value)}
            disabled={isStreaming}
          >
            <Text style={styles.checkbox}>{consent ? "☑" : "□"}</Text>
            <Text style={styles.checkText}>マイクを使用することに同意します</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.button, (!consent || isStreaming || busy) && styles.disabled]}
          onPress={startListening}
          disabled={!consent || isStreaming || busy}
        >
          {busy ? <ActivityIndicator color="#071321" /> : <Text style={styles.buttonText}>音声取得テストを開始</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.stopButton, !isStreaming && styles.disabledStop]}
          onPress={() => stopListening("手動で停止しました")}
          disabled={!isStreaming}
        >
          <Text style={styles.stopText}>マイクを停止</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.logoutButton} onPress={finishSession}>
          <Text style={styles.logoutText}>セッション終了（試作）</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          画面ロック・バックグラウンドでの継続は開発ビルドと実機で別途検証が必要です。
          強制終了・権限取消・OSによる停止後の自動再開は行いません。
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#071321" },
  container: { flex: 1, padding: 24, justifyContent: "center", gap: 18 },
  eyebrow: { color: "#74c7d4", letterSpacing: 2, fontSize: 11, fontWeight: "700" },
  title: { color: "#f4f8fc", fontSize: 34, fontWeight: "800" },
  subtitle: { color: "#9db0c3", fontSize: 14 },
  panel: { backgroundColor: "#102338", padding: 18, borderRadius: 18, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 8 },
  activeDot: { backgroundColor: "#e2a84d" },
  idleDot: { backgroundColor: "#63768a" },
  status: { color: "#f4f8fc", fontSize: 16, fontWeight: "700" },
  note: { color: "#b7c6d4", fontSize: 13, lineHeight: 20 },
  meta: { color: "#8fa4b8", fontSize: 11 },
  consentPanel: { gap: 10 },
  sectionTitle: { color: "#f4f8fc", fontWeight: "700", fontSize: 15 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  checkbox: { color: "#65c7d2", fontSize: 22 },
  checkText: { color: "#f4f8fc", fontSize: 13 },
  button: { backgroundColor: "#65c7d2", padding: 16, borderRadius: 12, alignItems: "center" },
  disabled: { opacity: 0.35 },
  buttonText: { color: "#071321", fontWeight: "800" },
  stopButton: { borderWidth: 1, borderColor: "#e27676", padding: 15, borderRadius: 12, alignItems: "center" },
  disabledStop: { opacity: 0.3 },
  stopText: { color: "#ffaaaa", fontWeight: "700" },
  logoutButton: { padding: 10, alignItems: "center" },
  logoutText: { color: "#9db0c3", fontSize: 12 },
  footer: { color: "#71869b", fontSize: 11, lineHeight: 17, textAlign: "center" }
});
