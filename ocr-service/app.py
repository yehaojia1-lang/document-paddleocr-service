import io
import json
import os
import re
import subprocess
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Iterable

import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

try:
    from rapidocr_onnxruntime import RapidOCR
except Exception:
    try:
        from rapidocr import RapidOCR
    except Exception:
        RapidOCR = None


MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "10"))
OCR_ENGINE = "ocrspace+tesseract"
OCR_PROVIDER = os.getenv("OCR_PROVIDER", "auto").strip().lower()
OCR_SPACE_API_KEY = os.getenv("OCR_SPACE_API_KEY", "")
OCR_SPACE_ENDPOINT = os.getenv("OCR_SPACE_ENDPOINT", "https://api.ocr.space/parse/image")
GOOGLE_VISION_API_KEY = os.getenv("GOOGLE_VISION_API_KEY", "")
GOOGLE_VISION_ENDPOINT = os.getenv("GOOGLE_VISION_ENDPOINT", "https://vision.googleapis.com/v1/images:annotate")
ENABLE_LOCAL_RAPIDOCR = os.getenv("ENABLE_LOCAL_RAPIDOCR", "").lower() in {"1", "true", "yes"}
MAX_IMAGE_SIDE = int(os.getenv("MAX_IMAGE_SIDE", "3200"))
MIN_IMAGE_SIDE = int(os.getenv("MIN_IMAGE_SIDE", "1800"))
PDF_RENDER_SCALE = float(os.getenv("PDF_RENDER_SCALE", "2.4"))
ROTATIONS = (0, 90, 270)
PSM_MODES = ("6", "11")
RAPID_OCR = None
ID_LABELS = (
    "\u59d3\u540d",
    "\u6027\u522b",
    "\u6c11\u65cf",
    "\u51fa\u751f",
    "\u4f4f\u5740",
    "\u516c\u6c11\u8eab\u4efd\u53f7\u7801",
    "\u5c45\u6c11\u8eab\u4efd\u8bc1",
)
ADDRESS_LABELS = (
    "\u7701",
    "\u5e02",
    "\u533a",
    "\u53bf",
    "\u9547",
    "\u8def",
    "\u53f7",
    "\u5ba4",
    "\u680b",
)
ID_FIELD_REGIONS = (
    ("name", 0.07, 0.08, 0.55, 0.22),
    ("sex_ethnicity", 0.07, 0.20, 0.60, 0.34),
    ("birth", 0.07, 0.32, 0.70, 0.48),
    ("address", 0.07, 0.45, 0.76, 0.74),
    ("id_number", 0.07, 0.74, 0.86, 0.96),
)

app = FastAPI(title="Document OCR Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": OCR_ENGINE,
        "provider": OCR_PROVIDER,
        "googleVision": bool(GOOGLE_VISION_API_KEY),
        "ocrspace": bool(OCR_SPACE_API_KEY),
        "rapidocr": RapidOCR is not None and ENABLE_LOCAL_RAPIDOCR,
    }


@app.get("/")
def root():
    return {
        "ok": True,
        "engine": OCR_ENGINE,
        "endpoints": {
            "health": "/health",
            "ocr": "POST /ocr",
        },
    }


@app.head("/")
def root_head():
    return None


