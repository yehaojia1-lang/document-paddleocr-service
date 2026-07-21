export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const name = typeof payload.name === "string" ? payload.name : "匿名朋友";
    const message = typeof payload.message === "string" ? payload.message : "";

    const response = await fetch("https://formsubmit.co/ajax/hogayip915@gmail.com", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: "https://cute-outing-invite.choreryip.chatgpt.site",
      },
      body: JSON.stringify({
        _subject: "有人填好了你的吃喝玩乐邀请",
        _template: "box",
        name,
        message,
      }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      return Response.json({ ok: false, result }, { status: 502 });
    }

    return Response.json({ ok: true, result });
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}
