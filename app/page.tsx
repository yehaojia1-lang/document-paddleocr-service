"use client";

import { useMemo, useState } from "react";

type Scene = "hello" | "confirm" | "time" | "after" | "ticket";

const afterPlans = [
  {
    id: "walk",
    title: "散步聊天",
    detail: "吃完抹茶不急着散，沿江南西随便逛逛，看到舒服的店就进去坐。",
  },
  {
    id: "photo",
    title: "拍照小路线",
    detail: "找好看的小店或街角拍几张照，轻轻松松留个周日下午的纪念。",
  },
  {
    id: "movie",
    title: "看电影备用",
    detail: "如果天气热或不想走太多，就现场看一场轻松电影，场次合适再决定。",
  },
  {
    id: "dinner",
    title: "顺便吃晚饭",
    detail: "如果抹茶后还聊得开心，就再找一家不用排太久的小店吃晚饭。",
  },
];

const times = ["14:30", "15:00", "15:30", "16:00"];

export default function Home() {
  const [scene, setScene] = useState<Scene>("hello");
  const [time, setTime] = useState("15:00");
  const [planId, setPlanId] = useState("walk");
  const [copied, setCopied] = useState(false);
  const [shyCount, setShyCount] = useState(0);

  const plan = afterPlans.find((item) => item.id === planId) ?? afterPlans[0];

  const message = useMemo(
    () =>
      `美羊羊，周日（8月2日）下午 ${time} 江南西吃抹茶可以吗？吃完之后我想安排「${plan.title}」：${plan.detail} 不会安排得很满，你舒服最重要。`,
    [plan.detail, plan.title, time],
  );

  async function copyMessage() {
    await navigator.clipboard.writeText(message);
    setCopied(true);
  }

  return (
    <main className="app-shell">
      <FloatingFlowers />
      <section className="phone" aria-live="polite">
        <div className="phone-top">
          <span className="dot" />
          <span>Dating with me ~</span>
          <button type="button" aria-label="关闭">x</button>
        </div>

        {scene === "hello" ? (
          <Card icon="matcha" eyebrow="Hi 美羊羊" title="想问你一个小问题">
            <p>周日下午我们不是约了去江南西吃抹茶嘛，我偷偷做了一个小网页，想把后半段也安排得舒服一点。</p>
            <button className="hot-button" type="button" onClick={() => setScene("confirm")}>
              点开看看
            </button>
          </Card>
        ) : null}

        {scene === "confirm" ? (
          <Card icon="spark" eyebrow="先确认一下" title="等下，你真的愿意继续看吗？">
            <p>这个页面不会突然表白，也不会让你尴尬，只是想认真问问你：抹茶之后，要不要再一起待一会儿？</p>
            <div className="button-row">
              <button className="hot-button" type="button" onClick={() => setScene("time")}>
                好啦好啦
              </button>
              <button
                className="ghost-run"
                style={{ transform: `translate(${shyCount * 10}px, ${shyCount % 2 ? -8 : 8}px)` }}
                type="button"
                onClick={() => setShyCount((value) => value + 1)}
              >
                我再想想
              </button>
            </div>
          </Card>
        ) : null}

        {scene === "time" ? (
          <Card icon="calendar" eyebrow="选个舒服的时间" title="周日几点见比较好？">
            <div className="pick-grid">
              {times.map((item) => (
                <button
                  className={time === item ? "pick active" : "pick"}
                  key={item}
                  onClick={() => {
                    setTime(item);
                    setCopied(false);
                  }}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
            <button className="hot-button wide" type="button" onClick={() => setScene("after")}>
              确定时间
            </button>
          </Card>
        ) : null}

        {scene === "after" ? (
          <Card icon="heart" eyebrow="抹茶之后" title="后面想去干嘛？">
            <div className="plan-list">
              {afterPlans.map((item) => (
                <button
                  className={planId === item.id ? "plan active" : "plan"}
                  key={item.id}
                  onClick={() => {
                    setPlanId(item.id);
                    setCopied(false);
                  }}
                  type="button"
                >
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </button>
              ))}
            </div>
            <button className="hot-button wide" type="button" onClick={() => setScene("ticket")}>
              生成小票
            </button>
          </Card>
        ) : null}

        {scene === "ticket" ? (
          <Card icon="sheep" eyebrow="真开心你没有拒绝" title="我会准时来见你">
            <p className="soft-line">8月2日 {time}，我们去江南西吃抹茶。带好胃口，我带好路线。</p>
            <div className="ticket">
              <div>
                <span>Date</span>
                <strong>8月2日 周日</strong>
              </div>
              <div>
                <span>Time</span>
                <strong>{time}</strong>
              </div>
              <div>
                <span>Place</span>
                <strong>江南西</strong>
              </div>
              <div>
                <span>After</span>
                <strong>{plan.title}</strong>
              </div>
            </div>
            <p className="copy-text">{message}</p>
            <div className="button-row">
              <button className="hot-button" type="button" onClick={copyMessage}>
                {copied ? "已复制" : "复制发给我"}
              </button>
              <button className="plain-button" type="button" onClick={() => setScene("after")}>
                改一下
              </button>
            </div>
          </Card>
        ) : null}
      </section>
    </main>
  );
}

function Card({
  children,
  eyebrow,
  icon,
  title,
}: {
  children: React.ReactNode;
  eyebrow: string;
  icon: "matcha" | "spark" | "calendar" | "heart" | "sheep";
  title: string;
}) {
  return (
    <div className="card">
      <div className={`icon ${icon}`} aria-hidden="true" />
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function FloatingFlowers() {
  return (
    <>
      <span className="flower f1">✿</span>
      <span className="flower f2">✿</span>
      <span className="flower f3">✿</span>
      <span className="flower f4">✿</span>
      <span className="flower f5">✿</span>
    </>
  );
}
