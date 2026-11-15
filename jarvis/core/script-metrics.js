"use strict";
const TARGET_MINUTES=Object.freeze({min:8,max:12});
const JAPANESE_RATE=Object.freeze({slow:350,fast:420});
function extractSpokenText(script){
 if(typeof script!=="string")return "";
 const normalized=script.replace(/\r\n?/g,"\n");
 const startPatterns=[/^##\s*(?:Narration script|ナレーション原稿|ナレーション)\s*$/im,/^##\s*台本\s*$/im];
 let body=normalized;
 for(const pattern of startPatterns){const match=pattern.exec(normalized);if(match){body=normalized.slice(match.index+match[0].length);break;}}
 const end=/^##\s*(?:Pronunciation|Source register|Visual \/ edit plan|Final production gate|読み|出典|映像|最終確認|制作)/im.exec(body);
 if(end)body=body.slice(0,end.index);
 return body.split("\n").filter(line=>!/^\s*(?:#{1,6}\s|\|\s*[-:|]+\s*\||https?:\/\/)/.test(line)).join("\n").trim();
}
function createScriptMetrics(script,{charsPerMinuteSlow=JAPANESE_RATE.slow,charsPerMinuteFast=JAPANESE_RATE.fast}={}){
 if(!Number.isFinite(charsPerMinuteSlow)||!Number.isFinite(charsPerMinuteFast)||charsPerMinuteSlow<=0||charsPerMinuteFast<=0||charsPerMinuteSlow>charsPerMinuteFast)throw new Error("Invalid Japanese narration pace range");
 const spokenText=extractSpokenText(script);
 const characters=Array.from(spokenText.replace(/\s/g,"")).length;
 const minMinutes=characters/charsPerMinuteFast;
 const maxMinutes=characters/charsPerMinuteSlow;
 const status=characters===0?"missing_script":maxMinutes<TARGET_MINUTES.min?"too_short":minMinutes>TARGET_MINUTES.max?"too_long":minMinutes>=TARGET_MINUTES.min&&maxMinutes<=TARGET_MINUTES.max?"estimated_range_ok":"timing_review_required";
 return {
  characters,
  targetMinutes:{...TARGET_MINUTES},
  assumedCharactersPerMinute:{slow:charsPerMinuteSlow,fast:charsPerMinuteFast},
  estimatedMinutes:{min:Number(minMinutes.toFixed(1)),max:Number(maxMinutes.toFixed(1))},
  status,
  requiresRecordedTiming:true,
  note:"日本語の文字数からの概算です。読み手・間・映像尺で変わるため、録音後に実測してください。"
 };
}
module.exports={TARGET_MINUTES,JAPANESE_RATE,extractSpokenText,createScriptMetrics};
