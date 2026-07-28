const http = require("node:http");
const mammoth = require("mammoth");

const PORT = Number(process.env.PORT || 3000);
const OCR_SERVICE_URL = (process.env.OCR_SERVICE_URL || "https://document-paddleocr-service.onrender.com").replace(/\/+$/, "");
const TEMPLATE_TEXT_LIMIT = 14000;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "HEAD" && url.pathname === "/") return sendEmpty(res, 200);
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        ocrService: OCR_SERVICE_URL,
        deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/ocr") return proxyOcr(req, res);
    if (req.method === "POST" && url.pathname === "/api/template") return extractTemplate(req, res);
    if (req.method === "POST" && url.pathname === "/api/translate") return translate(req, res);
    sendText(res, 404, "Not found");
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Frontend running on ${PORT}`);
});

async function proxyOcr(req, res) {
  const body = await readBody(req);
  const response = await fetch(`${OCR_SERVICE_URL}/ocr`, {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] || "multipart/form-data" },
    body,
  });
  const text = await response.text();
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json; charset=utf-8" });
  res.end(text);
}

async function extractTemplate(req, res) {
  const body = await readBody(req);
  const parts = parseMultipart(body, req.headers["content-type"] || "");
  const file = parts.find((part) => part.filename);
  if (!file) return sendJson(res, 400, { error: "No template file was uploaded." });

  const name = file.filename.toLowerCase();
  let text = "";
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: file.data });
    text = result.value || "";
  } else {
    text = file.data.toString("utf8");
  }

  text = cleanTemplateText(text).slice(0, TEMPLATE_TEXT_LIMIT);
  sendJson(res, 200, { filename: file.filename, text, chars: text.length });
}

async function translate(req, res) {
  const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const direction = payload.direction === "en-to-zh" ? "en-to-zh" : "zh-to-en";
  const provider = payload.provider === "openai" || payload.provider === "deepseek" || payload.provider === "custom" || payload.provider === "offline" ? payload.provider : "auto";
  const docType = typeof payload.docType === "string" ? payload.docType : "other";
  const templateText = typeof payload.templateText === "string" ? cleanTemplateText(payload.templateText).slice(0, TEMPLATE_TEXT_LIMIT) : "";
  const modelConfig = {
    apiKey: typeof payload.apiKey === "string" ? payload.apiKey.trim() : "",
    baseUrl: typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "",
    model: typeof payload.model === "string" ? payload.model.trim() : "",
  };

  if (!text) return sendJson(res, 400, { error: "No OCR text was provided." });

  const providers = provider === "auto" ? ["deepseek", "openai"] : [provider];
  for (const name of providers) {
    const result = await callModel(name, text, direction, docType, templateText, modelConfig).catch((error) => ({
      error: error instanceof Error ? error.message : "Model request failed",
    }));
    if (result && !result.error) return sendJson(res, 200, result);
  }

  if (provider === "deepseek" || provider === "openai" || provider === "custom") {
    return sendJson(res, 200, modelUnavailable(provider, direction));
  }

  sendJson(res, 200, offlineTranslate(text, direction));
}

async function callModel(provider, text, direction, docType, templateText, modelConfig = {}) {
  if (provider === "offline") return null;
  const isDeepSeek = provider === "deepseek";
  const isCustom = provider === "custom";
  const key = modelConfig.apiKey || (isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY);
  if (!key) return null;
  const model = modelConfig.model || (isDeepSeek ? process.env.DEEPSEEK_MODEL || "deepseek-chat" : process.env.OPENAI_MODEL || "gpt-4.1-mini");
  const baseUrl = modelConfig.baseUrl || (isDeepSeek ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const endpoint = normalizeChatCompletionsUrl(baseUrl, isCustom ? "custom" : provider);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.05,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(templateText),
        },
        {
          role: "user",
          content: `Document type: ${docType}
Target language: ${direction === "en-to-zh" ? "Simplified Chinese" : "professional English"}

OCR text to translate:
${text}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("Model returned no content");
  return normalizeModelResult(JSON.parse(content), provider);
}

function normalizeChatCompletionsUrl(baseUrl, provider) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) return provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

