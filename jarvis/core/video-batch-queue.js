"use strict";

function buildVideoPlanRequest(video) {
  if (!video || typeof video.id !== "string" || !/^V[0-9]{2,8}$/.test(video.id)) {
    throw new Error("A valid video plan is required");
  }
  return [
    "ONE CONTENT 動画企画・台本下書きタスクです。",
    "動画ID：" + video.id,
    "チャンネル：" + (video.channelId === "history" ? "時をかける日本史" : "金融・投資解説（公開先未設定・公開禁止）"),
    "タイトル案：" + video.title,
    "テーマ：" + video.topic,
    "形式：" + video.format,
    "目標尺：日本史チャンネルは8〜12分。内容に応じて構成と想定文字数を示す。",
    video.script ? "既存台本案：\n" + video.script : "既存台本はありません。構成とナレーション原稿の初稿を作成してください。",
    "必須成果物：企画意図・視聴者像・冒頭フック・章立て・ナレーション原稿・字幕用テキスト・難読漢字/固有名詞の読み一覧・出典候補一覧（実在を確認できるURLのみ）・映像素材案・編集指示・タイトル/説明文案・未解決事項。",
    "重要：この実行環境で一次資料の本文を実際に閲覧していない場合、史実・年号・人物・金額を『検証済み』と書かない。各主張に『要一次資料確認』を付け、出典URLを捏造しない。既知の出典候補と確認済み事実を明確に分ける。",
    "YouTube収益化方針：各動画に固有の調査・論点・ナラティブ・独自解説・教育的価値を持たせる。題材名だけを差し替えたテンプレ大量生産や、他サイトの文章を読むだけの動画にしない。公式方針：https://support.google.com/youtube/answer/1311392?hl=ja",
    "AI開示方針：AIによる台本・構成・タイトル・サムネイル補助だけなら通常開示不要。一方、実在人物を偽装する、実在の場所や出来事に見える写実的なAI映像を生成・改変する、主題となるAI生成音楽を使う場合は投稿時の開示要否を確認する。再現映像を実際の記録映像として示さない。公式方針：https://support.google.com/youtube/answer/14328491?hl=ja",
    "禁止：有料音声/動画生成、外部アップロード、予約投稿、YouTube公開、購入、契約。台本・企画の下書きだけを作成し、外部操作は行わない。"
  ].join("\n");
}

async function enqueueVideoBatchPlans({ videoBatchStore, jobStore, batchId = null } = {}) {
  if (!videoBatchStore || typeof videoBatchStore.list !== "function" || !jobStore || typeof jobStore.create !== "function") {
    throw new Error("Persistent video and job stores are required");
  }
  if (batchId !== null && (typeof batchId !== "string" || !/^B-[0-9a-f-]{36}$/i.test(batchId))) {
    throw new Error("Invalid video batch ID");
  }
  const all = await videoBatchStore.list({ limit: 200 });
  const eligible = all.filter(video =>
    video.status === "planned" &&
    video.stage === "research" &&
    video.channelId === "history" &&
    (!batchId || video.batchId === batchId)
  );
  if (eligible.length > 100) throw new Error("A single enqueue operation is limited to 100 videos");
  const queued = [];
  const existing = [];
  const failed = [];
  for (const video of eligible) {
    try {
      const result = await jobStore.create({
        type: "department.content",
        payload: {
          request: buildVideoPlanRequest(video),
          departmentId: "content",
          videoId: video.id,
          taskKind: "video-batch-plan"
        },
        idempotencyKey: "video-batch-plan-" + video.id
      });
      (result.created ? queued : existing).push({ videoId: video.id, job: result.job });
    } catch (error) {
      failed.push({ videoId: video.id, error: String(error && error.message || "Queue failed").slice(0, 300) });
    }
  }
  return {
    selected: eligible.length,
    queued,
    existing,
    failed,
    externalActionsEnabled: false
  };
}

module.exports = { buildVideoPlanRequest, enqueueVideoBatchPlans };