@app.post("/ocr")
def ocr(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    doc_type: str = Form("other"),
):
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    suffix = Path(file.filename or "").suffix.lower()
    mime = file.content_type or ""

    pages = []
    try:
        cloud_pages = []
        if suffix == ".pdf" or mime == "application/pdf":
            if GOOGLE_VISION_API_KEY:
                cloud_pages = recognize_pdf_pages_cloud(data, doc_type)
            else:
                cloud_pages = extract_pdf_text_pages(data)
                if not cloud_pages:
                    cloud_pages = recognize_pdf_pages_cloud(data, doc_type)
        else:
            cloud_text = recognize_cloud_image(data, file.filename or f"upload{suffix or '.png'}", mime, doc_type)
            if is_reliable_text(cloud_text, mode=mode, doc_type=doc_type):
                cloud_pages = [(1, cloud_text)]
        if cloud_pages:
            for page_index, cloud_text in cloud_pages:
                text = postprocess_document_text(cloud_text, mode, doc_type)
                pages.append({"index": page_index, "text": text, "rotation": 0, "score": score_text(text, mode=mode, doc_type=doc_type)})
        else:
            for index, image in enumerate(load_images(data, suffix, mime), start=1):
                text, rotation, score = recognize_best(image, mode=mode, doc_type=doc_type)
                if is_reliable_text(text, mode=mode, doc_type=doc_type):
                    pages.append({"index": index, "text": text, "rotation": rotation, "score": score})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR failed: {exc}") from exc

    combined = "\n\n".join(f"Page {page['index']}\n{page['text']}" for page in pages).strip()
    return {
        "engine": OCR_ENGINE,
        "text": combined,
        "pages": pages,
        "warning": None if combined else "No reliable text was recognized. Please upload a clearer original file.",
    }


def extract_pdf_text(data: bytes) -> str:
    pages = extract_pdf_text_pages(data)
    return cleanup_text("\n\n".join(text for _, text in pages))


def extract_pdf_text_pages(data: bytes) -> list[tuple[int, str]]:
    try:
        document = pdfium.PdfDocument(data)
        pages = []
        for page_index in range(min(len(document), MAX_PDF_PAGES)):
            page = document[page_index]
            textpage = page.get_textpage()
            text = textpage.get_text_range()
            text = cleanup_text(text or "")
            if is_reliable_text(text, mode="full", doc_type=""):
                pages.append((page_index + 1, text))
        return pages
    except Exception:
        return []


def recognize_pdf_pages_cloud(data: bytes, doc_type: str) -> list[tuple[int, str]]:
    pages = []
    try:
        for index, image in enumerate(render_pdf_pages(data), start=1):
            image_data = image_to_jpeg_bytes(image)
            text = recognize_cloud_image(image_data, f"page-{index}.jpg", "image/jpeg", doc_type)
            if is_reliable_text(text, mode="full", doc_type=doc_type):
                pages.append((index, text))
    except Exception:
        return []
    return pages


def recognize_cloud_image(data: bytes, filename: str, mime: str, doc_type: str) -> str:
    providers = cloud_provider_order()
    for provider in providers:
        if provider == "ocrspace":
            text = recognize_ocr_space(data, filename, mime, doc_type)
        elif provider == "google":
            text = recognize_google_vision(data)
        else:
            text = ""
        if is_reliable_text(text, mode="full", doc_type=doc_type):
            return text
    return ""


def cloud_provider_order() -> list[str]:
    if OCR_PROVIDER in {"ocrspace", "ocr-space", "space"}:
        return ["ocrspace"]
    if OCR_PROVIDER in {"google", "google-vision", "vision"}:
        return ["google"]
    if OCR_PROVIDER == "local":
        return []
    if OCR_SPACE_API_KEY and not GOOGLE_VISION_API_KEY:
        return ["ocrspace"]
    if GOOGLE_VISION_API_KEY and not OCR_SPACE_API_KEY:
        return ["google"]
    return ["ocrspace", "google"]


