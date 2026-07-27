"use client";

import { useMemo, useRef, useState } from "react";

type Direction = "en-to-zh" | "zh-to-en";
type Provider = "auto" | "openai" | "deepseek" | "offline";
type DocType =
  | "driver-license"
  | "id-card"
  | "graduation-certificate"
  | "degree-certificate"
  | "birth-certificate"
  | "address-proof"
  | "other";
type FileKind = "image" | "pdf" | "word" | "unknown";

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

type OcrWorker = {
  recognize: (image: CanvasImageSource | File | Blob, options?: Record<string, unknown>) => Promise<{ data: { text: string } }>;
  setParameters: (params: Record<string, string>) => Promise<void>;
};

let sharedOcrWorker: Promise<OcrWorker> | null = null;

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
  { id: "other", label: "其他文件" },
];

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [direction, setDirection] = useState<Direction>("zh-to-en");
  const [docType, setDocType] = useState<DocType>("id-card");
  const [provider, setProvider] = useState<Provider>("auto");
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileKind, setFileKind] = useState<FileKind>("unknown");
  const [sourceText, setSourceText] = useState(samples["zh-to-en"]);
  const [readStatus, setReadStatus] = useState("等待上传图片、PDF 或 Word 文件");
  const [readProgress, setReadProgress] = useState(0);
  const [isReading, setIsReading] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);

  const targetLabel = direction === "en-to-zh" ? "翻译成中文" : "Translate to English";
  const sourceLabel = direction === "en-to-zh" ? "英文/外文原文" : "中文原文";

  const confidence = useMemo(() => {
    if (!sourceText.trim()) return "未识别";
    if (sourceText.includes("待确认") || sourceText.includes("illegible")) return "需校对";
    if (sourceText.length > 100) return "较高";
    return "中";
  }, [sourceText]);

  function switchDirection(next: Direction) {
    setDirection(next);
    setDocType(next === "en-to-zh" ? "driver-license" : "id-card");
    setSourceText(samples[next]);
    setResult(null);
    setReadStatus("已载入示例，可直接翻译");
    setReadProgress(0);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const kind = detectFileKind(file);
    setResult(null);
    setFileName(file.name);
    setFileKind(kind);
    setPreviewUrl(kind === "image" ? URL.createObjectURL(file) : "");
    setIsReading(true);
    setReadProgress(0.05);

    try {
      if (kind === "pdf") {
        setReadStatus("正在提取 PDF 可复制文字");
        const text = await extractPdfTextWithFallback(file, setReadProgress, setReadStatus);
        setSourceText(text);
        setReadStatus(text ? "PDF 读取完成：已合并文字层和扫描页 OCR" : "没有读到内容，请检查 PDF 是否加密或图片过低清");
        setReadProgress(text ? 1 : 0);
        return;
      }

      if (kind === "word") {
        setReadStatus("正在读取 Word 文档文字");
        const text = await extractWordTextWithFallback(file, setReadProgress, setReadStatus);
        setSourceText(text);
        setReadStatus(text ? "Word 读取完成：已合并正文和内嵌图片 OCR" : "没有读到内容，请检查 Word 是否加密或图片过低清");
        setReadProgress(text ? 1 : 0);
        return;
      }

      if (kind === "image") {
        setReadStatus(docType === "id-card" ? "正在按身份证字段区域识别" : "正在 OCR 识别图片文字");
        const text = docType === "id-card" && direction === "zh-to-en" ? await readChineseIdCard(file, setReadProgress, setReadStatus) : await readImageText(file, setReadProgress, setReadStatus);
        setSourceText(text);
        setReadStatus(text ? "识别完成，请先校对再翻译" : "没有识别到文字，请换更清晰图片或手动粘贴文字");
        setReadProgress(text ? 1 : 0);
        return;
      }

      setReadStatus("暂不支持这个文件类型");
      setReadProgress(0);
    } catch {
      setReadStatus("读取失败，可以先手动粘贴文字翻译");
      setReadProgress(0);
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
        title: direction === "zh-to-en" ? "Offline Chinese-to-English Translation" : "离线英译中译文",
        summary: "接口暂时不可用，已保留原文。请先校对 OCR 文本。",
        fields: [],
        polished: sourceText,
        notes: ["如果识别文字错误，翻译一定会跟着错；请先在左侧修正原文。"],
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
            <p className="eyebrow">Complete Document Translation</p>
            <h1>证件与文件完整翻译工具</h1>
            <p className="hero-copy">
              支持图片、PDF、Word 文档。先提取全部可见文字，再按证件类型和标准模板表达翻译；中文地址按大到小，英文地址按小到大。
            </p>
          </div>
          <div className="status-strip" aria-label="处理状态">
            <span>{fileKind === "unknown" ? "等待文件" : fileKind.toUpperCase()}</span>
            <span>识别可信度 {confidence}</span>
            <span>{provider === "offline" ? "离线规则" : "可接模型"}</span>
          </div>
        </header>

        <section className="control-bar" aria-label="翻译设置">
          <div className="segmented">
            <button className={direction === "zh-to-en" ? "active" : ""} onClick={() => switchDirection("zh-to-en")} type="button">
              中文到英文
            </button>
            <button className={direction === "en-to-zh" ? "active" : ""} onClick={() => switchDirection("en-to-zh")} type="button">
              英文/外文到中文
            </button>
          </div>

          <label>
            文件/证件类型
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
                <h2>上传文件并提取文字</h2>
              </div>
              <button className="icon-button" onClick={() => fileInputRef.current?.click()} type="button" aria-label="选择文件">
                +
              </button>
            </div>

            <button
              className="drop-zone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                event.currentTarget.classList.add("dragging");
              }}
              onDragLeave={(event) => event.currentTarget.classList.remove("dragging")}
              onDrop={(event) => {
                event.preventDefault();
                event.currentTarget.classList.remove("dragging");
                handleFile(event.dataTransfer.files?.[0]);
              }}
              type="button"
            >
              {previewUrl ? (
                <img alt="已上传图片预览" src={previewUrl} />
              ) : (
                <span>{fileName ? `${fileName} 已选择` : "点击上传 JPG、PNG、PDF、DOCX 或 DOC"}</span>
              )}
            </button>
            <input
              accept="image/*,.pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
              hidden
              ref={fileInputRef}
              type="file"
              onChange={(event) => handleFile(event.target.files?.[0])}
            />
            <PasteCatcher onFile={handleFile} />

            <div className="progress-wrap">
              <div className="progress-label">
                <span>{readStatus}</span>
                <strong>{Math.round(readProgress * 100)}%</strong>
              </div>
              <div className="progress-track">
                <span style={{ width: `${readProgress * 100}%` }} />
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
                <p>先检查左侧原文。OCR 错字、漏字、身份证号错误、日期错误和地址缺失，都应该先修正再翻译。</p>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function PasteCatcher({ onFile }: { onFile: (file: File | undefined) => void }) {
  return (
    <div
      className="paste-catcher"
      contentEditable
      role="textbox"
      tabIndex={0}
      suppressContentEditableWarning
      onPaste={(event) => {
        const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
        if (file) {
          event.preventDefault();
          onFile(file);
          event.currentTarget.textContent = "";
        }
      }}
      onInput={(event) => {
        event.currentTarget.textContent = "";
      }}
    >
      也可以把截图/文件拖进上方区域，或点这里后直接 Ctrl+V 粘贴截图
    </div>
  );
}

