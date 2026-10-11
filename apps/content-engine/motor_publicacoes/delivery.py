"""Envios EXPLÍCITOS para canais oficiais. Nenhuma rotina dispara mensagens sozinha.

Não há fila/retry automático para evitar duplicidade em falhas parciais de rede.
"""
from __future__ import annotations

import hashlib
import html
import http.client
import json
import os
import re
import secrets
import smtplib
import ssl
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse

from .publications import email_html, plain_email, telegram_caption, whatsapp_caption


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Configure a variável de ambiente {name}")
    return value


def _json_request(host: str, path: str, body: dict, token: str | None = None) -> dict:
    conn = http.client.HTTPSConnection(host, timeout=25, context=ssl.create_default_context())
    try:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        conn.request("POST", path, json.dumps(body, ensure_ascii=False).encode(), headers)
        result = conn.getresponse()
        payload = result.read(25000).decode("utf-8", errors="replace")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            data = {}
        if not 200 <= result.status < 300:
            # Não expor tokens, números completos ou conteúdo sensível em erros.
            raise RuntimeError(f"Falha no provedor (HTTP {result.status}); verifique credenciais e permissões")
        return data
    finally:
        conn.close()


def _multipart_request(host: str, path: str, fields: dict, image: bytes, filename: str, token: str | None = None) -> dict:
    boundary = "---publication" + secrets.token_hex(16)
    parts = []
    for k, v in fields.items():
        parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode())
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: image/png\r\n\r\n").encode() + image + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    conn = http.client.HTTPSConnection(host, timeout=30, context=ssl.create_default_context())
    try:
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        if token:
            headers["Authorization"] = "Bearer " + token
        conn.request("POST", path, b"".join(parts), headers)
        res = conn.getresponse()
        data = res.read(25000).decode("utf-8", errors="replace")
        if not 200 <= res.status < 300:
            raise RuntimeError(f"Falha no upload de mídia (HTTP {res.status})")
        return json.loads(data)
    finally:
        conn.close()


def send_whatsapp(item: dict, folder: Path, to: str) -> dict:
    if not re.fullmatch(r"\d{8,15}", to):
        raise ValueError("Destinatário WhatsApp deve ter DDI e DDD, apenas dígitos")
    token = required("WHATSAPP_ACCESS_TOKEN")
    phone_id = required("WHATSAPP_PHONE_NUMBER_ID")
    if not phone_id.isdigit():
        raise ValueError("WHATSAPP_PHONE_NUMBER_ID inválido")
    version = os.getenv("META_GRAPH_VERSION", "v24.0")
    if not re.fullmatch(r"v\d+\.0", version):
        raise ValueError("META_GRAPH_VERSION inválida")
    host = "graph.facebook.com"
    base = f"/{version}/{phone_id}"
    upload = _multipart_request(host, base+"/media", {"messaging_product":"whatsapp"},
                                (folder/"card-square.png").read_bytes(), "publicacao.png", token)
    media_id = upload.get("id")
    if not media_id:
        raise RuntimeError("Provedor não devolveu ID da mídia")
    body = {"messaging_product": "whatsapp", "recipient_type":"individual", "to": to,
            "type":"image", "image": {"id":media_id,"caption":whatsapp_caption(item)}}
    result = _json_request(host, base+"/messages", body, token)
    ids = result.get("messages") or []
    return {"channel":"whatsapp", "sent":True, "provider_message_id":ids[0].get("id") if ids else None}


def send_telegram(item: dict, folder: Path, chat_id: str) -> dict:
    if not re.fullmatch(r"[-\d]{3,28}|@[A-Za-z0-9_]{5,}", chat_id):
        raise ValueError("ID do chat inválido")
    token = required("TELEGRAM_BOT_TOKEN")
    # Telegram sendPhoto usa multipart com campo 'photo' (não 'file').
    boundary = "---publication" + secrets.token_hex(16)
    parts = []
    for k,v in {"chat_id":chat_id, "parse_mode":"HTML", "caption":telegram_caption(item)}.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode("utf-8"))
    image = (folder/"card-square.png").read_bytes()
    parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"publicacao.png\"\r\nContent-Type: image/png\r\n\r\n").encode()+image+b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    conn = http.client.HTTPSConnection("api.telegram.org", timeout=30, context=ssl.create_default_context())
    try:
        conn.request("POST", f"/bot{token}/sendPhoto", b"".join(parts), {"Content-Type":f"multipart/form-data; boundary={boundary}"})
        res = conn.getresponse()
        body = res.read(25000)
        if not 200 <= res.status < 300:
            raise RuntimeError(f"Erro Telegram HTTP {res.status}")
        obj = json.loads(body)
        if not obj.get("ok"):
            raise RuntimeError("Telegram não confirmou o envio")
        return {"channel":"telegram", "sent":True, "provider_message_id":(obj.get("result") or {}).get("message_id")}
    finally:
        conn.close()


