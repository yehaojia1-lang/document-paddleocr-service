# RapidOCR Service

Free OCR backend for the document translation site.

## API

`POST /ocr`

Multipart form fields:

- `file`: image, PDF, or DOCX file
- `mode`: `full` or `id`
- `doc_type`: document type from the main site

Response:

```json
{
  "engine": "rapidocr",
  "text": "recognized text",
  "pages": [{ "index": 1, "text": "...", "rotation": 90, "score": 180 }]
}
```

## Deploy

Render can use `render.yaml`, or create a Docker web service with:

```bash
docker build -t document-paddleocr-service .
docker run -p 8000:8000 document-paddleocr-service
```

After deployment, set the main site's environment variable:

```text
OCR_SERVICE_URL=https://your-render-service.onrender.com
```

Keep `DEEPSEEK_API_KEY` on the main site for translation.
