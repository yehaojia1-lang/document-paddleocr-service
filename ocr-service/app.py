import io
import os
import re
import tempfile
import zipfile
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps
from paddleocr import PaddleOCR


MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "8"))
ROTATIONS = (0, 90, 270, 180)
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

app = FastAPI(title="Document OCR Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "engine": "paddleocr"}


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    doc_type: str = Form("other"),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    suffix = Path(file.filename or "").suffix.lower()
    mime = file.content_type or ""

    try:
        images = list(load_images(data, suffix, mime))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read file: {exc}") from exc

    if not images:
        raise HTTPException(status_code=400, detail="No images found in file")

    pages = []
    for index, image in enumerate(images, start=1):
        text, rotation, score = recognize_best(image, mode=mode, doc_type=doc_type)
        if text.strip():
            pages.append({"index": index, "text": text, "rotation": rotation, "score": score})

    combined = "\n\n".join(f"Page {page['index']}\n{page['text']}" for page in pages).strip()
    return {
        "engine": "paddleocr",
        "text": combined,
        "pages": pages,
        "warning": None if combined else "No reliable text was recognized. Please upload a clearer original file.",
    }


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
        bitmap = page.render(scale=2.6)
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
    for rotation in ROTATIONS:
        candidate = image.rotate(rotation, expand=True) if rotation else image
        text = recognize_image(candidate)
        score = score_text(text, mode=mode, doc_type=doc_type)
        if score > best[2]:
            best = (text, rotation, score)
        if score >= 150:
            break
    return best


def recognize_image(image: Image.Image) -> str:
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp:
        temp_path = temp.name
        image.save(temp_path, "JPEG", quality=95)

    try:
        result = get_ocr().ocr(temp_path, cls=True)
    finally:
        Path(temp_path).unlink(missing_ok=True)

    lines = []
    for block in result or []:
        for item in block or []:
            if len(item) >= 2 and isinstance(item[1], (list, tuple)):
                text = str(item[1][0]).strip()
                confidence = float(item[1][1] or 0)
                if text and confidence >= 0.35:
                    lines.append(text)
    return cleanup_text("\n".join(lines))


@lru_cache(maxsize=1)
def get_ocr():
    return PaddleOCR(use_angle_cls=True, lang=os.getenv("PADDLEOCR_LANG", "ch"), show_log=False)


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


def cleanup_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("|", " ").splitlines()]
    return "\n".join(line for line in lines if line)
