#!/usr/bin/env python3
import json
import os
import sys
import traceback
from typing import Any
from urllib.parse import urlparse

PROTOCOL_STDOUT = sys.stdout

# Keep stdout reserved for protocol JSON. Any library output goes to stderr so
# the Node process can parse stdout as newline-delimited JSON.
sys.stdout = sys.stderr


def resolve_bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default

    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False

    print(
        f'{name}="{raw}" is not a boolean; falling back to {str(default).lower()}',
        file=sys.stderr,
        flush=True,
    )
    return default


def resolve_num_threads() -> int:
    env = os.environ.get("DOCLING_THREADS_PER_WORKER")
    if env is not None:
        try:
            n = int(env)
            if n >= 1:
                return n
        except ValueError:
            pass
    return max(1, (os.cpu_count() or 1))


def configure_native_threads(num_threads: int) -> None:
    threads = str(num_threads)
    for name in (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ.setdefault(name, threads)


NUM_THREADS = resolve_num_threads()
configure_native_threads(NUM_THREADS)

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import AcceleratorDevice, AcceleratorOptions, PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption


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
        do_ocr = resolve_bool_env("DOCLING_OCR", False)
        do_table_structure = resolve_bool_env("DOCLING_TABLE_STRUCTURE", False)
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = do_ocr
        pipeline_options.do_table_structure = do_table_structure
        pipeline_options.accelerator_options = AcceleratorOptions(
            num_threads=NUM_THREADS,
            device=AcceleratorDevice.CPU,
        )
        converter = DocumentConverter(
            allowed_formats=[InputFormat.PDF],
            format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
            },
        )
        converter.initialize_pipeline(InputFormat.PDF)
        print(
            "Docling worker ready "
            f"(threads={NUM_THREADS}, ocr={do_ocr}, table_structure={do_table_structure})",
            file=sys.stderr,
            flush=True,
        )
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