function detectFileKind(file: File): FileKind {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx") || name.endsWith(".doc")) return "word";
  return "unknown";
}

async function extractPdfTextWithFallback(
  file: File,
  setProgress: (progress: number) => void,
  setStatus: (status: string) => void,
) {
  const pdfjs = (await import("pdfjs-dist")) as any;
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    setStatus(`正在读取 PDF 第 ${pageNumber} 页文字层`);
    setProgress(Math.min(0.82, pageNumber / Math.max(1, document.numPages) * 0.42));
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item: { str?: string }) => item.str ?? "").join(" ");
    if (text.trim().length >= 20) {
      pages.push(`第 ${pageNumber} 页\n${text}`);
    } else {
      setStatus(`PDF 第 ${pageNumber} 页像扫描页，正在转图片 OCR`);
      const image = await renderPdfPageToCanvas(page);
      const ocrText = await ocrCanvas(image);
      if (ocrText.trim()) pages.push(`第 ${pageNumber} 页 OCR\n${ocrText}`);
    }
  }

  return pages.join("\n\n").trim();
}

async function extractWordTextWithFallback(
  file: File,
  setProgress: (progress: number) => void,
  setStatus: (status: string) => void,
) {
  const mammoth = (await import("mammoth")) as any;
  const arrayBuffer = await file.arrayBuffer();
  setStatus("正在提取 Word 正文");
  setProgress(0.18);
  const result = await mammoth.extractRawText({ arrayBuffer });
  const parts = [String(result.value ?? "").trim()].filter(Boolean);

  setStatus("正在检查 Word 内嵌图片");
  setProgress(0.45);
  const imageTexts = await extractWordImageText(arrayBuffer, setProgress, setStatus);
  parts.push(...imageTexts);
  return parts.join("\n\n").trim();
}