def recognize_google_vision(data: bytes) -> str:
    if not GOOGLE_VISION_API_KEY:
        return ""

    import base64

    payload = {
        "requests": [
            {
                "image": {"content": base64.b64encode(data).decode("ascii")},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                "imageContext": {"languageHints": ["zh", "zh-Hans", "en", "it"]},
            }
        ]
    }
    request = urllib.request.Request(
        f"{GOOGLE_VISION_ENDPOINT}?key={GOOGLE_VISION_API_KEY}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            result = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception:
        return ""

    responses = result.get("responses") or []
    if not responses or responses[0].get("error"):
        return ""
    annotation = responses[0].get("fullTextAnnotation") or {}
    return cleanup_text(annotation.get("text") or "")


def image_to_jpeg_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image = normalize_image_size(ImageOps.exif_transpose(image).convert("RGB"))
    image.save(buffer, "JPEG", quality=92, optimize=True)
    return buffer.getvalue()


def recognize_ocr_space(data: bytes, filename: str, mime: str, doc_type: str) -> str:
    if not OCR_SPACE_API_KEY:
        return ""

    language = "chs" if doc_type == "id-card" else "auto"
    fields = {
        "apikey": OCR_SPACE_API_KEY,
        "language": language,
        "OCREngine": "3",
        "scale": "true",
        "detectOrientation": "true",
        "isTable": "false",
    }
    boundary = f"----codex-ocr-{uuid.uuid4().hex}"
    body = build_multipart_body(fields, data, filename, mime or "application/octet-stream", boundary)
    request = urllib.request.Request(
        OCR_SPACE_ENDPOINT,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=85) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except Exception:
        return ""

    if payload.get("IsErroredOnProcessing"):
        return ""
    parsed = payload.get("ParsedResults") or []
    texts = [item.get("ParsedText", "") for item in parsed if isinstance(item, dict)]
    return cleanup_text("\n".join(texts))


def build_multipart_body(fields: dict[str, str], file_bytes: bytes, filename: str, mime: str, boundary: str) -> bytes:
    chunks = []
    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        chunks.append(str(value).encode())
        chunks.append(b"\r\n")
    safe_name = Path(filename).name or "upload"
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(f'Content-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'.encode())
    chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
    chunks.append(file_bytes)
    chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks)


def postprocess_document_text(text: str, mode: str, doc_type: str) -> str:
    if mode == "id" or doc_type == "id-card":
        return cleanup_id_text(text)
    return cleanup_text(text)


def load_images(data: bytes, suffix: str, mime: str) -> Iterable[Image.Image]:
    if suffix == ".pdf" or mime == "application/pdf":
        yield from render_pdf_pages(data)
        return

    if suffix == ".docx":
        yield from extract_docx_images(data)
        return

    yield open_image(data)


def render_pdf_pages(data: bytes) -> Iterable[Image.Image]:
    document = pdfium.PdfDocument(data)
    page_count = min(len(document), MAX_PDF_PAGES)
    for page_index in range(page_count):
        page = document[page_index]
        bitmap = page.render(scale=PDF_RENDER_SCALE)
        yield bitmap.to_pil()


def extract_docx_images(data: bytes) -> Iterable[Image.Image]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = [
            name
            for name in archive.namelist()
            if name.lower().startswith("word/media/")
            and name.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"))
        ]
        for name in names:
            yield open_image(archive.read(name))


def open_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    return image


def recognize_best(image: Image.Image, mode: str, doc_type: str):
    best = ("", 0, -10_000)
    is_id = mode == "id" or doc_type == "id-card"
    for rotation in ROTATIONS:
        candidate = image.rotate(rotation, expand=True) if rotation else image
        text = recognize_id_card(candidate) if is_id else recognize_page(candidate, mode=mode)
        score = score_text(text, mode=mode, doc_type=doc_type)
        if score > best[2]:
            best = (text, rotation, score)
        if score >= 150:
            break
    return best


def recognize_page(image: Image.Image, mode: str) -> str:
    rapid_text = recognize_rapidocr(image) if ENABLE_LOCAL_RAPIDOCR else ""
    tesseract_text_value = recognize_image(image, mode=mode)
    return choose_better_text(rapid_text, tesseract_text_value, mode=mode)


def recognize_id_card(image: Image.Image) -> str:
    full_text = recognize_page(image, mode="id")
    fragments = {"full": full_text}
    for name, left, top, right, bottom in ID_FIELD_REGIONS:
        crop = crop_relative(image, left, top, right, bottom)
        rapid_region = recognize_rapidocr(crop) if ENABLE_LOCAL_RAPIDOCR else ""
        tesseract_region = recognize_region(crop)
        fragments[name] = choose_better_text(rapid_region, tesseract_region, mode="id")
    structured = build_id_card_text(fragments)
    if structured:
        return structured
    return full_text


def get_rapidocr():
    global RAPID_OCR
    if RapidOCR is None:
        return None
    if RAPID_OCR is None:
        RAPID_OCR = RapidOCR()
    return RAPID_OCR


