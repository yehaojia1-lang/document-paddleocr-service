exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const payload = JSON.parse(event.body || "{}");
  const text = typeof payload.text === "string" ? payload.text : "";
  const direction = payload.direction === "en-to-zh" ? "en-to-zh" : "zh-to-en";
  const provider = normalizeProvider(payload.provider);
  const docType = typeof payload.docType === "string" ? payload.docType : "other";

  if (!text.trim()) return json(200, offlineResult("", direction, "No source text was provided."));

  const selected = selectProvider(provider);
  if (selected === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    const result = await callModel("deepseek", text, direction, docType).catch(() => null);
    if (result) return json(200, result);
  }
  if (selected === "openai" && process.env.OPENAI_API_KEY) {
    const result = await callModel("openai", text, direction, docType).catch(() => null);
    if (result) return json(200, result);
  }
  if (provider === "auto" && process.env.DEEPSEEK_API_KEY) {
    const result = await callModel("deepseek", text, direction, docType).catch(() => null);
    if (result) return json(200, result);
  }
  if (provider === "auto" && process.env.OPENAI_API_KEY) {
    const result = await callModel("openai", text, direction, docType).catch(() => null);
    if (result) return json(200, result);
  }

  return json(200, offlineResult(text, direction, "No model key is configured, so offline rules were used."));
};

function normalizeProvider(value) {
  return value === "openai" || value === "deepseek" || value === "offline" ? value : "auto";
}

function selectProvider(provider) {
  if (provider === "auto") {
    if (process.env.DEEPSEEK_API_KEY) return "deepseek";
    if (process.env.OPENAI_API_KEY) return "openai";
    return "offline";
  }
  return provider;
}

async function callModel(provider, text, direction, docType) {
  const isDeepSeek = provider === "deepseek";
  const url = isDeepSeek ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const key = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  const model = isDeepSeek ? process.env.DEEPSEEK_MODEL || "deepseek-chat" : process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const target = direction === "en-to-zh" ? "Simplified Chinese" : "professional English";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a professional certified document translator. Translate every visible item. Preserve numbers and document codes exactly. English addresses must be small-to-large; Chinese addresses must be large-to-small. Return only JSON with keys: mode,title,summary,fields,polished,notes. fields is an array of {label,source,translation}.",
        },
        {
          role: "user",
          content: `Document type: ${docType}\nTarget language: ${target}\nSource OCR text:\n${text}`,
        },
      ],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  return JSON.parse(content);
}

function offlineResult(text, direction, reason) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fields = lines.slice(0, 80).map((line) => ({
    label: inferLabel(line),
    source: line,
    translation: direction === "zh-to-en" ? simpleZhToEn(line) : line,
  }));

  return {
    mode: "offline rules",
    title: direction === "zh-to-en" ? "Offline Chinese-to-English Translation" : "Offline English-to-Chinese Translation",
    summary: reason,
    fields,
    polished: fields.map((field) => `${field.label}: ${field.translation}`).join("\n"),
    notes: ["Please proofread OCR text before using the translation, especially names, addresses, dates, and ID numbers."],
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: statusCode === 204 ? "" : JSON.stringify(body),
  };
}
