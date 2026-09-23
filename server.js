const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = "gpt-5.6-luna";

async function getAIReply(userMessage) {
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content:
              "あなたは株式会社OneのLINE公式アカウントのAIアシスタントです。日本語で丁寧かつ分かりやすく回答してください。"
          },
          {
            role: "user",
            content: userMessage
          }
        ]
      })
    }
  );

  const data = await response.json();

  console.log("OpenAI status:", response.status);

  if (!response.ok) {
    console.error(
      "OpenAI API ERROR:",
      JSON.stringify(data)
    );
    throw new Error("OpenAI API error");
  }

  // Responses APIの回答本文を取得
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (
        item.type === "message" &&
        Array.isArray(item.content)
      ) {
        for (const content of item.content) {
          if (
            content.type === "output_text" &&
            typeof content.text === "string"
          ) {
            return content.text;
          }
        }
      }
    }
  }

  console.error(
    "AI text not found:",
    JSON.stringify(data)
  );

  return "申し訳ありません。回答を取得できませんでした。";
}


// LINE署名チェック
function verifySignature(body, signature) {
  if (!signature || !LINE_CHANNEL_SECRET) {
    return false;
  }

  const hash = crypto
    .createHmac(
      "sha256",
      LINE_CHANNEL_SECRET
    )
    .update(body)
    .digest("base64");

  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);

  // 長さが違う場合にtimingSafeEqualがエラーになるのを防ぐ
  if (hashBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    hashBuffer,
    signatureBuffer
  );
}


// LINEへ返信
async function replyToLINE(replyToken, text) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: [
          {
            type: "text",
            text: String(text).slice(0, 5000)
          }
        ]
      })
    }
  );

  const result = await response.text();

  console.log(
    "LINE reply status:",
    response.status
  );

  if (!response.ok) {
    console.error(
      "LINE reply error:",
      result
    );
  }
}


// Webサーバー
const server = http.createServer(
  (req, res) => {

    // 動作確認
    if (
      req.method === "GET" &&
      req.url === "/"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "text/plain; charset=utf-8"
      });

      res.end(
        "LINE AI Bot is running"
      );

      return;
    }

    // Webhook以外は404
    if (
      req.method !== "POST" ||
      req.url !== "/webhook"
    ) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    let body = "";

    req.on(
      "data",
      chunk => {
        body += chunk;
      }
    );

    req.on(
      "end",
      async () => {

        try {

          const signature =
            req.headers["x-line-signature"];

          // LINE署名確認
          if (
            !verifySignature(
              body,
              signature
            )
          ) {
            console.error(
              "Invalid LINE signature"
            );

            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }

          // LINEにはすぐOKを返す
          res.writeHead(200);
          res.end("OK");

          const data =
            JSON.parse(body);

          for (
            const event of data.events || []
          ) {

            // テキストメッセージ以外は無視
            if (
              event.type !== "message" ||
              !event.message ||
              event.message.type !== "text"
            ) {
              continue;
            }

            const userMessage =
              event.message.text;

            console.log(
              "LINE message:",
              userMessage
            );

            try {

              // OpenAIへ送信
              const aiReply =
                await getAIReply(
                  userMessage
                );

              console.log(
                "AI reply:",
                aiReply
              );

              // LINEへ返信
              await replyToLINE(
                event.replyToken,
                aiReply
              );

            } catch (error) {

              console.error(
                "AI processing error:",
                error
              );

              await replyToLINE(
                event.replyToken,
                "申し訳ありません。現在AIの回答を取得できません。"
              );
            }
          }

        } catch (error) {

          console.error(
            "Webhook error:",
            error
          );
        }
      }
    );
  }
);


// サーバー起動
server.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      "OpenAI model:",
      OPENAI_MODEL
    );
  }
);