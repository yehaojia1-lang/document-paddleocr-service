const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);
const OCR_SERVICE_URL = (process.env.OCR_SERVICE_URL || "https://document-paddleocr-service.onrender.com").replace(/\/+$/, "");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "HEAD" && url.pathname === "/") return sendEmpty(res, 200);
    if (req.method === "GET" && url.pathname === "/") return sendHtml(res);
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && url.pathname === "/api/ocr") return proxyOcr(req, res);
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

async function translate(req, res) {
  const payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  const text = typeof payload.text === "string" ? payload.text : "";
  const direction = payload.direction === "en-to-zh" ? "en-to-zh" : "zh-to-en";
  const provider = payload.provider === "openai" || payload.provider === "deepseek" || payload.provider === "offline" ? payload.provider : "auto";
  const docType = typeof payload.docType === "string" ? payload.docType : "other";

  const providers = provider === "auto" ? ["deepseek", "openai"] : [provider];
  for (const name of providers) {
    const result = await callModel(name, text, direction, docType).catch(() => null);
    if (result) return sendJson(res, 200, result);
  }

  sendJson(res, 200, offlineTranslate(text, direction));
}

async function callModel(provider, text, direction, docType) {
  if (provider === "offline") return null;
  const isDeepSeek = provider === "deepseek";
  const key = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) return null;

  const response = await fetch(isDeepSeek ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: isDeepSeek ? process.env.DEEPSEEK_MODEL || "deepseek-chat" : process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a professional certified document translator. Translate all visible OCR text completely. Preserve document numbers, dates, ID numbers and codes exactly. English address order must be small-to-large. Chinese address order must be large-to-small. Return only JSON with keys mode,title,summary,fields,polished,notes. fields is an array of {label,source,translation}.",
        },
        {
          role: "user",
          content: `Document type: ${docType}\nDirection: ${direction}\nOCR text:\n${text}`,
        },
      ],
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? JSON.parse(content) : null;
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
    notes: ["离线翻译只能处理常见证件字段；专业长文本建议配置 DeepSeek 或 OpenAI API。"],
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
    main { width:min(1120px, 100%); margin:0 auto; padding:28px 16px 40px; }
    h1 { margin:0 0 8px; font-size:30px; }
    h2 { margin:0 0 16px; font-size:21px; }
    p { margin:0; color:var(--muted); line-height:1.7; }
    .top { display:flex; justify-content:space-between; gap:16px; align-items:flex-end; margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .panel { background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:18px; box-shadow:0 8px 24px rgba(18,37,28,.06); }
    .controls { display:flex; flex-wrap:wrap; gap:10px; margin:16px 0; }
    select, button, textarea { font:inherit; }
    select, textarea { border:1px solid var(--line); border-radius:6px; background:#fff; }
    select { padding:10px 12px; }
    button { border:0; border-radius:6px; padding:11px 16px; background:var(--green); color:#fff; font-weight:700; cursor:pointer; }
    button.secondary { background:#edf4ef; color:var(--green); border:1px solid var(--line); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .drop { min-height:260px; border:2px dashed #a9b8b0; border-radius:8px; display:grid; place-items:center; text-align:center; padding:14px; background:#fbfcfa; overflow:hidden; }
    .drop.drag { border-color:var(--green); background:#edf7f0; }
    .drop img { max-width:100%; max-height:360px; display:block; border-radius:4px; }
    textarea { width:100%; min-height:260px; padding:14px; resize:vertical; line-height:1.6; }
    .bar { height:9px; background:#dfe7e2; border-radius:999px; overflow:hidden; margin:10px 0 8px; }
    .bar span { display:block; height:100%; width:0; background:linear-gradient(90deg, var(--green), var(--gold)); transition:width .25s; }
    .result { white-space:pre-wrap; min-height:260px; border:1px solid var(--line); border-radius:6px; padding:14px; background:#fbfcfa; line-height:1.6; }
    .tiny { font-size:13px; color:var(--muted); }
    @media (max-width: 820px) { .grid { grid-template-columns:1fr; } .top { display:block; } h1 { font-size:25px; } }
  </style>
</head>
<body>
<main>
  <div class="top">
    <div>
      <h1>证件文件智能翻译</h1>
      <p>上传图片、PDF 或 Word，先 OCR 识别，再完整翻译。地址规则：英译中按大到小，中译英按小到大。</p>
    </div>
  </div>
  <section class="panel">
    <div class="controls">
      <select id="direction"><option value="zh-to-en">中文翻译成英文</option><option value="en-to-zh">英文/外文翻译成中文</option></select>
      <select id="docType"><option value="id-card">身份证</option><option value="driver-license">驾照</option><option value="graduation-certificate">毕业证</option><option value="degree-certificate">学位证</option><option value="birth-certificate">出生证</option><option value="other">其他文件</option></select>
      <select id="provider"><option value="auto">自动选择模型</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="offline">离线规则</option></select>
    </div>
    <div class="grid">
      <div>
        <h2>上传 / 拖拽 / 粘贴</h2>
        <input id="file" type="file" accept="image/*,.pdf,.doc,.docx" />
        <div id="drop" class="drop" tabindex="0"><p>选择文件，或把文件拖进这里。电脑也可以点击这里后 Ctrl+V 粘贴截图。</p></div>
        <div class="controls"><button id="ocrBtn">开始 OCR</button><button class="secondary" id="copyOcr">复制识别文本</button></div>
        <p id="status" class="tiny">等待上传文件</p><div class="bar"><span id="progress"></span></div>
      </div>
      <div>
        <h2>识别结果</h2>
        <textarea id="source" placeholder="OCR 文字会出现在这里，可手动校对后再翻译。"></textarea>
      </div>
    </div>
  </section>
  <section class="panel" style="margin-top:16px">
    <div class="controls"><button id="translateBtn">生成译文</button><button class="secondary" id="copyResult">复制译文</button></div>
    <div id="result" class="result">译文会出现在这里。</div>
  </section>
</main>
<script>
let selectedFile = null;
const $ = (id) => document.getElementById(id);
function setProgress(n, text) { $("progress").style.width = Math.round(n * 100) + "%"; if (text) $("status").textContent = text; }
function showFile(file) {
  selectedFile = file;
  $("drop").innerHTML = "";
  if (file && file.type.startsWith("image/")) {
    const img = document.createElement("img"); img.src = URL.createObjectURL(file); $("drop").appendChild(img);
  } else {
    $("drop").innerHTML = "<p>" + (file ? file.name : "等待上传文件") + "</p>";
  }
  setProgress(0, file ? "已选择文件：" + file.name : "等待上传文件");
}
$("file").addEventListener("change", e => showFile(e.target.files[0]));
$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("dragover", e => { e.preventDefault(); $("drop").classList.add("drag"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("drag"));
$("drop").addEventListener("drop", e => { e.preventDefault(); $("drop").classList.remove("drag"); showFile(e.dataTransfer.files[0]); });
$("drop").addEventListener("paste", e => { const file = [...e.clipboardData.files][0]; if (file) showFile(file); });
document.addEventListener("paste", e => { const file = [...e.clipboardData.files][0]; if (file) showFile(file); });
$("ocrBtn").addEventListener("click", async () => {
  if (!selectedFile) return alert("请先选择文件");
  setProgress(.15, "正在上传到 OCR 服务");
  const form = new FormData();
  form.set("file", selectedFile, selectedFile.name || "upload");
  form.set("mode", $("docType").value === "id-card" ? "id" : "full");
  form.set("doc_type", $("docType").value);
  const res = await fetch("/api/ocr", { method:"POST", body: form });
  const data = await res.json();
  $("source").value = data.text || "";
  setProgress(1, data.text ? "识别完成，请校对后翻译" : (data.warning || data.error || "没有识别到文字"));
});
$("translateBtn").addEventListener("click", async () => {
  const text = $("source").value.trim();
  if (!text) return alert("请先 OCR 或粘贴原文");
  $("result").textContent = "正在生成译文...";
  const res = await fetch("/api/translate", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ text, direction:$("direction").value, docType:$("docType").value, provider:$("provider").value }) });
  const data = await res.json();
  const fields = Array.isArray(data.fields) ? data.fields.map(f => (f.label || "Text") + ": " + (f.translation || "")).join("\\n") : "";
  $("result").textContent = [data.title, data.summary, fields, data.polished].filter(Boolean).join("\\n\\n");
});
$("copyOcr").addEventListener("click", () => navigator.clipboard.writeText($("source").value));
$("copyResult").addEventListener("click", () => navigator.clipboard.writeText($("result").textContent));
</script>
</body>
</html>`);
}