function buildSystemPrompt(templateText) {
  const baseRules = [
    "You are a professional certified document translator for identity documents, driver licenses, birth certificates, graduation certificates, degree certificates, and official records.",
    "The OCR text may contain noise. Correct only obvious OCR errors from context. If a value is unreadable, write '无法辨认' for Chinese output or 'illegible' for English output.",
    "Translate every visible item completely. Do not omit labels, numbers, dates, addresses, document numbers, restrictions, issuing authorities, signatures, notes, categories, or back-side text.",
    "Never merely repeat the source language. Every field must be translated into the target language unless it is a name, code, ID number, document number, date, or other value that should be preserved.",
    "Follow the user's reference template and translation rules above your own wording. Use its document titles, field labels, sentence order, and standard expressions whenever applicable.",
    "Address rule is strict. For English-to-Chinese, translate the full address into Chinese in large-to-small order, including country/state/province, city/town, street name, street number, apartment/unit/room, and ZIP/postal code. Example: '101 MONMOUTH ST APT 520 BROOKLINE, MA 02446-5613' -> '美国马萨诸塞州布鲁克莱恩市蒙茅斯街101号520公寓，邮政编码02446-5613'.",
    "For Chinese-to-English addresses, use small-to-large order and translate all administrative divisions and building/unit details. Do not drop road names, community names, building numbers, units, rooms, or postal codes.",
    "Use standard document wording: Sex, Ethnicity, Date of Birth, Address, Citizen ID Number, Name; Driver License, License Number, Date of Issue, Date of Expiry, Class, Restrictions; Birth Certificate, Father, Mother, Place of Birth; Graduation Certificate, Degree Certificate, Major, School, President, Certificate No.",
    "For Chinese personal names translated into English, use the template style if supplied. Otherwise use pinyin in normal name order with surname first only when the template indicates that style.",
    "Return only JSON with keys mode,title,summary,fields,polished,notes. fields is an array of {label,source,translation}. polished must be a complete professional translation ready to copy.",
  ];
  if (!templateText) return baseRules.join("\n");
  return `${baseRules.join("\n")}

Reference template / translation rules supplied by the user. Treat this as the preferred terminology and style guide:
${templateText}`;
}

function normalizeModelResult(value, provider) {
  return {
    mode: typeof value.mode === "string" ? value.mode : provider,
    title: typeof value.title === "string" ? value.title : "Professional Document Translation",
    summary: typeof value.summary === "string" ? value.summary : "The translation was generated by the selected model.",
    fields: Array.isArray(value.fields) ? value.fields : [],
    polished: typeof value.polished === "string" ? value.polished : "",
    notes: Array.isArray(value.notes) ? value.notes : [],
  };
}

function modelUnavailable(provider, direction) {
  return {
    mode: "model unavailable",
    title: provider === "deepseek" ? "DeepSeek 未接通" : provider === "openai" ? "OpenAI 未接通" : "自定义 API 未接通",
    summary: `当前选择了 ${provider}，但服务端没有可用密钥，或模型调用失败，所以没有生成专业译文。`,
    fields: [],
    polished: direction === "zh-to-en" ? "Model unavailable. Please check the API settings on this page." : "模型不可用。请检查本页 API 设置。",
    notes: ["可以在页面的 API 设置里填写 API Key、Base URL 和模型名。"],
  };
}

function offlineTranslate(text, direction) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = lines.slice(0, 80).map((line) => ({
    label: inferLabel(line),
    source: line,
    translation: direction === "zh-to-en" ? simpleZhToEn(line) : line,
  }));
  return {
    mode: "offline rules",
    title: direction === "zh-to-en" ? "Offline Chinese-to-English Translation" : "Offline English-to-Chinese Translation",
    summary: "未配置模型密钥，已使用离线规则。请先校对 OCR 原文，尤其是姓名、地址、日期和证件号码。",
    fields,
    polished: fields.map((field) => `${field.label}: ${field.translation}`).join("\n"),
    notes: ["离线翻译只能处理常见证件字段；专业完整译文建议配置 DeepSeek 或 OpenAI API。"],
  };
}

