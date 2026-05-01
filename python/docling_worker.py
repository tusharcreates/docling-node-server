#!/usr/bin/env python3
import json
import sys
import traceback
from typing import Any
from urllib.parse import urlparse

PROTOCOL_STDOUT = sys.stdout

# Keep stdout reserved for protocol JSON. Any library output goes to stderr so
# the Node process can parse stdout as newline-delimited JSON.
sys.stdout = sys.stderr

from docling.datamodel.base_models import InputFormat
from docling.document_converter import DocumentConverter


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), file=PROTOCOL_STDOUT, flush=True)


def require_positive_int(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("numeric limits must be positive integers")
    parsed = int(value)
    if parsed <= 0:
        raise ValueError("numeric limits must be positive integers")
    return parsed


def validate_pdf_url(url: Any) -> str:
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("url must be an absolute http(s) URL")

    return url


def export_text(document: Any) -> str:
    try:
        return document.export_to_text(traverse_pictures=True)
    except TypeError:
        return document.export_to_text()
    except AttributeError:
        return document.export_to_markdown()


def main() -> int:
    try:
        converter = DocumentConverter(allowed_formats=[InputFormat.PDF])
        converter.initialize_pipeline(InputFormat.PDF)
        emit({"type": "ready"})
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        emit({"type": "fatal", "error": str(exc)})
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("id must be a non-empty string")

            url = validate_pdf_url(payload.get("url"))
            max_num_pages = require_positive_int(payload.get("maxNumPages"), sys.maxsize)
            max_file_size = require_positive_int(payload.get("maxFileSize"), sys.maxsize)

            result = converter.convert(
                url,
                raises_on_error=True,
                max_num_pages=max_num_pages,
                max_file_size=max_file_size,
            )
            emit({"id": request_id, "ok": True, "text": export_text(result.document)})
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": str(exc),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