async function extractWordImageText(
  arrayBuffer: ArrayBuffer,
  setProgress: (progress: number) => void,
  setStatus: (status: string) => void,
) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(arrayBuffer);
  const imageFiles = Object.values(zip.files).filter((entry) => /^word\/media\/.+\.(png|jpe?g|bmp|gif)$/i.test(entry.name));
  const texts: string[] = [];

  for (let index = 0; index < imageFiles.length; index += 1) {
    const entry = imageFiles[index];
    setStatus(`正在 OCR Word 图片 ${index + 1}/${imageFiles.length}`);
    setProgress(0.48 + (index / Math.max(1, imageFiles.length)) * 0.45);
    const blob = await entry.async("blob");
    const text = await readImageText(new File([blob], entry.name), () => undefined, () => undefined);
    if (text.trim()) texts.push(`Word 图片 ${index + 1} OCR\n${text}`);
  }

  return texts;
}

async function renderPdfPageToCanvas(page: any) {
  const viewport = page.getViewport({ scale: 2.4 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  await page.render({ canvasContext: context, viewport }).promise;
  return cropAndPreprocess(await createImageBitmap(canvas), { x: 0, y: 0, w: 1, h: 1 });
}

async function ocrCanvas(canvas: HTMLCanvasElement) {
  const worker = await getOcrWorker(() => undefined, () => undefined);
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
  });
  const response = await worker.recognize(canvas);
  return cleanupOcrText(response.data.text);
}

async function readImageText(
  file: File,
  setProgress: (progress: number) => void,
  setStatus: (status: string) => void,
) {
  const image = await preprocessImage(file, { autoCropDocument: true });
  const worker = await getOcrWorker(setProgress, setStatus);
  await worker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
  });
  const response = await worker.recognize(image);

  return cleanupOcrText(response.data.text);
}

async function readChineseIdCard(
  file: File,
  setProgress: (progress: number) => void,
  setStatus: (status: string) => void,
) {
  const original = await createImageBitmap(file);
  const cardCanvas = cropAndPreprocess(original, detectLikelyDocumentRegion(original));
  const bitmap = await createImageBitmap(cardCanvas);
  const regions = [
    { label: "姓名", x: 0.14, y: 0.16, w: 0.26, h: 0.08, psm: "7" },
    { label: "性别/民族", x: 0.14, y: 0.28, w: 0.34, h: 0.08, psm: "7" },
    { label: "出生", x: 0.14, y: 0.4, w: 0.44, h: 0.08, psm: "7" },
    { label: "住址", x: 0.14, y: 0.5, w: 0.52, h: 0.22, psm: "6" },
    { label: "公民身份号码", x: 0.25, y: 0.82, w: 0.58, h: 0.1, psm: "7" },
  ];
  const lines: string[] = [];

  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    setStatus(`正在识别${region.label}`);
    setProgress(0.08 + index * 0.16);
    const cropped = cropAndPreprocess(bitmap, region);
    const worker = await getOcrWorker(setProgress, setStatus);
    await worker.setParameters({
      tessedit_pageseg_mode: region.psm,
      preserve_interword_spaces: "1",
    });
    const response = await worker.recognize(cropped);
    const text = cleanupOcrText(response.data.text);
    const normalized = normalizeIdCardField(region.label, text);
    if (normalized) {
      if (region.label === "性别/民族") {
        lines.push(normalized);
      } else {
        lines.push(`${region.label}：${normalized}`);
      }
    }
  }

  if (lines.length < 3) return readImageText(file, setProgress, setStatus);
  return ["中华人民共和国居民身份证", ...lines].join("\n");
}

