"use strict";

function createOpenAIHandler({ apiKey = process.env.OPENAI_API_KEY || "", model = process.env.JARVIS_OPENAI_MODEL || "gpt-5.6-luna", fetchImpl = fetch } = {}) {
  return async function handleAssistantRequest(payload) {
    if (!apiKey) throw new Error("OpenAI API is not configured");
    const request = typeof payload?.request === "string" ? payload.request.trim() : "";
    if (!request || request.length > 4000) throw new Error("Invalid assistant request");
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        instructions: "あなたは株式会社Oneの業務アシスタントJARVISです。日本語で簡潔かつ正確に回答してください。確認できない情報を事実のように述べず、実行していない操作を完了したと主張しないでください。外部システムの変更、送信、購入、予約、削除などは、明示的な承認なしに実行したと主張してはいけません。この処理では回答文の作成だけを行い、外部操作は行いません。",
        input: request,
        max_output_tokens: 1200
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const error = new Error("OpenAI request failed with status " + response.status);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    const data = await response.json();
    let answer = typeof data.output_text === "string" ? data.output_text : "";
    if (!answer && Array.isArray(data.output)) {
      answer = data.output.flatMap(item => Array.isArray(item.content) ? item.content : [])
        .filter(item => item.type === "output_text" && typeof item.text === "string")
        .map(item => item.text).join("\n");
    }
    answer = answer.trim();
    if (!answer) throw new Error("OpenAI returned an empty response");
    return { answer: answer.slice(0, 12000), model, responseId: typeof data.id === "string" ? data.id : null };
  };
}

module.exports = { createOpenAIHandler };
