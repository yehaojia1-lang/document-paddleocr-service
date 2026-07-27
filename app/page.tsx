"use client";

import { useMemo, useState } from "react";

type Scene = "hello" | "confirm" | "afterTea" | "dinner" | "drinks" | "ticket";

const afterTeaPlans = [
  {
    id: "citywalk",
    title: "江南西随便逛逛",
    detail: "不赶行程，看到有意思的小店就进去看看，适合慢慢聊天。",
  },
  {
    id: "photo",
    title: "拍照 / 大头贴",
    detail: "找个好看的地方拍几张照，或者去拍大头贴，轻松一点。",
  },
  {
    id: "arcade",
    title: "电玩城抓娃娃",
    detail: "不用一直讲话也不会冷场，玩一会儿刚好等到饭点。",
  },
  {
    id: "movie",
    title: "看场轻松电影",
    detail: "如果天气热或者不想走路，就看有没有合适场次。",
  },
];

const dinnerOptions = [
  {
    id: "cantonese",
    title: "粤菜 / 茶餐厅",
    detail: "稳一点，不太容易踩雷，也适合慢慢吃。",
  },
  {
    id: "japanese",
    title: "日料 / 寿司",
    detail: "清爽一点，下午吃了抹茶之后也不会太腻。",
  },
  {
    id: "bbq",
    title: "烤肉",
    detail: "气氛会热一点，但不会太正式，适合边吃边聊。",
  },
  {
    id: "hotpot",
    title: "火锅",
    detail: "如果我们都饿了，这个最有安全感。",
  },
  {
    id: "western",
    title: "意面 / 西餐",
    detail: "安静一点，比较适合吃完就舒服回家。",
  },
  {
    id: "youPick",
    title: "美羊羊来定",
    detail: "我负责查路线和排队情况，你负责选你想吃的。",
  },
];

const drinkOptions = ["果茶", "咖啡", "奶茶", "气泡水", "冰淇淋", "你想喝的"];

export default function Home() {
  const [scene, setScene] = useState<Scene>("hello");
  const [afterTeaId, setAfterTeaId] = useState(afterTeaPlans[0].id);
  const [dinnerId, setDinnerId] = useState(dinnerOptions[0].id);
  const [drinks, setDrinks] = useState<string[]>(["果茶"]);
  const [copied, setCopied] = useState(false);
  const [shyCount, setShyCount] = useState(0);

  const afterTea = afterTeaPlans.find((item) => item.id === afterTeaId) ?? afterTeaPlans[0];
  const dinner = dinnerOptions.find((item) => item.id === dinnerId) ?? dinnerOptions[0];

  const message = useMemo(
    () =>
      `美羊羊，周日下午江南西抹茶之后，我们可以先「${afterTea.title}」：${afterTea.detail} 晚餐我想选「${dinner.title}」：${dinner.detail} 中间如果想喝点东西，可以选：${drinks.length ? drinks.join("、") : "到时候随缘"}。吃完晚饭就送你回家/各自回家，不把行程排太满。你看这个节奏可以吗？`,
    [afterTea.detail, afterTea.title, dinner.detail, dinner.title, drinks],
  );

  function toggleDrink(item: string) {
    setCopied(false);
    setDrinks((current) => (current.includes(item) ? current.filter((value) => value !== item) : [...current, item]));
  }

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
          <span>To 美羊羊 ~</span>
          <button type="button" aria-label="关闭">
            x
          </button>
        </div>

        {scene === "hello" ? (
          <Card icon="matcha" eyebrow="给美羊羊的小纸条" title="美羊羊，帮我选一下">
            <p>
              周日下午我们约了江南西抹茶和晚餐，但中间那段、还有晚餐吃什么，我想让你选一个舒服的版本。
            </p>
            <button className="hot-button" type="button" onClick={() => setScene("confirm")}>
              点开看看
            </button>
          </Card>
        ) : null}

        {scene === "confirm" ? (
          <Card icon="spark" eyebrow="美羊羊先确认一下" title="这个不是表白程序">
            <p>只是一个认真安排周日下午的小网页。不会突然给你压力，也不会把行程排得很满。</p>
            <div className="button-row">
              <button className="hot-button" type="button" onClick={() => setScene("afterTea")}>
                好啦好啦
              </button>
              <button
                className="ghost-run"
                style={{ transform: `translate(${shyCount * 10}px, ${shyCount % 2 ? -8 : 8}px)` }}
                type="button"
                onClick={() => setShyCount((value) => value + 1)}
              >
                我有点警觉
              </button>
            </div>
          </Card>
        ) : null}

        {scene === "afterTea" ? (
          <Card icon="flower" eyebrow="问美羊羊" title="抹茶之后去干嘛？">
            <div className="plan-list">
              {afterTeaPlans.map((item) => (
                <button
                  className={afterTeaId === item.id ? "plan active" : "plan"}
                  key={item.id}
                  onClick={() => {
                    setAfterTeaId(item.id);
                    setCopied(false);
                  }}
                  type="button"
                >
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </button>
              ))}
            </div>
            <button className="hot-button wide" type="button" onClick={() => setScene("dinner")}>
              选好了
            </button>
          </Card>
        ) : null}

        {scene === "dinner" ? (
          <Card icon="dinner" eyebrow="再问美羊羊" title="晚上想吃什么？">
            <div className="plan-list compact">
              {dinnerOptions.map((item) => (
                <button
                  className={dinnerId === item.id ? "plan active" : "plan"}
                  key={item.id}
                  onClick={() => {
                    setDinnerId(item.id);
                    setCopied(false);
                  }}
                  type="button"
                >
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </button>
              ))}
            </div>
            <button className="hot-button wide" type="button" onClick={() => setScene("drinks")}>
              下一步
            </button>
          </Card>
        ) : null}

        {scene === "drinks" ? (
          <Card icon="drink" eyebrow="可以多选" title="还想喝点什么？">
            <p className="soft-line">抹茶是主线，这里只是备用饮料清单。美羊羊可以多选，也可以一个都不选。</p>
            <div className="drink-grid">
              {drinkOptions.map((item) => (
                <button
                  className={drinks.includes(item) ? "drink active" : "drink"}
                  key={item}
                  onClick={() => toggleDrink(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
            <button className="hot-button wide" type="button" onClick={() => setScene("ticket")}>
              生成小票
            </button>
          </Card>
        ) : null}

        {scene === "ticket" ? (
          <Card icon="sheep" eyebrow="美羊羊的约会小票" title="路线暂定成功">
            <p className="soft-line">周日下午，江南西。先抹茶，再玩一会儿，吃完晚餐就回家。</p>
            <div className="ticket">
              <div>
                <span>For</span>
                <strong>美羊羊</strong>
              </div>
              <div>
                <span>Tea</span>
                <strong>江南西抹茶</strong>
              </div>
              <div>
                <span>After Tea</span>
                <strong>{afterTea.title}</strong>
              </div>
              <div>
                <span>Dinner</span>
                <strong>{dinner.title}</strong>
              </div>
              <div>
                <span>Drinks</span>
                <strong>{drinks.length ? drinks.join("、") : "随缘"}</strong>
              </div>
              <div>
                <span>Ending</span>
                <strong>晚餐后回家</strong>
              </div>
            </div>
            <p className="copy-text">{message}</p>
            <div className="button-row">
              <button className="hot-button" type="button" onClick={copyMessage}>
                {copied ? "已复制" : "复制发给我"}
              </button>
              <button className="plain-button" type="button" onClick={() => setScene("afterTea")}>
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
  icon: "matcha" | "spark" | "flower" | "dinner" | "drink" | "sheep";
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
