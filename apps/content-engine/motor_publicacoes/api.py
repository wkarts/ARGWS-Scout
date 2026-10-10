"""API HTTP opcional (somente ingestão, geração e consulta). Envio não disponível via API."""
from __future__ import annotations

import hmac
import os
import base64
import re
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse

from .engine import Options, process

app = FastAPI(title="Motor de Publicações", version="2.0.0", docs_url="/docs", redoc_url=None)
OUTPUT_ROOT = Path(os.getenv("OUTPUT_ROOT", "/app/output"))
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(5*1024*1024)))


def authenticate(x_api_key: str | None = Header(default=None), authorization: str | None = Header(default=None)):
    key = os.getenv("API_KEY", "")
    if not key:
        raise HTTPException(503, "Defina API_KEY para habilitar operações")
    if x_api_key and hmac.compare_digest(x_api_key, key):
        return True
    # HTTP Basic para abrir a prévia no navegador e carregar imagens relativas.
    if authorization and authorization.startswith("Basic "):
        try:
            credentials = base64.b64decode(authorization[6:], validate=True).decode("utf-8")
            user, password = credentials.split(":", 1)
            if hmac.compare_digest(user,"publicacoes") and hmac.compare_digest(password,key):
                return True
        except (ValueError,UnicodeDecodeError,base64.binascii.Error):
            pass
    raise HTTPException(401, "Chave inválida: use X-API-Key ou HTTP Basic (usuário publicacoes)",
                        headers={"WWW-Authenticate":"Basic realm=Publicacoes"})


@app.get("/health")
def health():
    return {"status":"ok", "service":"publications", "can_send":False}


@app.post("/v1/process",dependencies=[Depends(authenticate)])
async def process_api(request: Request):
    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(413,"Arquivo maior do que o permitido")
    try:
        data = await request.json()
        if not isinstance(data,dict):
            raise ValueError("Esperado JSON do tipo objeto")
        cfg = data.get("options") or {}
        if not isinstance(cfg,dict):
            raise ValueError("options deve ser um objeto")
        opts = Options(query=str(cfg.get("query") or ""),only_relevant=bool(cfg.get("only_relevant",False)),
                       max_items=min(500,int(cfg.get("max_items",100))),create_story=bool(cfg.get("create_story",False)),
                       create_wide=bool(cfg.get("create_wide",True)),fetch_images=False,
                       media_root=None,media_map=None,create_excel=False)
        job,manifest = process(data.get("payload") if "payload" in data else data,OUTPUT_ROOT,opts)
        return {"job_id":manifest["job_id"],"total":manifest["total"],"review_required":manifest["review_required"],
                "messages_sent":0,"preview_path":f"/v1/jobs/{manifest['job_id']}/files/index.html"}
    except (ValueError,TypeError) as exc:
        raise HTTPException(422,str(exc)) from exc


@app.get("/v1/jobs/{job_id}/files/{file_path:path}",dependencies=[Depends(authenticate)])
def read_job_file(job_id: str,file_path: str):
    if not re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{8}",job_id):
        raise HTTPException(404,"Job inexistente")
    job_root=(OUTPUT_ROOT/job_id).resolve()
    target=(job_root/file_path).resolve()
    if not target.is_relative_to(job_root) or not target.is_file():
        raise HTTPException(404,"Arquivo não encontrado")
    allowed={".png",".html",".txt",".json",".csv",".md",".eml",".xlsx"}
    if target.suffix.lower() not in allowed:
        raise HTTPException(403,"Extensão não permitida")
    return FileResponse(target,headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"})
