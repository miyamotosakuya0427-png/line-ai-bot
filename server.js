async function getLineProfile(userId, source) {
  if (!userId || !LINE_CHANNEL_ACCESS_TOKEN) {
    return {
      userId: userId || "",
      displayName: "名前取得不可"
    };
  }

  let url =
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;

  // グループの場合
  if (source && source.type === "group" && source.groupId) {
    url =
      `https://api.line.me/v2/bot/group/${encodeURIComponent(
        source.groupId
      )}/member/${encodeURIComponent(userId)}`;
  }

  // 複数人トークの場合
  if (source && source.type === "room" && source.roomId) {
    url =
      `https://api.line.me/v2/bot/room/${encodeURIComponent(
        source.roomId
      )}/member/${encodeURIComponent(userId)}`;
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization:
        `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      "LINE PROFILE ERROR:",
      JSON.stringify(data, null, 2)
    );

    return {
      userId,
      displayName: "名前取得不可"
    };
  }

  return {
    userId: data.userId || userId,
    displayName:
      data.displayName || "名前未取得",
    pictureUrl:
      data.pictureUrl || "",
    statusMessage:
      data.statusMessage || ""
  };
}