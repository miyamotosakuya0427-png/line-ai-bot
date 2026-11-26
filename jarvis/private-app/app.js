(function(){
  "use strict";
  const $=id=>document.getElementById(id);
  const Voice=window.OneJarvisVoice;
  if(!Voice)return;
  const startButton=$("voice-start"),stopButton=$("voice-stop"),voiceStatus=$("voice-status");
  const voiceState=$("voice-state"),draft=$("command-draft"),previewButton=$("preview-command");
  let recognition=null,listening=false,wakeArmed=false,wakeTimer=null,installPrompt=null;
  function setStatus(message,state){voiceStatus.textContent=message;voiceState.textContent=state||"待機中";}
  function speak(message){
    if(!("speechSynthesis" in window)||!("SpeechSynthesisUtterance" in window))return;
    window.speechSynthesis.cancel();
    const utterance=new SpeechSynthesisUtterance(message);
    utterance.lang="ja-JP";utterance.rate=1;utterance.pitch=1;
    window.speechSynthesis.speak(utterance);
  }
  function clearWakeArm(){wakeArmed=false;if(wakeTimer)window.clearTimeout(wakeTimer);wakeTimer=null;}
  function stopListening(){
    listening=false;clearWakeArm();
    if(recognition){try{recognition.stop()}catch{}}
    startButton.disabled=false;stopButton.disabled=true;
    setStatus("音声認識を停止しました。","停止");
  }
  function handleFinalTranscript(transcript){
    const result=Voice.extractWakeCommand(transcript);
    if(result.wakeDetected){
      if(result.command){
        clearWakeArm();draft.value=result.command;
        setStatus("「ジャービス」への指示を認識しました。内容を確認してください。","指示を認識");
        speak("指示を受け付けました。現在はアプリの認証・AI接続を準備中です。");
      }else{
        wakeArmed=true;if(wakeTimer)window.clearTimeout(wakeTimer);
        wakeTimer=window.setTimeout(clearWakeArm,10000);
        setStatus("はい。ご用件をどうぞ。10秒以内に続けて話してください。","呼びかけを認識");
        speak("はい。ご用件をどうぞ。");
      }
      return;
    }
    if(wakeArmed){
      clearWakeArm();draft.value=transcript.trim();
      setStatus("音声指示を認識しました。AI接続前のため送信は行いません。","指示を認識");
      speak("音声を認識しました。AI接続は認証機能の完成後に有効になります。");
    }
  }
  function startListening(){
    const Recognition=Voice.getSpeechRecognitionConstructor(window);
    if(!Recognition){setStatus("このブラウザは音声認識に対応していません。文字入力をご利用ください。","非対応");return;}
    if(!recognition){
      recognition=new Recognition();
      recognition.lang="ja-JP";recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=1;
      recognition.onresult=event=>{
        for(let i=event.resultIndex;i<event.results.length;i++){
          const item=event.results[i];
          if(item.isFinal&&item[0]&&item[0].transcript)handleFinalTranscript(item[0].transcript);
        }
      };
      recognition.onerror=event=>{
        const messages={"not-allowed":"マイクの使用が許可されていません。ブラウザ設定をご確認ください。","audio-capture":"マイクが見つかりません。","network":"音声認識サービスに接続できません。"};
        setStatus(messages[event.error]||"音声認識でエラーが発生しました。","エラー");
        if(event.error==="not-allowed"||event.error==="service-not-allowed")stopListening();
      };
      recognition.onend=()=>{
        if(listening){
          try{recognition.start()}catch{
            listening=false;startButton.disabled=false;stopButton.disabled=true;
            setStatus("音声認識が終了しました。再度開始してください。","停止");
          }
        }
      };
    }
    listening=true;startButton.disabled=true;stopButton.disabled=false;
    setStatus("マイクを使用中です。「ジャービス」と呼びかけてください。","聞き取り中");
    try{recognition.start()}catch{
      listening=false;startButton.disabled=false;stopButton.disabled=true;
      setStatus("音声認識を開始できませんでした。少し待って再試行してください。","開始失敗");
    }
  }
  startButton.addEventListener("click",startListening);
  stopButton.addEventListener("click",stopListening);
  previewButton.addEventListener("click",()=>{
    if(!draft.value.trim()){setStatus("先に音声または文字で指示を入力してください。","入力待ち");return;}
    setStatus("指示案を画面内で確認しました。外部送信・AI実行は行っていません。","確認済み");
  });
  document.addEventListener("visibilitychange",()=>{if(document.hidden&&listening)stopListening();});
  window.addEventListener("pagehide",()=>{if(listening)stopListening();});
  window.addEventListener("beforeinstallprompt",event=>{
    event.preventDefault();installPrompt=event;
    const button=$("install-button");button.hidden=false;
    button.addEventListener("click",async()=>{
      if(!installPrompt)return;
      installPrompt.prompt();await installPrompt.userChoice;
      installPrompt=null;button.hidden=true;
    },{once:true});
  });
  if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("./service-worker.js",{scope:"./"}).catch(()=>{});
  if(!Voice.getSpeechRecognitionConstructor(window)){
    startButton.disabled=true;
    setStatus("このブラウザでは音声認識を利用できません。文字入力は利用できます。","文字入力モード");
  }
})();