async function getOcrWorker(setProgress: (progress: number) => void, setStatus: (status: string) => void) {
  if (!sharedOcrWorker) {
    sharedOcrWorker = (async () => {
      const { createWorker } = await import("tesseract.js");
      setStatus("首次加载 OCR 中文/英文语言包");
      return createWorker("chi_sim+eng", 1, {
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        cacheMethod: "write",
        logger: (message: { status?: string; progress?: number }) => {
          if (typeof message.progress === "number") setProgress(Math.max(0.04, Math.min(0.95, message.progress)));
          if (message.status) setStatus(readableOcrStatus(message.status));
        },
      }) as Promise<OcrWorker>;
    })();
  }

  return sharedOcrWorker;
}

async function preprocessImage(file: File, options: { autoCropDocument?: boolean } = {}) {
  const bitmap = await createImageBitmap(file);
  const region = options.autoCropDocument ? detectLikelyDocumentRegion(bitmap) : { x: 0, y: 0, w: 1, h: 1 };
  return cropAndPreprocess(bitmap, region);
}

function cropAndPreprocess(
  bitmap: ImageBitmap,
  region: { x: number; y: number; w: number; h: number },
) {
  const sourceWidth = Math.round(bitmap.width * region.w);
  const sourceHeight = Math.round(bitmap.height * region.h);
  const scale = Math.min(6, Math.max(2.4, 2300 / Math.max(1, sourceWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;

  context.drawImage(
    bitmap,
    Math.round(bitmap.width * region.x),
    Math.round(bitmap.height * region.y),
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < data.data.length; index += 4) {
    const gray = data.data[index] * 0.3 + data.data[index + 1] * 0.59 + data.data[index + 2] * 0.11;
    const highContrast = gray > 178 ? 255 : Math.max(0, gray - 35);
    data.data[index] = highContrast;
    data.data[index + 1] = highContrast;
    data.data[index + 2] = highContrast;
  }
  context.putImageData(data, 0, 0);
  return canvas;
}

function detectLikelyDocumentRegion(bitmap: ImageBitmap) {
  const sampleWidth = 720;
  const scale = Math.min(1, sampleWidth / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { x: 0, y: 0, w: 1, h: 1 };
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const blueDocumentPixel = b > 120 && g > 95 && b > r + 18;
      if (blueDocumentPixel) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
      }
    }
  }

  if (count < 80 || maxX <= minX || maxY <= minY) return { x: 0, y: 0, w: 1, h: 1 };

  const padX = Math.round((maxX - minX) * 0.28);
  const padY = Math.round((maxY - minY) * 0.42);
  const left = Math.max(0, minX - padX);
  const top = Math.max(0, minY - padY);
  const right = Math.min(canvas.width, maxX + padX);
  const bottom = Math.min(canvas.height, maxY + padY);

  return {
    x: left / canvas.width,
    y: top / canvas.height,
    w: Math.max(0.2, (right - left) / canvas.width),
    h: Math.max(0.2, (bottom - top) / canvas.height),
  };
}

function normalizeIdCardField(label: string, text: string) {
  const compact = text.replace(/\s+/g, "");
  if (label === "性别/民族") {
    const sex = compact.includes("女") ? "女" : compact.includes("男") ? "男" : "待确认";
    const ethnicity = compact.includes("汉") ? "汉" : compact.replace(/[男女]/g, "") || "待确认";
    return `性别：${sex}\n民族：${ethnicity}`;
  }
  if (label === "出生") {
    const match = compact.match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
    return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : text;
  }
  if (label === "公民身份号码") {
    const id = compact.match(/\d{15,18}[\dXx]?/)?.[0];
    return id ?? text;
  }
  return text;
}

function cleanupOcrText(text: string) {
  return text
    .replace(/[|]+/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
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