def recognize_rapidocr(image: Image.Image) -> str:
    engine = get_rapidocr()
    if engine is None:
        return ""

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp:
        temp_path = temp.name
        normalized = normalize_image_size(ImageOps.exif_transpose(image).convert("RGB"))
        normalized.save(temp_path, "PNG", optimize=True)
    try:
        result = engine(temp_path)
    except Exception:
        return ""
    finally:
        Path(temp_path).unlink(missing_ok=True)

    return cleanup_text(format_rapidocr_result(result))


def format_rapidocr_result(result) -> str:
    items = []
    raw_items = getattr(result, "txts", None)
    raw_boxes = getattr(result, "boxes", None)
    raw_scores = getattr(result, "scores", None)
    if raw_items is not None:
        for index, text in enumerate(raw_items):
            box = raw_boxes[index] if raw_boxes is not None and index < len(raw_boxes) else None
            score = raw_scores[index] if raw_scores is not None and index < len(raw_scores) else 1
            items.append((box, text, score))
    elif isinstance(result, (list, tuple)):
        sequence = result[0] if len(result) == 2 and isinstance(result[0], list) else result
        for item in sequence or []:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                box = item[0]
                value = item[1]
                if isinstance(value, (list, tuple)) and value:
                    text = value[0]
                    score = value[1] if len(value) > 1 else 1
                else:
                    text = value
                    score = item[2] if len(item) > 2 else 1
                items.append((box, text, score))

    sortable = []
    for box, text, score in items:
        if not isinstance(text, str) or not text.strip():
            continue
        if isinstance(score, (int, float)) and score < 0.35:
            continue
        x, y = box_origin(box)
        sortable.append((round(y / 12) * 12, x, text.strip()))
    sortable.sort(key=lambda item: (item[0], item[1]))
    return "\n".join(text for _, _, text in sortable)


def box_origin(box) -> tuple[float, float]:
    try:
        points = list(box)
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
        return min(xs), min(ys)
    except Exception:
        return 0.0, 0.0


def choose_better_text(first: str, second: str, mode: str) -> str:
    first_score = score_text(first, mode=mode, doc_type="id-card" if mode == "id" else "")
    second_score = score_text(second, mode=mode, doc_type="id-card" if mode == "id" else "")
    return first if first_score >= second_score else second


def crop_relative(image: Image.Image, left: float, top: float, right: float, bottom: float) -> Image.Image:
    width, height = image.size
    return image.crop((
        max(0, int(width * left)),
        max(0, int(height * top)),
        min(width, int(width * right)),
        min(height, int(height * bottom)),
    ))


def recognize_region(image: Image.Image) -> str:
    best = ("", -10_000)
    for candidate in prepare_candidates(image):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp:
            temp_path = temp.name
            candidate.save(temp_path, "PNG", optimize=True)
        try:
            for psm in ("6", "7", "11"):
                text = tesseract_text(temp_path, psm=psm)
                score = score_text(text, mode="id", doc_type="id-card")
                if score > best[1]:
                    best = (text, score)
        finally:
            Path(temp_path).unlink(missing_ok=True)
    return best[0]


def recognize_image(image: Image.Image, mode: str) -> str:
    candidates = prepare_candidates(image)
    best = ("", -10_000)
    modes = PSM_MODES if mode == "id" else ("6", "11")
    for candidate in candidates:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as temp:
            temp_path = temp.name
            candidate.save(temp_path, "PNG", optimize=True)
        try:
            for psm in modes:
                text = tesseract_text(temp_path, psm=psm)
                score = score_text(text, mode=mode, doc_type="")
                if score > best[1]:
                    best = (text, score)
        finally:
            Path(temp_path).unlink(missing_ok=True)
    return best[0]


