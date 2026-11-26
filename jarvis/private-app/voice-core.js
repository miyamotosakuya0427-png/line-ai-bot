(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  if(root)root.OneJarvisVoice=api;
})(typeof globalThis!=="undefined"?globalThis:null,function(){
  "use strict";
  const WAKE_WORDS=["ジャービス","jarvis"];
  function normalizeTranscript(value){
    return String(value||"").normalize("NFKC").toLocaleLowerCase("ja-JP")
      .replace(/[、。,.!?！？:：;；]/g," ").replace(/\s+/g," ").trim();
  }
  function extractWakeCommand(transcript,wakeWords=WAKE_WORDS){
    const normalized=normalizeTranscript(transcript);
    for(const word of wakeWords){
      const needle=normalizeTranscript(word);
      const index=normalized.indexOf(needle);
      if(index>=0)return Object.freeze({wakeDetected:true,command:normalized.slice(index+needle.length).trim(),matchedWord:word});
    }
    return Object.freeze({wakeDetected:false,command:"",matchedWord:null});
  }
  function getSpeechRecognitionConstructor(scope){
    if(!scope||typeof scope!=="object")return null;
    return scope.SpeechRecognition||scope.webkitSpeechRecognition||null;
  }
  return Object.freeze({WAKE_WORDS,normalizeTranscript,extractWakeCommand,getSpeechRecognitionConstructor});
});
