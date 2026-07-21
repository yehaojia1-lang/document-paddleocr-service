"use client";

import { FormEvent, useMemo, useState } from "react";

type Option = {
  id: string;
  label: string;
  icon: string;
  note?: string;
  brands?: string[];
};

type Step = {
  id: keyof Picks;
  eyebrow: string;
  title: string;
  subtitle: string;
  optional?: boolean;
  options: Option[];
};

type Picks = {
  eat: string[];
  brands: string[];
  drink: string[];
  play: string[];
  place: string[];
  time: string[];
};

const initialPicks: Picks = {
  eat: [],
  brands: [],
  drink: [],
  play: [],
  place: [],
  time: [],
};

const steps: Step[] = [
  {
    id: "eat",
    eyebrow: "第一封小纸条",
    title: "今天想吃点什么?",
    subtitle: "可以多选，点开菜品还能挑品牌。",
    options: [
      {
        id: "fried-chicken",
        label: "炸鸡",
        icon: "🍗",
        note: "脆皮快乐局",
        brands: [
          "肯德基",
          "麦当劳",
          "德克士",
          "华莱士",
          "正新鸡排",
          "塔斯汀",
          "叫了只炸鸡",
          "派乐汉堡",
          "贝克汉堡",
          "鸡光宝盒",
          "超级鸡车",
          "吮指炸鸡",
        ],
      },
      {
        id: "hotpot",
        label: "火锅",
        icon: "🍲",
        brands: ["海底捞", "呷哺呷哺", "凑凑", "小龙坎", "蜀大侠", "大龙燚", "谭鸭血", "巴奴毛肚火锅"],
      },
      {
        id: "bbq",
        label: "烤肉",
        icon: "🥩",
        brands: ["韩宫宴", "姜虎东白丁", "很久以前羊肉串", "九田家", "酒拾烤肉", "肉本家", "西塔老太太"],
      },
      {
        id: "sushi",
        label: "寿司",
        icon: "🍣",
        brands: ["争鲜", "元气寿司", "寿司郎", "鮨政", "N多寿司", "鲜目录"],
      },
      {
        id: "noodles",
        label: "面/粉",
        icon: "🍜",
        brands: ["遇见小面", "和府捞面", "张拉拉兰州手撕牛肉面", "陈香贵", "马记永", "五谷渔粉"],
      },
      {
        id: "snack",
        label: "小吃夜宵",
        icon: "🥟",
        brands: ["绝味鸭脖", "周黑鸭", "煌上煌", "紫燕百味鸡", "夸父炸串", "正新鸡排"],
      },
      {
        id: "dessert",
        label: "甜品蛋糕",
        icon: "🍰",
        brands: ["好利来", "鲍师傅", "泸溪河", "DQ", "哈根达斯", "满记甜品", "许留山", "Lady M", "Awfully Chocolate", "爸爸糖手工吐司"],
      },
      {
        id: "bakery",
        label: "面包烘焙",
        icon: "🥐",
        brands: ["山崎面包", "巴黎贝甜", "85度C", "面包新语", "原麦山丘", "Ole精品超市烘焙", "本地独立面包店"],
      },
      {
        id: "other-food",
        label: "其他",
        icon: "✨",
        note: "让 TA 自己写",
      },
    ],
  },
  {
    id: "drink",
    eyebrow: "第二封小纸条",
    title: "喝点什么配今天?",
    subtitle: "奶茶、咖啡、微醺都可以。",
    options: [
      { id: "milk-tea", label: "奶茶", icon: "🧋", brands: ["喜茶", "奈雪的茶", "霸王茶姬", "茶百道", "沪上阿姨", "古茗", "一点点", "CoCo都可", "蜜雪冰城", "爷爷不泡茶", "茉莉奶白"] },
      { id: "coffee", label: "咖啡", icon: "☕", brands: ["瑞幸咖啡", "星巴克", "库迪咖啡", "Manner", "M Stand", "Tims天好咖啡", "Seesaw", "Peet's Coffee", "Grid Coffee", "本地独立咖啡店"] },
      { id: "fruit-tea", label: "果茶", icon: "🍋", brands: ["LINLEE", "茶救星球", "7分甜", "书亦烧仙草", "悸动烧仙草", "甜啦啦"] },
      { id: "ice", label: "冰淇淋", icon: "🍦", brands: ["DQ", "哈根达斯", "蜜雪冰城", "钟薛高", "Gelato品牌随缘"] },
      { id: "bar", label: "小酒馆", icon: "🍹", brands: ["COMMUNE", "海伦司", "胡桃里", "Perry's", "本地清吧"] },
      { id: "other-drink", label: "其他", icon: "💭" },
    ],
  },
  {
    id: "play",
    eyebrow: "第三封小纸条",
    title: "然后去干什么?",
    subtitle: "饭后不赶场，快乐要续杯。",
    options: [
      { id: "movie", label: "看电影", icon: "🎬" },
      { id: "ktv", label: "KTV", icon: "🎤", brands: ["纯K", "好乐迪", "唱吧麦颂", "温莎KTV", "魅KTV", "米乐星", "本地量贩KTV", "Livehouse包厢"] },
      { id: "board-game", label: "桌游", icon: "🎲" },
      { id: "escape", label: "密室/剧本", icon: "🗝️" },
      { id: "dessert-hunt", label: "甜品探店", icon: "🍮", brands: ["好利来", "鲍师傅", "Lady M", "满记甜品", "许留山", "DQ", "本地网红甜品店", "小红书收藏店"] },
      { id: "cafe-hunt", label: "咖啡探店", icon: "☕", brands: ["Manner", "M Stand", "Seesaw", "Peet's Coffee", "星巴克臻选", "本地独立咖啡店", "露营风咖啡", "宠物友好咖啡店"] },
      { id: "photo", label: "拍照打卡", icon: "📸", brands: ["海马体", "天真蓝", "人生四格", "大头贴机", "街拍路线", "城市夜景点"] },
      { id: "arcade", label: "电玩城", icon: "🕹️", brands: ["风云再起", "汤姆熊", "城市英雄", "反斗乐园", "抓娃娃店", "Switch体验馆"] },
      { id: "live", label: "演出/Live", icon: "🎧", brands: ["Livehouse", "脱口秀", "音乐节", "清吧驻唱", "小剧场", "展演空间"] },
      { id: "handmade", label: "手作体验", icon: "🎨", brands: ["陶艺", "香薰蜡烛", "Tufting", "银饰DIY", "烘焙课", "流体熊"] },
      { id: "relax", label: "按摩放松", icon: "💆", brands: ["泰式按摩", "足疗", "采耳", "SPA", "头疗", "肩颈放松"] },
      { id: "walk", label: "散步压马路", icon: "🌙" },
      { id: "mall", label: "逛商场", icon: "🛍️" },
      { id: "chill", label: "随便坐坐", icon: "🫧" },
    ],
  },
  {
    id: "place",
    eyebrow: "第四封小纸条",
    title: "想在哪里见面?",
    subtitle: "先定氛围，具体地址后面再聊。",
    options: [
      { id: "mall-place", label: "商场", icon: "🛍️" },
      { id: "restaurant-place", label: "餐厅", icon: "🍽️" },
      { id: "cafe-place", label: "咖啡馆", icon: "☕", brands: ["独立咖啡馆", "露台咖啡", "宠物友好", "安静聊天", "适合拍照", "商场咖啡"] },
      { id: "cinema-place", label: "电影院", icon: "🎞️" },
      { id: "park-place", label: "公园", icon: "🌳" },
      { id: "museum-place", label: "展览馆", icon: "🖼️", brands: ["美术馆", "博物馆", "摄影展", "潮流展", "市集展", "沉浸式展览"] },
      { id: "studio-place", label: "体验馆", icon: "🎨", brands: ["手作店", "香薰店", "陶艺店", "电玩城", "桌游店", "KTV"] },
      { id: "near-me", label: "我家附近", icon: "🏠" },
      { id: "other-place", label: "其他", icon: "📍" },
    ],
  },
  {
    id: "time",
    eyebrow: "最后一封小纸条",
    title: "什么时候最合适?",
    subtitle: "选完就把这份回应寄给我。",
    options: [
      { id: "tonight", label: "今天晚上", icon: "🌙" },
      { id: "tomorrow", label: "明天下午", icon: "☀️" },
      { id: "weekend", label: "周末全天", icon: "📅" },
      { id: "next-week", label: "下周都可以", icon: "💞" },
      { id: "ask", label: "再对时间", icon: "⏰" },
      { id: "surprise", label: "你来定", icon: "🎁" },
    ],
  },
];