function inferLabel(line) {
  if (/\d{17}[\dXx]|\d{15}/.test(line)) return "Citizen ID Number";
  if (/姓名|Name/i.test(line)) return "Name";
  if (/性别|Sex/i.test(line)) return "Sex";
  if (/民族|Ethnicity/i.test(line)) return "Ethnicity";
  if (/出生|Date of Birth|DOB/i.test(line)) return "Date of Birth";
  if (/住址|地址|Address|Road|Street|Avenue/i.test(line)) return "Address";
  return "Text";
}

function simpleZhToEn(value) {
  return value
    .replace(/中华人民共和国居民身份证/g, "Citizen Identity Card of the People's Republic of China")
    .replace(/姓名/g, "Name")
    .replace(/性别/g, "Sex")
    .replace(/民族/g, "Ethnicity")
    .replace(/出生/g, "Date of Birth")
    .replace(/住址|地址/g, "Address")
    .replace(/公民身份号码/g, "Citizen ID Number")
    .replace(/男/g, "Male")
    .replace(/女/g, "Female")
    .replace(/汉/g, "Han");
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return [];
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd === -1) break;
    const headers = body.slice(start, headerEnd).toString("utf8");
    let dataStart = headerEnd + 4;
    let next = body.indexOf(boundary, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    const name = /name="([^"]+)"/i.exec(headers)?.[1] || "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] || "";
    parts.push({ name, filename, headers, data: body.slice(dataStart, dataEnd) });
    start = next;
  }
  return parts;
}

function cleanTemplateText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

