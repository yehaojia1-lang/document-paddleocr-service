"use client";

import { useMemo, useRef, useState } from "react";

type Direction = "en-to-zh" | "zh-to-en";
type Provider = "auto" | "openai" | "deepseek" | "offline";
type DocType = "driver-license" | "id-card" | "graduation-certificate" | "degree-certificate" | "birth-certificate" | "address-proof" | "other";

type FieldResult = {
  label: string;
  source: string;
  translation: string;
};

type TranslationResult = {
  mode: string;
  title: string;
  summary: string;
  fields: FieldResult[];
  polished: string;
  notes: string[];
};

const samples: Record<Direction, string> = {
  "en-to-zh":
    "DRIVER LICENSE\nName: Alex Chen\nAddress: 1288 Market Street, Apt 19B, San Francisco, CA 94102, USA\nDate of Birth: 05/18/1992\nClass: C\nExpires: 08/31/2029",
  "zh-to-en":
    "中华人民共和国居民身份证\n姓名：陈明\n性别：男\n民族：汉\n出生：1992年5月18日\n住址：广东省广州市天河区珠江新城华夏路16号富力盈凯广场A座1808室\n公民身份号码：440106199205180018",
};

const docTypes: { id: DocType; label: string }[] = [
  { id: "driver-license", label: "驾照" },
  { id: "id-card", label: "身份证" },
  { id: "graduation-certificate", label: "毕业证" },
  { id: "degree-certificate", label: "学位证" },
  { id: "birth-certificate", label: "出生证" },
  { id: "address-proof", label: "地址证明" },
  { id: "other", label: "其他证件" },
];

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [direction, setDirection] = useState<Direction>("en-to-zh");
  const [docType, setDocType] = useState<DocType>("driver-license");
  const [provider, setProvider] = useState<Provider>("auto");
  const [imageUrl, setImageUrl] = useState("");
  const [sourceText, setSourceText] = useState(samples["en-to-zh"]);
  const [ocrStatus, setOcrStatus] = useState("等待上传图片");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);

  const targetLabel = direction === "en-to-zh" ? "翻译成中文" : "Translate to English";
  const sourceLabel = direction === "en-to-zh" ? "英文证件内容" : "中文证件内容";

  const confidence = useMemo(() => {
    if (!sourceText.trim()) return "未识别";
    if (sourceText.length > 120 && result?.fields.length) return "高";
    if (sourceText.length > 40) return "中";
    return "待校对";
  }, [result?.fields.length, sourceText]);

  function switchDirection(next: Direction) {
    setDirection(next);
    setDocType(next === "en-to-zh" ? "driver-license" : "id-card");
    setSourceText(samples[next]);
    setResult(null);
    setOcrStatus("已载入示例，可直接翻译");
    setOcrProgress(0);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setResult(null);
    setImageUrl(URL.createObjectURL(file));
    setIsReading(true);
    setOcrProgress(0.05);
    setOcrStatus("正在读取图片文字");

    try {
      const { recognize } = await import("tesseract.js");
      const language = direction === "zh-to-en" ? "chi_sim+eng" : "eng+chi_sim";
      const response = await recognize(file, language, {
        logger: (message: { status?: string; progress?: number }) => {
          if (typeof message.progress === "number") {
            setOcrProgress(Math.max(0.08, Math.min(0.98, message.progress)));
          }
          if (message.status) setOcrStatus(readableOcrStatus(message.status));
        },
      });

      const text = response.data.text.trim();
      setSourceText(text || "");
      setOcrStatus(text ? "识别完成，请校对后翻译" : "没有识别到文字，请换一张更清晰的图片");
      setOcrProgress(text ? 1 : 0);
    } catch {
      setOcrStatus("OCR 加载失败，可以先手动粘贴文字翻译");
      setOcrProgress(0);
    } finally {
      setIsReading(false);
    }
  }

  async function translate() {
    if (!sourceText.trim()) return;
    setIsTranslating(true);
    setResult(null);

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, docType, provider, text: sourceText }),
      });
      const data = (await response.json()) as TranslationResult;
      setResult(data);
    } catch {
      setResult({
        mode: "offline",
        title: "离线规则译文",
        summary: "网络不可用时生成的基础译文，建议人工复核姓名、号码和地址门牌。",
        fields: [],
        polished: sourceText,
        notes: ["接口暂时不可用，已保留原文供校对。"],
      });
    } finally {
      setIsTranslating(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    const fields = result.fields.map((field) => `${field.label}: ${field.translation}`).join("\n");
    await navigator.clipboard.writeText(`${result.title}\n\n${fields}\n\n${result.polished}`);
  }

  return (
    <main className="translator-shell">
      <section className="workspace">
        <header className="hero-panel">
          <div>
            <p className="eyebrow">Document OCR Translation Desk</p>
            <h1>证件图片自动识别与专业翻译</h1>
            <p className="hero-copy">
              上传驾照、身份证、毕业证、学位证、出生证或地址证明，先识别图片里的所有文字，再按你的标准模板表达生成完整中英译文。
            </p>
          </div>
          <div className="status-strip" aria-label="处理状态">
            <span>OCR {isReading ? "读取中" : "就绪"}</span>
            <span>可信度 {confidence}</span>
            <span>{provider === "offline" ? "离线规则" : "可接模型"}</span>
          </div>
        </header>

        <section className="control-bar" aria-label="翻译设置">
          <div className="segmented">
            <button className={direction === "en-to-zh" ? "active" : ""} onClick={() => switchDirection("en-to-zh")} type="button">
              驾照/英文到中文
            </button>
            <button className={direction === "zh-to-en" ? "active" : ""} onClick={() => switchDirection("zh-to-en")} type="button">
              身份证/中文到英文
            </button>
          </div>

          <label>
            证件类型
            <select value={docType} onChange={(event) => setDocType(event.target.value as DocType)}>
              {docTypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            翻译引擎
            <select value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
              <option value="auto">自动选择</option>
              <option value="openai">OpenAI GPT</option>
              <option value="deepseek">DeepSeek</option>
              <option value="offline">离线规则</option>
            </select>
          </label>
        </section>

        <section className="main-grid">
          <div className="panel upload-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>上传证件图片</h2>
              </div>
              <button className="icon-button" onClick={() => fileInputRef.current?.click()} type="button" aria-label="选择图片">
                +
              </button>
            </div>

            <button className="drop-zone" onClick={() => fileInputRef.current?.click()} type="button">
              {imageUrl ? <img alt="已上传证件预览" src={imageUrl} /> : <span>点击上传 JPG、PNG 或截图</span>}
            </button>
            <input
              accept="image/*"
              hidden
              ref={fileInputRef}
              type="file"
              onChange={(event) => handleFile(event.target.files?.[0])}
            />

            <div className="progress-wrap">
              <div className="progress-label">
                <span>{ocrStatus}</span>
                <strong>{Math.round(ocrProgress * 100)}%</strong>
              </div>
              <div className="progress-track">
                <span style={{ width: `${ocrProgress * 100}%` }} />
              </div>
            </div>

            <label className="text-editor">
              {sourceLabel}
              <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
            </label>
          </div>

          <div className="panel result-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>{targetLabel}</h2>
              </div>
              <button className="primary-button" disabled={isTranslating || !sourceText.trim()} onClick={translate} type="button">
                {isTranslating ? "翻译中" : "生成译文"}
              </button>
            </div>

            {result ? (
              <div className="result-stack">
                <div className="translation-summary">
                  <span>{result.mode}</span>
                  <strong>{result.title}</strong>
                  <p>{result.summary}</p>
                </div>

                <div className="field-table">
                  {result.fields.map((field) => (
                    <div className="field-row" key={`${field.label}-${field.source}`}>
                      <span>{field.label}</span>
                      <p>{field.source}</p>
                      <strong>{field.translation}</strong>
                    </div>
                  ))}
                </div>

                <article className="polished-output">
                  <h3>完整专业译文</h3>
                  <p>{result.polished}</p>
                </article>

                <div className="notes">
                  {result.notes.map((note) => (
                    <span key={note}>{note}</span>
                  ))}
                </div>

                <button className="secondary-button" onClick={copyResult} type="button">
                  复制译文
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <strong>译文将在这里生成</strong>
                <p>建议先检查 OCR 文本，重点看有没有漏字、号码错误、日期错误，以及地址是否包含楼栋、房号、州省、市区和邮编。</p>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function readableOcrStatus(status: string) {
  const map: Record<string, string> = {
    "loading tesseract core": "正在加载 OCR 核心",
    "initializing tesseract": "正在初始化 OCR",
    "loading language traineddata": "正在加载语言包",
    "initializing api": "正在准备识别",
    "recognizing text": "正在识别文字",
  };

  return map[status] ?? status;
}