def send_smtp(item: dict, folder: Path, to: str) -> dict:
    if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", to):
        raise ValueError("E-mail do destinatário inválido")
    host, username, password, from_address = [required(x) for x in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM")]
    if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", from_address):
        raise ValueError("SMTP_FROM inválido")
    port = int(os.getenv("SMTP_PORT", "587"))
    if port not in (465, 587, 25, 2525):
        raise ValueError("Porta SMTP não permitida")
    # Envio comercial exige link de descadastro válido, em vez de inventá-lo.
    unsubscribe_url = required("UNSUBSCRIBE_URL")
    parsed = urlparse(unsubscribe_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("UNSUBSCRIBE_URL deve ser HTTPS")
    msg = EmailMessage()
    msg["Subject"] = item["title"][:150]
    msg["To"] = to
    msg["From"] = from_address
    msg["List-Unsubscribe"] = f"<{unsubscribe_url}>"
    msg.set_content(plain_email(item)+f"\n\nDescadastrar: {unsubscribe_url}\n")
    msg.add_alternative(email_html(item,"cid:imagem_publicacao").replace("</body>",
        f'<p style="text-align:center;font-size:12px"><a href="{html.escape(unsubscribe_url,quote=True)}">Descadastrar</a></p></body>'), subtype="html")
    msg.get_payload()[-1].add_related((folder/"card-square.png").read_bytes(), maintype="image",subtype="png",cid="<imagem_publicacao>")
    context = ssl.create_default_context()
    if port == 465:
        smtp_client = smtplib.SMTP_SSL(host, port, timeout=20, context=context)
    else:
        smtp_client = smtplib.SMTP(host, port, timeout=20)
    with smtp_client as connection:
        if port != 465:
            connection.ehlo()
            if not connection.has_extn("starttls"):
                raise RuntimeError("Servidor SMTP não oferece STARTTLS")
            connection.starttls(context=context)
            connection.ehlo()
        connection.login(username, password)
        connection.send_message(msg)
    return {"channel":"email", "sent":True, "provider_message_id":None}


def send_webhook(item: dict, folder: Path, to: str) -> dict:
    dest = required("WEBHOOK_URL")
    allowed = set(x.strip().lower() for x in required("WEBHOOK_ALLOWED_HOSTS").split(",") if x.strip())
    obj = urlparse(dest)
    if obj.scheme != "https" or not obj.hostname or obj.hostname.lower() not in allowed or obj.username or obj.password:
        raise ValueError("WEBHOOK_URL deve ser HTTPS e host explicitamente permitido")
    if obj.port not in (None,443):
        raise ValueError("Webhook externo apenas porta 443")
    payload = json.loads((folder/"webhook.json").read_text(encoding="utf-8"))
    payload["event"] = "publication.send_requested"
    payload["target"] = to
    token = os.getenv("WEBHOOK_BEARER_TOKEN") or None
    path = obj.path or "/"
    if obj.query:
        path += "?"+obj.query
    result = _json_request(obj.hostname, path, payload, token)
    return {"channel":"webhook", "sent":True, "provider_message_id":result.get("id")}


def send(channel: str, item: dict, folder: Path, to: str) -> dict:
    implementations = {"whatsapp":send_whatsapp,"telegram":send_telegram,"email":send_smtp,"webhook":send_webhook}
    if channel not in implementations:
        raise ValueError(f"Canal sem envio direto: {channel}. Gere as artes e conecte ao provedor via webhook.")
    return implementations[channel](item, folder, to)