def build_id_card_text(fragments: dict[str, str]) -> str:
    all_text = "\n".join(value for value in fragments.values() if value)
    fields = {
        "姓名": extract_name(fragments.get("name", ""), all_text),
        "性别": extract_sex(fragments.get("sex_ethnicity", ""), all_text),
        "民族": extract_ethnicity(fragments.get("sex_ethnicity", ""), all_text),
        "出生": extract_birth(fragments.get("birth", ""), all_text),
        "住址": extract_address(fragments.get("address", ""), all_text),
        "公民身份号码": extract_id_number(fragments.get("id_number", ""), all_text),
    }
    if not any(fields.values()):
        return cleanup_id_text(fragments.get("full", ""))

    lines = ["中华人民共和国居民身份证"]
    for label in ("姓名", "性别", "民族", "出生", "住址", "公民身份号码"):
        value = fields[label]
        if value:
            lines.append(f"{label} {value}")
    raw = cleanup_id_text(fragments.get("full", ""))
    if raw:
        lines.append("")
        lines.append("OCR原文")
        lines.append(raw)
    return "\n".join(lines).strip()


def extract_name(region: str, all_text: str) -> str:
    text = normalize_id_text(region)
    candidates = []
    for source in (text, normalize_id_text(all_text)):
        for line in source.splitlines():
            if "姓名" in line or line.startswith("姓") or line.startswith("名"):
                value = re.sub(r".*?[姓名]\s*", "", line)
                value = only_chinese(value)
                value = strip_id_labels(value)
                if 2 <= len(value) <= 4:
                    candidates.append(value)
        compact = only_chinese(source)
        compact = strip_id_labels(compact)
        if 2 <= len(compact) <= 4:
            candidates.append(compact)
    return candidates[0] if candidates else ""


def extract_sex(region: str, all_text: str) -> str:
    text = normalize_id_text(f"{region}\n{all_text}")
    if re.search(r"性别\s*女|别\s*女|女\s*民族", text):
        return "女"
    if re.search(r"性别\s*男|别\s*男|男\s*民族", text):
        return "男"
    return ""


def extract_ethnicity(region: str, all_text: str) -> str:
    text = normalize_id_text(f"{region}\n{all_text}")
    match = re.search(r"民族\s*([\u4e00-\u9fff]{1,4})", text)
    if match:
        value = strip_id_labels(match.group(1))
        if value:
            return value[:2]
    if "民族汉" in text or re.search(r"[男女]\s*汉", text):
        return "汉"
    return ""


def extract_birth(region: str, all_text: str) -> str:
    text = normalize_id_text(f"{region}\n{all_text}")
    match = re.search(r"((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?", text)
    if match:
        return f"{match.group(1)}年{int(match.group(2))}月{int(match.group(3))}日"
    return ""


def extract_address(region: str, all_text: str) -> str:
    sources = [normalize_id_text(region), normalize_id_text(all_text)]
    for source in sources:
        lines = [line.strip() for line in source.splitlines() if line.strip()]
        address_lines = []
        capture = False
        for line in lines:
            line = line.replace("住过", "住址").replace("任址", "住址")
            if "住址" in line or "地址" in line:
                capture = True
                line = re.sub(r".*?(住址|地址)\s*", "", line)
            if capture:
                if "公民身份号码" in line or re.search(r"\d{15,18}", line):
                    break
                line = re.sub(r"[^\u4e00-\u9fff0-9A-Za-z\-号栋幢室单元年月日省市区县镇乡村路街道弄巷]", "", line)
                line = strip_id_labels(line)
                if line:
                    address_lines.append(line)
        value = "".join(address_lines)
        if len(value) >= 6 and any(token in value for token in ADDRESS_LABELS):
            return value
    return ""


def extract_id_number(region: str, all_text: str) -> str:
    text = f"{region}\n{all_text}"
    match = re.search(r"\d{17}[\dXx]|\d{15}", text)
    return match.group(0).upper() if match else ""


