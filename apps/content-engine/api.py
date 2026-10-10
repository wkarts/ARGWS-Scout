"""Serviço interno de refinamento e peças gráficas - sem envio a destinatários."""
from __future__ import annotations
import hmac
import json
import os
import re
import shutil
import uuid
from starlette.concurrency import run_in_threadpool
from pathlib import Path
from fastapi import FastAPI, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from motor_publicacoes.engine import Options, process
from motor_publicacoes.ingestion import normalize

app = FastAPI(title="Refinamento e Publicações", version="2.1.0", docs_url=None, redoc_url=None, openapi_url=None)
ROOT = Path(os.environ.get("OUTPUT_ROOT", "/app/output")).resolve()
MAX_BYTES = 5 * 1024 * 1024
JOB_RE = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{8}")

def authorize(x_api_key: str | None = Header(None)):
    expected = os.environ.get("SCOUT_CONTENT_ENGINE_KEY", "")
    if len(expected) < 32:
        raise HTTPException(503, "Chave interna do serviço não configurada")
    if not x_api_key or not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(401, "Acesso não autorizado")

async def content_request(req: Request):
    if req.headers.get("content-length") and int(req.headers["content-length"]) > MAX_BYTES:
        raise HTTPException(413, "Entrada acima do limite")
    body = await req.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "Entrada acima do limite")
    try:
        obj = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "JSON inválido")
    if not isinstance(obj, dict):
        raise HTTPException(422, "O corpo deve ser um objeto")
    return obj

@app.get("/health")
def health():
    return {"status": "ok", "service": "content-engine", "can_send": False}

@app.post("/v1/process", dependencies=[Depends(authorize)])
async def process_request(req: Request):
    obj = await content_request(req)
    config = obj.get("options") or {}
    if not isinstance(config, dict):
        raise HTTPException(422, "Opções inválidas")
    try:
        max_items = int(config.get("max_items", 100))
        if not 1 <= max_items <= 250:
            raise ValueError("O máximo é 250 itens por lote")
        opts = Options(query=str(config.get("query", ""))[:150],
                       only_relevant=bool(config.get("only_relevant", False)),
                       max_items=max_items,
                       create_story=bool(config.get("create_story", True)),
                       create_wide=True, fetch_images=config.get("fetch_images") is True,
                       create_excel=False,
                       enrich_images=config.get("enrich_images") is True,
                       enrich_limit=min(25, max(0, int(config.get("enrich_limit", 10)))),
                       enrich_delay=0.5)
        # Geração em diretório isolado por requisição: erros de processamento
        # não deixam PNG/HTML temporários órfãos nem expõem lotes parciais.
        ROOT.mkdir(parents=True, exist_ok=True)
        staging = ROOT / ".staging" / uuid.uuid4().hex
        staging.mkdir(parents=True, exist_ok=False)
        try:
            directory, manifest = await run_in_threadpool(process, obj.get("payload", obj), staging, opts)
            destination = ROOT / manifest["job_id"]
            if not JOB_RE.fullmatch(destination.name):
                raise ValueError("Identificador de saída inválido")
            os.replace(directory, destination)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        return {"job_id":manifest["job_id"], "total":manifest["total"],
                "review_required":manifest["review_required"],"messages_sent":0}
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)[:350]) from exc

@app.post("/v1/normalize",dependencies=[Depends(authorize)])
async def normalize_request(req: Request):
    obj = await content_request(req)
    try:
        return normalize(obj.get("payload", obj), query=str(obj.get("query", ""))[:150],
                         max_items=min(250,max(1,int(obj.get("max_items", 100)))))
    except (TypeError, ValueError) as exc:
        raise HTTPException(422,str(exc)[:300]) from exc

def safe_job(job_id:str) -> Path:
    if not JOB_RE.fullmatch(job_id):
        raise HTTPException(404,"Lote inexistente")
    directory = (ROOT / job_id).resolve()
    if not directory.is_relative_to(ROOT) or not directory.is_dir():
        raise HTTPException(404,"Lote inexistente")
    return directory

@app.get("/v1/jobs/{job_id}/manifest",dependencies=[Depends(authorize)])
def manifest(job_id: str):
    filename = safe_job(job_id) / "manifest.json"
    return json.loads(filename.read_text(encoding="utf-8"))

@app.get("/v1/jobs/{job_id}/normalized",dependencies=[Depends(authorize)])
def normalized(job_id: str):
    filename = safe_job(job_id) / "registros_refinados.json"
    return json.loads(filename.read_text(encoding="utf-8"))

@app.get("/v1/jobs/{job_id}/files/{file_path:path}",dependencies=[Depends(authorize)])
def download_file(job_id: str, file_path: str):
    directory=safe_job(job_id)
    path=(directory/file_path).resolve()
    if not path.is_relative_to(directory) or not path.is_file():
        raise HTTPException(404,"Arquivo não encontrado")
    if path.suffix.lower() not in {".png",".txt",".json",".html",".csv",".eml"}:
        raise HTTPException(403,"Arquivo não permitido")
    return FileResponse(path,headers={"Cache-Control":"private, no-store", "X-Content-Type-Options":"nosniff"})

@app.delete("/v1/jobs/{job_id}",dependencies=[Depends(authorize)])
def cleanup_job(job_id: str):
    folder = safe_job(job_id)
    shutil.rmtree(folder)
    return {"deleted": True}