const quickMessages = ["早就想去了", "等你好久了", "必须答应", "让我先看看时间"];

export default function Home() {
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [picks, setPicks] = useState<Picks>(initialPicks);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const selectedBrandGroups = useMemo(() => {
    return steps
      .flatMap((item) => item.options)
      .filter((option) => picks.eat.includes(option.id) || picks.drink.includes(option.id) || picks.play.includes(option.id) || picks.place.includes(option.id))
      .filter((option) => option.brands?.length);
  }, [picks.eat, picks.drink]);

  const labels = useMemo(() => {
    const optionMap = new Map(steps.flatMap((item) => item.options.map((option) => [option.id, option.label])));
    const brandLabels = new Map(selectedBrandGroups.flatMap((group) => group.brands!.map((brand) => [brand, brand])));

    return {
      eat: picks.eat.map((id) => optionMap.get(id) ?? id),
      brands: picks.brands.map((id) => brandLabels.get(id) ?? id),
      drink: picks.drink.map((id) => optionMap.get(id) ?? id),
      play: picks.play.map((id) => optionMap.get(id) ?? id),
      place: picks.place.map((id) => optionMap.get(id) ?? id),
      time: picks.time.map((id) => optionMap.get(id) ?? id),
    };
  }, [picks, selectedBrandGroups]);

  function toggle(stepId: keyof Picks, value: string) {
    setPicks((current) => {
      const exists = current[stepId].includes(value);
      return {
        ...current,
        [stepId]: exists ? current[stepId].filter((item) => item !== value) : [...current[stepId], value],
      };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError("");

    const summary = [
      `填写人: ${name || "没有署名"}`,
      `想吃: ${labels.eat.join("、") || "未选择"}`,
      `品牌偏好: ${labels.brands.join("、") || "未选择"}`,
      `想喝: ${labels.drink.join("、") || "未选择"}`,
      `想玩: ${labels.play.join("、") || "未选择"}`,
      `地点: ${labels.place.join("、") || "未选择"}`,
      `时间: ${labels.time.join("、") || "未选择"}`,
      `想说的话: ${message || "没有留言"}`,
      `补充: ${custom || "没有补充"}`,
    ].join("\n");

    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: name || "匿名朋友",
          message: summary,
        }),
      });

      if (!response.ok) {
        throw new Error("send-failed");
      }

      setSent(true);
    } catch {
      setError("刚才没有寄出去，可以再点一次，或者先截图发给我。");
    } finally {
      setSending(false);
    }
  }

  if (!started) {
    return (
      <main className="page-shell">
        <Decorations />
        <section className="invite-card intro-card">
          <p className="step-badge">Moment 01</p>
          <div className="seal">♥</div>
          <p className="eyebrow">A LITTLE PLAN</p>
          <h1>有人想约你出去吃喝玩乐</h1>
          <p className="lead">收下这份可爱的邀请，帮我选好今天吃什么、喝什么、去哪里玩。</p>
          <button className="primary-button" type="button" onClick={() => setStarted(true)}>
            轻触打开 <span>→</span>
          </button>
        </section>
      </main>
    );
  }

  if (sent) {
    return (
      <main className="page-shell">
        <Decorations />
        <section className="invite-card success-card">
          <p className="step-badge">Sent</p>
          <div className="seal">✓</div>
          <p className="eyebrow">回应已经送达</p>
          <h1>这一刻，值得被记住。</h1>
          <p className="lead">你的答案已经悄悄飞到我的邮箱里了。现在只差把这场小出逃变成真的。</p>
          <div className="summary-list">
            <SummaryItem title="想吃" value={[...labels.eat, ...labels.brands].join("、")} />
            <SummaryItem title="想喝" value={labels.drink.join("、")} />
            <SummaryItem title="想玩" value={labels.play.join("、")} />
            <SummaryItem title="时间" value={labels.time.join("、")} />
          </div>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>
            我也想做一个 <span>✨</span>
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <Decorations />
      <form className="invite-card chooser-card" onSubmit={submit}>
        <div className="top-row">
          <p className="step-badge">{String(stepIndex + 1).padStart(2, "0")}</p>
          <div className="progress" aria-label={`第 ${stepIndex + 1} 步，共 ${steps.length} 步`}>
            {steps.map((item, index) => (
              <span className={index <= stepIndex ? "active" : ""} key={item.id} />
            ))}
          </div>
        </div>

        <p className="eyebrow">{step.eyebrow}</p>
        <h1>{step.title}</h1>
        <p className="lead">{step.subtitle}</p>

        <div className="option-grid">
          {step.options.map((option) => {
            const active = picks[step.id].includes(option.id);
            return (
              <button
                aria-pressed={active}
                className={`option-tile ${active ? "selected" : ""}`}
                key={option.id}
                onClick={() => toggle(step.id, option.id)}
                type="button"
              >
                <span className="option-icon">{option.icon}</span>
                <span>{option.label}</span>
                {option.note ? <small>{option.note}</small> : null}
              </button>
            );
          })}
        </div>

        {selectedBrandGroups.length > 0 && stepIndex <= 3 ? (
          <section className="brand-panel">
            <h2>顺手挑几个品牌/类型</h2>
            {selectedBrandGroups.map((group) => (
              <div className="brand-group" key={group.id}>
                <p>{group.label}</p>
                <div className="chip-row">
                  {group.brands!.map((brand) => (
                    <button
                      className={picks.brands.includes(brand) ? "chip active" : "chip"}
                      key={brand}
                      onClick={() => toggle("brands", brand)}
                      type="button"
                    >
                      {brand}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {isLast ? (
          <section className="final-fields">
            <label>
              你的名字
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="比如：今天超想出门的人" />
            </label>
            <label>
              想对我说点什么
              <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="早就想去了..." />
            </label>
            <div className="quick-row">
              {quickMessages.map((item) => (
                <button key={item} type="button" onClick={() => setMessage(item)}>
                  {item}
                </button>
              ))}
            </div>
            <label>
              其他补充
              <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="地点、预算、忌口、想避开的店..." />
            </label>
          </section>
        ) : null}

        <div className="actions">
          {stepIndex > 0 ? (
            <button className="ghost-button" type="button" onClick={() => setStepIndex((value) => value - 1)}>
              上一步
            </button>
          ) : null}
          {isLast ? (
            <button className="primary-button" disabled={sending} type="submit">
              {sending ? "正在送出..." : "送出回应"} <span>→</span>
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={() => setStepIndex((value) => value + 1)}>
              下一步 <span>→</span>
            </button>
          )}
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </form>
    </main>
  );
}

function SummaryItem({ title, value }: { title: string; value: string }) {
  return (
    <div>
      <span>{title}</span>
      <strong>{value || "还想保密"}</strong>
    </div>
  );
}

function Decorations() {
  return (
    <>
      <div className="petal petal-one" />
      <div className="petal petal-two" />
      <div className="petal petal-three" />
      <div className="rose rose-left" />
      <div className="rose rose-right" />
    </>
  );
}
