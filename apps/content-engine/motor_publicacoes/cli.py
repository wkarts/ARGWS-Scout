"""CLI do motor: process, approve, send e inspect."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .engine import Options, make_json, process


def parse_input(path: Path, source_url: str | None) -> object:
    if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("Arquivo inexistente ou superior a 20 MB")
    if path.suffix.lower() in (".html", ".htm"):
        if not source_url:
            raise ValueError("Informe --source-url para entrada HTML")
        return {"data":{"html":path.read_text(encoding="utf-8")},"finalUrl":source_url}
    if path.suffix.lower() == ".csv":
        with path.open("r",encoding="utf-8-sig",newline="") as stream:
            peek=stream.read(2048); stream.seek(0)
            sep=";" if peek.count(";")>peek.count(",") else ","
            rows=list(csv.DictReader(stream,delimiter=sep))
        return {"items":rows,"source":{"url_final":source_url or ""}}
    return json.loads(path.read_text(encoding="utf-8"))


def _load_job(job: Path) -> tuple[dict, dict]:
    root = job.resolve()
    mf = root / "manifest.json"
    jf = root / "registros_refinados.json"
    if not mf.is_file() or not jf.is_file():
        raise ValueError("O diretório não é um job válido")
    return json.loads(mf.read_text(encoding="utf-8")), json.loads(jf.read_text(encoding="utf-8"))


def _audit(job: Path, action: dict) -> None:
    log = {"at_utc":datetime.now(timezone.utc).isoformat(), **action}
    with (job/"audit.jsonl").open("a",encoding="utf-8") as stream:
        stream.write(json.dumps(log,ensure_ascii=False)+"\n")


def execute(argv: list[str] | None = None) -> int:
    parser=argparse.ArgumentParser(prog="motor-publicacoes",description="Transforma scraping em posts visuais e multicanal")
    sub=parser.add_subparsers(dest="command",required=True)
    run=sub.add_parser("process",help="Refina e gera publicações (sem enviar)")
    run.add_argument("--input",required=True,type=Path)
    run.add_argument("--output",default=Path("./output"),type=Path)
    run.add_argument("--query",default="")
    run.add_argument("--source-url",default="")
    run.add_argument("--only-relevant",action="store_true")
    run.add_argument("--limit",type=int,default=500)
    run.add_argument("--media-map",type=Path)
    run.add_argument("--media-root",type=Path)
    run.add_argument("--fetch-images",action="store_true",help="Permite buscar fotos em URLs HTTPS públicas")
    run.add_argument("--enrich-images",action="store_true",help="Obtém imagem OG/JSON-LD do produto: HTTPS, mesmo host da origem")
    run.add_argument("--enrich-limit",type=int,default=20)
    run.add_argument("--enrich-delay",type=float,default=0.3)
    run.add_argument("--public-base-url",type=str)
    run.add_argument("--accent",default="#047c88")
    run.add_argument("--story",action="store_true",help="Gera também 1080x1920")
    run.add_argument("--no-wide",action="store_true",help="Não gera 1200x630")
    run.add_argument("--xlsx",action="store_true",help="Gera Excel opcional (artifact_tool)")
    approve=sub.add_parser("approve",help="Aprova um registro ou os registros sem alerta")
    approve.add_argument("--job",required=True,type=Path)
    selection=approve.add_mutually_exclusive_group(required=True)
    selection.add_argument("--id")
    selection.add_argument("--all-clean",action="store_true")
    approve.add_argument("--reviewer",required=True)
    approve.add_argument("--accept-warnings",action="store_true",help="Para item sinalizado, após análise humana")
    send=sub.add_parser("send",help="Envio explícito após aprovação")
    send.add_argument("--job",required=True,type=Path)
    send.add_argument("--id",required=True)
    send.add_argument("--channel",required=True,choices=["whatsapp","telegram","email","webhook"])
    send.add_argument("--to",required=True)
    send.add_argument("--confirm",action="store_true",help="Confirma envio real")
    send.add_argument("--consent-confirmed",action="store_true",help="Confirma base legal/consentimento do destinatário")
    inspect=sub.add_parser("inspect",help="Exibe resumo do job")
    inspect.add_argument("--job",required=True,type=Path)
    args=parser.parse_args(argv)
    if args.command=="process":
        source=parse_input(args.input,args.source_url)
        media_map=json.loads(args.media_map.read_text(encoding="utf-8")) if args.media_map else None
        opts=Options(query=args.query,only_relevant=args.only_relevant,max_items=args.limit,
                     fetch_images=args.fetch_images,media_root=args.media_root,media_map=media_map,
                     public_base_url=args.public_base_url, accent=args.accent,
                     create_story=args.story,create_wide=not args.no_wide,create_excel=args.xlsx,
                     enrich_images=args.enrich_images,enrich_limit=args.enrich_limit,enrich_delay=args.enrich_delay)
        location,mf=process(source,args.output,opts)
        print(json.dumps({"job":str(location),"total":mf["total"],"review_required":mf["review_required"],
                          "messages_sent":0,"preview":str(location/"index.html")},ensure_ascii=False,indent=2))
        return 0
    job=args.job.resolve()
    manifest,registros=_load_job(job)
    if args.command=="inspect":
        print(json.dumps({k:v for k,v in manifest.items() if k!="items"},ensure_ascii=False,indent=2))
        return 0
    if args.command=="approve":
        if args.all_clean and args.accept_warnings:
            raise ValueError("--all-clean não pode usar --accept-warnings")
        selection=([p for p in registros["items"] if not p["requires_review"]] if args.all_clean
                   else [p for p in registros["items"] if p["id"] == args.id])
        if not selection:
            raise ValueError("ID não encontrado ou nenhum registro sem alerta")
        count=0
        for p in selection:
            if p["requires_review"] and not args.accept_warnings:
                raise ValueError(f"Registro {p['id']} tem alertas; revisar e usar --accept-warnings individualmente")
            mf_entry=next(v for v in manifest["items"] if v["id"]==p["id"])
            p["publication_status"]="aprovado"
            mf_entry["status"]="aprovado"
            mf_entry["approved_by"]=args.reviewer
            mf_entry["approved_utc"]=datetime.now(timezone.utc).isoformat()
            _audit(job,{"action":"approve","id":p["id"],"reviewer":args.reviewer,
                        "warnings_accepted":bool(p["requires_review"])})
            count+=1
        make_json(job/"manifest.json",manifest)
        make_json(job/"registros_refinados.json",registros)
        print(f"{count} publicações aprovadas. Nenhuma mensagem enviada.")
        return 0
    if args.command=="send":
        if not (args.confirm and args.consent_confirmed):
            raise ValueError("Envio real exige --confirm e --consent-confirmed")
        record=next((r for r in registros["items"] if r["id"]==args.id),None)
        entry=next((v for v in manifest["items"] if v["id"]==args.id),None)
        if record is None or entry is None:
            raise ValueError("ID não encontrado")
        if entry["status"]!="aprovado":
            raise ValueError("Primeiro revise e aprove a publicação com o comando approve")
        from .delivery import send as deliver
        folder=job/"publicacoes"/entry["slug"]
        result=deliver(args.channel,record,folder,args.to)
        manifest["messages_sent"]+=1
        _audit(job,{"action":"send","id":record["id"],"channel":args.channel,
                    "destination_sha256":hashlib.sha256(args.to.encode()).hexdigest()[:16],
                    "provider_message_id":result.get("provider_message_id")})
        make_json(job/"manifest.json",manifest)
        print(json.dumps(result,ensure_ascii=False))
        return 0
    return 1


def main():
    try:
        sys.exit(execute())
    except (ValueError, OSError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"Erro: {exc}",file=sys.stderr)
        sys.exit(2)