def normalize_id_text(text: str) -> str:
    text = cleanup_text(text)
    replacements = {
        "住过": "住址",
        "任址": "住址",
        "位址": "住址",
        "公民身份号": "公民身份号码",
        "公民身分号码": "公民身份号码",
        "民 族": "民族",
        "性 别": "性别",
        "出 生": "出生",
        "姓 名": "姓名",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return text


def cleanup_id_text(text: str) -> str:
    text = normalize_id_text(text)
    lines = []
    for line in text.splitlines():
        line = re.sub(r"[»《》=~`^|{}[\]<>]+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def only_chinese(text: str) -> str:
    return "".join(re.findall(r"[\u4e00-\u9fff]", text))


def strip_id_labels(text: str) -> str:
    for label in ("姓名", "性别", "民族", "出生", "住址", "地址", "公民身份号码", "中华人民共和国居民身份证"):
        text = text.replace(label, "")
    return text.strip()


def prepare_candidates(image: Image.Image) -> list[Image.Image]:
    image = normalize_image_size(ImageOps.exif_transpose(image).convert("L"))
    image = ImageOps.autocontrast(image)
    image = ImageEnhance.Contrast(image).enhance(1.35)
    sharp = image.filter(ImageFilter.SHARPEN)
    threshold = sharp.point(lambda value: 255 if value > 168 else 0)
    inverted_threshold = ImageOps.invert(sharp).point(lambda value: 255 if value > 168 else 0)
    return [sharp, threshold, inverted_threshold]


def normalize_image_size(image: Image.Image) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest > MAX_IMAGE_SIDE:
        ratio = MAX_IMAGE_SIDE / longest
        image = image.resize((max(1, int(width * ratio)), max(1, int(height * ratio))))
    elif longest < MIN_IMAGE_SIDE:
        ratio = min(MIN_IMAGE_SIDE / longest, 2.5)
        image = image.resize((max(1, int(width * ratio)), max(1, int(height * ratio))))
    return image


def tesseract_text(image_path: str, psm: str) -> str:
    env = os.environ.copy()
    env["OMP_THREAD_LIMIT"] = "1"
    env["OMP_NUM_THREADS"] = "1"
    completed = subprocess.run(
        ["tesseract", image_path, "stdout", "-l", "chi_sim+eng", "--psm", psm, "--dpi", "240"],
        check=False,
        capture_output=True,
        env=env,
        text=True,
        timeout=35,
    )
    return cleanup_text(completed.stdout)


def score_text(text: str, mode: str, doc_type: str) -> int:
    if not text:
        return -100

    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    digits = len(re.findall(r"\d", text))
    id_number = 60 if re.search(r"\d{17}[\dXx]|\d{15}", text) else 0
    labels = sum(20 for label in ID_LABELS if label in text)
    address = sum(5 for label in ADDRESS_LABELS if label in text)
    latin_noise = len(re.findall(r"[A-Za-z]{8,}|[|_~`^\\{}[\]<>]", text))
    short_penalty = 35 if len(text) < 8 else 0
    id_bonus = id_number + labels + address if mode == "id" or doc_type == "id-card" else 0
    return chinese * 2 + min(digits, 35) + id_bonus - latin_noise * 8 - short_penalty


def is_reliable_text(text: str, mode: str, doc_type: str) -> bool:
    text = cleanup_text(text)
    if len(text) < 4:
        return False

    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    digits = len(re.findall(r"\d", text))
    latin_words = re.findall(r"[A-Za-z]{3,}", text)
    long_noise = len(re.findall(r"[A-Za-z]{8,}|[~`^_{}<>\\|]{2,}|(?:[A-Za-z][~`^_{}<>\\|]){2,}", text))
    symbol_noise = len(re.findall(r"[~`^_{}<>\\|]", text))
    useful = chinese + digits + sum(len(word) for word in latin_words)

    if chinese < 6 and (long_noise >= 2 or symbol_noise > 4):
        return False
    if re.search(r"\d{17}[\dXx]|\d{15}", text):
        return True
    if any(label in text for label in ID_LABELS) and chinese + digits >= 6:
        return True
    if chinese >= 8 or digits >= 8:
        return True
    if latin_words and useful >= 18 and long_noise <= 1 and symbol_noise <= 3:
        return True
    return False


def cleanup_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("|", " ").splitlines()]
    return "\n".join(line for line in lines if line)