function sendHtml(res) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>证件文件智能翻译</title>
  <style>
    :root { color-scheme: light; --green:#0f7a4e; --ink:#17211d; --muted:#6a746f; --line:#d9e0dc; --bg:#f5f7f3; --paper:#fff; --gold:#d49b22; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, "Microsoft YaHei", sans-serif; color:var(--ink); background:var(--bg); }
    main { width:min(1180px, 100%); margin:0 auto; padding:28px 16px 40px; }
    h1 { margin:0 0 8px; font-size:30px; }
    h2 { margin:0 0 16px; font-size:21px; }
    p { margin:0; color:var(--muted); line-height:1.7; }
    .top { margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .panel { background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:18px; box-shadow:0 8px 24px rgba(18,37,28,.06); }
    .controls { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; }
    select, button, textarea, input { font:inherit; }
    select, textarea { border:1px solid var(--line); border-radius:6px; background:#fff; }
    select { padding:10px 12px; }
    input[type="password"], input[type="text"], input[type="url"] { min-height:44px; border-radius:6px; border:1px solid var(--line); background:#fff; color:var(--text); padding:0 12px; width:100%; }
    button { border:0; border-radius:6px; padding:11px 16px; background:var(--green); color:#fff; font-weight:700; cursor:pointer; }
    button.secondary { background:#edf4ef; color:var(--green); border:1px solid var(--line); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .drop { min-height:240px; border:2px dashed #a9b8b0; border-radius:8px; display:grid; place-items:center; text-align:center; padding:14px; background:#fbfcfa; overflow:hidden; }
    .template-drop { min-height:92px; border:2px dashed #a9b8b0; border-radius:8px; display:grid; place-items:center; text-align:center; padding:12px; background:#fbfcfa; color:var(--muted); cursor:pointer; }
    .template-drop.drag { border-color:var(--green); background:#edf7f0; color:var(--text); }
    .drop.drag { border-color:var(--green); background:#edf7f0; }
    .drop img { max-width:100%; max-height:330px; display:block; border-radius:4px; }
    textarea { width:100%; min-height:240px; padding:14px; resize:vertical; line-height:1.6; }
    .bar { height:9px; background:#dfe7e2; border-radius:999px; overflow:hidden; margin:10px 0 8px; }
    .bar span { display:block; height:100%; width:0; background:linear-gradient(90deg, var(--green), var(--gold)); transition:width .25s; }
    .result { white-space:pre-wrap; min-height:280px; border:1px solid var(--line); border-radius:6px; padding:14px; background:#fbfcfa; line-height:1.6; }
    .tiny { font-size:13px; color:var(--muted); }
    .api-grid { display:grid; grid-template-columns:1.2fr 1.2fr 1fr; gap:10px; margin-top:10px; }
    .api-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
    @media (max-width: 820px) { .grid { grid-template-columns:1fr; } h1 { font-size:25px; } }
    @media (max-width: 820px) { .api-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<main>
  <div class="top">
    <h1>证件文件智能翻译</h1>
    <p>左边上传要翻译的文件，右边上传参考模板或翻译规范。DeepSeek 会按模板表达、字段名称和地址规则生成译文。</p>
  </div>

  <section class="panel">
    <div class="controls">
      <select id="direction"><option value="zh-to-en">中文翻译成英文</option><option value="en-to-zh">英文/外文翻译成中文</option></select>
      <select id="docType"><option value="id-card">身份证</option><option value="household-register">户口本</option><option value="driver-license">驾照</option><option value="graduation-certificate">毕业证</option><option value="degree-certificate">学位证</option><option value="birth-certificate">出生证</option><option value="other">其他文件</option></select>
      <select id="provider"><option value="auto">自动选择模型</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="custom">自定义 API</option><option value="offline">离线规则</option></select>
      <button id="clearBtn" class="secondary" type="button">清空全部</button>
    </div>
    <details>
      <summary><strong>API 设置</strong></summary>
      <div class="api-grid">
        <label>API Key<input id="apiKey" type="password" autocomplete="off" placeholder="sk-..." /></label>
        <label>Base URL<input id="apiBaseUrl" type="url" placeholder="https://api.deepseek.com 或 https://api.openai.com/v1" /></label>
        <label>模型名<input id="apiModel" type="text" placeholder="deepseek-chat / gpt-4.1-mini" /></label>
      </div>
      <div class="api-actions"><button id="saveApi" type="button">保存 API 设置</button><button id="clearApi" class="secondary" type="button">清除 API 设置</button></div>
      <p id="apiStatus" class="tiny">填写后会优先使用这里的模型设置；不填写则使用后台默认 DeepSeek。</p>
    </details>
    <div class="grid">
      <div>
        <h2>上传待翻译文件</h2>
        <input id="file" type="file" accept="image/*,.pdf,.doc,.docx" multiple />
        <div id="drop" class="drop" tabindex="0"><p>选择文件，或把文件拖进这里。电脑也可以点击这里后 Ctrl+V 粘贴截图。</p></div>
        <div class="controls"><button id="ocrBtn">开始 OCR</button><button class="secondary" id="copyOcr">复制识别文本</button></div>
        <p id="status" class="tiny">等待上传文件</p><div class="bar"><span id="progress"></span></div>
      </div>
      <div>
        <h2>上传参考模板 / 规则</h2>
        <input id="templateFile" type="file" accept=".docx,.txt,.md" />
        <div id="templateDrop" class="template-drop" tabindex="0"><p>选择模板文件，或把 Word / TXT / MD 规则文件拖到这里。</p></div>
        <div class="controls"><button id="saveTemplateMemory" type="button">保存到模板库</button><button id="clearTemplateMemory" class="secondary" type="button">删除选中模板</button></div>
        <select id="templateMemoryList"><option value="">模板库会显示在这里</option></select>
        <textarea id="templateText" placeholder="模板文字会出现在这里；也可以直接粘贴翻译规范、术语表或示例译文。"></textarea>
        <p id="templateStatus" class="tiny">可上传身份证、出生证、毕业证等 Word 模板，或粘贴你的翻译规则。</p>
      </div>
    </div>
  </section>

  <section class="panel" style="margin-top:16px">
    <div class="grid">
      <div>
        <h2>识别结果</h2>
        <textarea id="source" placeholder="OCR 文字会出现在这里，可手动校对后再翻译。"></textarea>
      </div>
      <div>
        <h2>译文</h2>
        <div class="controls"><button id="translateBtn">生成译文</button><button class="secondary" id="copyResult">复制译文</button></div>
        <div id="result" class="result">译文会出现在这里。</div>
      </div>
    </div>
  </section>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
let selectedFiles = [];
const $ = (id) => document.getElementById(id);
const NL = String.fromCharCode(10);
const API_STORAGE_KEY = "documentTranslationApiSettings";
const TEMPLATE_STORAGE_KEY = "documentTranslationTemplateMemory";
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
function setProgress(n, text) { $("progress").style.width = Math.round(n * 100) + "%"; if (text) $("status").textContent = text; }
function loadApiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(API_STORAGE_KEY) || "{}");
    if (saved.provider) $("provider").value = saved.provider;
    $("apiKey").value = saved.apiKey || "";
    $("apiBaseUrl").value = saved.baseUrl || "";
    $("apiModel").value = saved.model || "";
    $("apiStatus").textContent = saved.apiKey ? "已加载本机保存的 API 设置。" : "填写后会优先使用这里的模型设置；不填写则使用后台默认 DeepSeek。";
  } catch {
    $("apiStatus").textContent = "API 设置读取失败，可以重新填写后保存。";
  }
}
function saveApiSettings() {
  const settings = {
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    baseUrl: $("apiBaseUrl").value.trim(),
    model: $("apiModel").value.trim(),
  };
  localStorage.setItem(API_STORAGE_KEY, JSON.stringify(settings));
  $("apiStatus").textContent = "API 设置已保存到当前浏览器。";
}
function clearApiSettings() {
  localStorage.removeItem(API_STORAGE_KEY);
  $("apiKey").value = "";
  $("apiBaseUrl").value = "";
  $("apiModel").value = "";
  $("apiStatus").textContent = "API 设置已清除。";
}
function docTypeLabel(value) {
  const labels = {
    "id-card": "身份证",
    "household-register": "户口本",
    "driver-license": "驾照",
    "graduation-certificate": "毕业证",
    "degree-certificate": "学位证",
    "birth-certificate": "出生证",
    other: "其他文件",
  };
  return labels[value] || labels.other;
}
function inferDocTypeFromName(name) {
  const value = String(name || "").toLowerCase();
  if (/户口|户籍|household|hukou|register/.test(value)) return "household-register";
  if (/身份证|identity|id card|citizen/.test(value)) return "id-card";
  if (/驾照|驾驶|driver|license|licence/.test(value)) return "driver-license";
  if (/毕业|graduation|diploma/.test(value)) return "graduation-certificate";
  if (/学位|degree/.test(value)) return "degree-certificate";
  if (/出生|birth/.test(value)) return "birth-certificate";
  return "";
}
function readTemplateLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || "[]");
    if (Array.isArray(raw)) return raw.filter(item => item && item.text);
    if (raw && raw.text) {
      return [{
        id: "legacy-" + Date.now(),
        name: raw.name || "旧版模板记忆",
        docType: raw.docType || "other",
        text: raw.text,
        savedAt: raw.savedAt || new Date().toISOString(),
      }];
    }
  } catch {}
  return [];
}
function writeTemplateLibrary(items) {
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(items));
}
function renderTemplateLibrary(selectedId = "") {
  const items = readTemplateLibrary();
  const list = $("templateMemoryList");
  list.innerHTML = "";
  const currentType = $("docType").value;
  const matching = items.filter(item => item.docType === currentType);
  const summary = document.createElement("option");
  summary.value = "";
  summary.textContent = items.length ? "模板库：共 " + items.length + " 条；当前类型匹配 " + matching.length + " 条" : "模板库为空";
  list.appendChild(summary);
  items.forEach(item => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = "[" + docTypeLabel(item.docType) + "] " + item.name + "（" + item.text.length + "字）";
    list.appendChild(option);
  });
  list.value = selectedId;
}
function applyTemplateMemoryByDocType() {
  const items = readTemplateLibrary();
  renderTemplateLibrary();
  const currentType = $("docType").value;
  const matching = items.filter(item => item.docType === currentType);
  if (!matching.length) {
    $("templateText").value = "";
    $("templateDrop").innerHTML = "<p>选择模板文件，或把 Word / TXT / MD 规则文件拖到这里。</p>";
    $("templateStatus").textContent = items.length ? "模板库已有 " + items.length + " 条，但当前" + docTypeLabel(currentType) + "没有匹配模板。" : "模板库为空，可上传模板后自动记住。";
    return;
  }
  $("templateText").value = matching.map(item => "【" + docTypeLabel(item.docType) + "模板：" + item.name + "】" + NL + item.text).join(NL + NL + "---" + NL + NL);
  $("templateDrop").innerHTML = "<p>已自动匹配 " + matching.length + " 条" + docTypeLabel(currentType) + "模板</p>";
  $("templateStatus").textContent = "已自动加载" + docTypeLabel(currentType) + "模板 " + matching.length + " 条。";
}
function saveTemplateMemory(name = "手动保存的模板规则", forcedText = "") {
  const text = (forcedText || $("templateText").value).trim();
  if (!text) {
    $("templateStatus").textContent = "模板框为空，不能保存。";
    return;
  }
  const guessedType = inferDocTypeFromName(name);
  const docType = guessedType || $("docType").value || "other";
  if (guessedType) $("docType").value = guessedType;
  const items = readTemplateLibrary();
  const existingIndex = items.findIndex(item => item.name === name && item.docType === docType);
  const entry = { id: existingIndex >= 0 ? items[existingIndex].id : "tpl-" + Date.now() + "-" + Math.random().toString(16).slice(2), name, docType, text, savedAt: new Date().toISOString() };
  if (existingIndex >= 0) items[existingIndex] = entry;
  else items.push(entry);
  writeTemplateLibrary(items);
  renderTemplateLibrary(entry.id);
  applyTemplateMemoryByDocType();
  $("templateMemoryList").value = entry.id;
  $("templateStatus").textContent = "已保存到模板库：[" + docTypeLabel(docType) + "] " + name + "（" + text.length + " 字）。";
}
function deleteSelectedTemplateMemory() {
  const selectedId = $("templateMemoryList").value;
  if (!selectedId) {
    $("templateStatus").textContent = "请先在模板库下拉框里选择要删除的模板。";
    return;
  }
  const items = readTemplateLibrary();
  const target = items.find(item => item.id === selectedId);
  writeTemplateLibrary(items.filter(item => item.id !== selectedId));
  applyTemplateMemoryByDocType();
  $("templateStatus").textContent = "已删除选中模板：" + (target ? target.name : selectedId) + "。其他模板仍然保留。";
}
function loadTemplateMemory() {
  applyTemplateMemoryByDocType();
}
function resetPage() {
  selectedFiles = [];
  $("file").value = "";
  $("templateFile").value = "";
  $("source").value = "";
  $("result").textContent = "译文会出现在这里。";
  $("drop").innerHTML = "<p>选择文件，或把文件拖进这里。电脑也可以点击这里后 Ctrl+V 粘贴截图。</p>";
  loadTemplateMemory();
  setProgress(0, "等待上传文件");
}
function showFiles(files) {
  selectedFiles = Array.from(files || []).filter(Boolean);
  const guessedType = selectedFiles.map(file => inferDocTypeFromName(file.name)).find(Boolean);
  if (guessedType) {
    $("docType").value = guessedType;
    applyTemplateMemoryByDocType();
  }
  $("drop").innerHTML = "";
  if (selectedFiles.length === 1 && selectedFiles[0].type.startsWith("image/")) {
    const img = document.createElement("img"); img.src = URL.createObjectURL(selectedFiles[0]); $("drop").appendChild(img);
  } else if (selectedFiles.length > 0) {
    $("drop").innerHTML = "<p>" + selectedFiles.map((file, index) => (index + 1) + ". " + file.name).join("<br>") + "</p>";
  } else {
    $("drop").innerHTML = "<p>等待上传文件</p>";
  }
  setProgress(0, selectedFiles.length ? "已选择 " + selectedFiles.length + " 个文件" : "等待上传文件");
}
function stripFirstPagePrefix(text) {
  const prefix = "Page 1" + NL;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
function pageBlock(index, fileName, text) {
  return "Page " + (index + 1) + " - " + fileName + NL + text;
}
async function makePdfUploadFile(file) {
  if (!window.pdfjsLib) return { uploadFile: file, text: "" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const textContent = await page.getTextContent();
  const text = textContent.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim();
  if (text.length >= 20) {
    return { uploadFile: file, text: "Page 1\\n" + text };
  }

  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) return { uploadFile: file, text: "" };
  const imageName = (file.name || "document.pdf").replace(/\\.pdf$/i, "") + "-page-1.jpg";
  return { uploadFile: new File([blob], imageName, { type: "image/jpeg" }), text: "" };
}
async function loadPdf(file) {
  if (!window.pdfjsLib) throw new Error("PDF reader is not loaded");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return await pdfjsLib.getDocument({ data: bytes }).promise;
}
async function extractPdfPageText(page) {
  const textContent = await page.getTextContent();
  return textContent.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim();
}
async function renderPdfPageToImageFile(file, page, pageNumber) {
  const viewport = page.getViewport({ scale: 1.55 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("PDF page render failed");
  const baseName = (file.name || "document.pdf").replace(/\\.pdf$/i, "");
  return new File([blob], baseName + "-page-" + pageNumber + ".jpg", { type: "image/jpeg" });
}
async function ocrUploadFile(uploadFile) {
  const form = new FormData();
  form.set("file", uploadFile, uploadFile.name || "upload");
  form.set("mode", $("docType").value === "id-card" ? "id" : "full");
  form.set("doc_type", $("docType").value);
  return await ocrUploadFormWithRetry(form);
}
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function ocrUploadFormWithRetry(form) {
  const endpoints = ["/api/ocr", "https://document-paddleocr-service.onrender.com/ocr"];
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetchWithTimeout(endpoint, { method:"POST", body: form }, 240000);
        const data = await res.json();
        if (res.ok && data && (data.text || data.warning)) return data;
        lastError = data?.error || data?.detail || res.statusText || "OCR 没有返回文本";
      } catch (error) {
        lastError = error.name === "AbortError" ? "OCR 等待超时" : ("OCR 请求失败：" + (error.message || error));
      }
    }
    setProgress(Math.min(0.95, Number($("progress").style.width.replace("%", "")) / 100 || 0), "OCR 正在自动重试第 " + (attempt + 1) + " 次");
  }
  return { error: lastError + "。已重试 3 次；建议单独截图该页再试。" };
}
$("file").addEventListener("change", e => showFiles(e.target.files));
$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("dragover", e => { e.preventDefault(); $("drop").classList.add("drag"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("drag"));
$("drop").addEventListener("drop", e => { e.preventDefault(); $("drop").classList.remove("drag"); showFiles(e.dataTransfer.files); });
$("drop").addEventListener("paste", e => { const files = [...e.clipboardData.files]; if (files.length) showFiles(files); });
document.addEventListener("paste", e => { const files = [...e.clipboardData.files]; if (files.length) showFiles(files); });
async function readTemplateFile(file) {
  if (!file) return;
  $("templateDrop").innerHTML = "<p>" + file.name + "</p>";
  $("templateStatus").textContent = "正在读取模板：" + file.name;
  const form = new FormData();
  form.set("file", file, file.name);
  const res = await fetch("/api/template", { method:"POST", body: form });
  const data = await res.json();
  if (data.error) {
    $("templateStatus").textContent = data.error;
    return;
  }
  $("templateText").value = data.text || "";
  $("templateStatus").textContent = "已读取模板：" + file.name + "（" + (data.chars || 0) + " 字）";
  if (data.text) saveTemplateMemory(file.name);
}
$("templateFile").addEventListener("change", e => readTemplateFile(e.target.files[0]));
$("docType").addEventListener("change", applyTemplateMemoryByDocType);
$("templateMemoryList").addEventListener("change", () => {
  const selectedId = $("templateMemoryList").value;
  const item = readTemplateLibrary().find(entry => entry.id === selectedId);
  if (!item) return applyTemplateMemoryByDocType();
  $("docType").value = item.docType;
  $("templateText").value = item.text;
  $("templateDrop").innerHTML = "<p>" + item.name + "</p>";
  $("templateStatus").textContent = "已选择模板：[" + docTypeLabel(item.docType) + "] " + item.name + "（" + item.text.length + " 字）";
});
$("templateDrop").addEventListener("click", () => $("templateFile").click());
$("templateDrop").addEventListener("dragover", e => { e.preventDefault(); $("templateDrop").classList.add("drag"); });
$("templateDrop").addEventListener("dragleave", () => $("templateDrop").classList.remove("drag"));
$("templateDrop").addEventListener("drop", e => { e.preventDefault(); $("templateDrop").classList.remove("drag"); readTemplateFile(e.dataTransfer.files[0]); });
$("templateDrop").addEventListener("paste", e => {
  const file = [...e.clipboardData.files][0];
  if (!file) return;
  e.preventDefault();
  e.stopPropagation();
  readTemplateFile(file);
});
$("ocrBtn").addEventListener("click", async () => {
  if (!selectedFiles.length) return alert("请先选择文件");
  const results = [];
  $("source").value = "";
  $("ocrBtn").disabled = true;
  try {
    for (let i = 0; i < selectedFiles.length; i++) {
      const selectedFile = selectedFiles[i];
      const isPdf = selectedFile.name && selectedFile.name.toLowerCase().endsWith(".pdf");
      if (isPdf && window.pdfjsLib) {
        try {
          const pdf = await loadPdf(selectedFile);
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            setProgress(0.05 + 0.9 * ((pageNumber - 1) / Math.max(1, pdf.numPages)), "正在识别 PDF 第 " + pageNumber + " / " + pdf.numPages + " 页");
            const page = await pdf.getPage(pageNumber);
            const pageName = selectedFile.name + " 第" + pageNumber + "页";
            const text = await extractPdfPageText(page);
            if (text.length >= 20) {
              results.push(pageBlock(results.length, pageName, text));
            } else {
              const pageFile = await renderPdfPageToImageFile(selectedFile, page, pageNumber);
              const data = await ocrUploadFile(pageFile);
              results.push(pageBlock(results.length, pageName, data.text || data.warning || data.error || "没有识别到文字"));
            }
            $("source").value = results.join(NL + NL);
          }
          continue;
        } catch (err) {
          console.warn("PDF all-page processing failed; falling back to server OCR", err);
        }
      }

      setProgress(i / selectedFiles.length, "正在识别第 " + (i + 1) + " / " + selectedFiles.length + " 个文件");
      const data = await ocrUploadFile(selectedFile);
      results.push(pageBlock(results.length, selectedFile.name, data.text || data.warning || data.error || "没有识别到文字"));
      $("source").value = results.join(NL + NL);
      setProgress((i + 1) / selectedFiles.length, "已完成 " + (i + 1) + " / " + selectedFiles.length + " 个文件");
    }
    setProgress(1, "识别完成，请校对后翻译");
  } finally {
    $("ocrBtn").disabled = false;
  }
});
$("translateBtn").addEventListener("click", async () => {
  const text = $("source").value.trim();
  if (!text) return alert("请先 OCR 或粘贴原文");
  $("result").textContent = "正在按模板生成译文...";
  const res = await fetch("/api/translate", {
    method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({
      text,
      templateText:$("templateText").value,
      direction:$("direction").value,
      docType:$("docType").value,
      provider:$("provider").value,
      apiKey:$("apiKey").value.trim(),
      baseUrl:$("apiBaseUrl").value.trim(),
      model:$("apiModel").value.trim()
    })
  });
  const data = await res.json();
  if (data.error) {
    $("result").textContent = data.error;
    return;
  }
  const fields = Array.isArray(data.fields) ? data.fields.map(f => (f.label || "Text") + ": " + (f.translation || "")).join("\\n") : "";
  $("result").textContent = [data.title, data.summary, fields, data.polished].filter(Boolean).join("\\n\\n");
});
$("copyOcr").addEventListener("click", () => navigator.clipboard.writeText($("source").value));
$("copyResult").addEventListener("click", () => navigator.clipboard.writeText($("result").textContent));
$("saveApi").addEventListener("click", saveApiSettings);
$("clearApi").addEventListener("click", clearApiSettings);
$("saveTemplateMemory").addEventListener("click", () => saveTemplateMemory());
$("clearTemplateMemory").addEventListener("click", deleteSelectedTemplateMemory);
$("clearBtn").addEventListener("click", resetPage);
loadApiSettings();
loadTemplateMemory();
window.addEventListener("pageshow", resetPage);
</script>
</body>
</html>`);
}
