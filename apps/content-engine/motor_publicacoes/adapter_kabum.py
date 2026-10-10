#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Refinamento determinístico de uma captura de busca do KaBuM!.

Uso:
  python refinar_scraping.py entrada.json --output produtos_refinados.json \
      --csv produtos_refinados.csv --report diagnostico.json

Sem bibliotecas externas; preserva o preço anunciado e calcula métricas separadas.
Não realiza novas requisições web.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from urllib.parse import urljoin, urlparse

PRODUCT_RE = re.compile(r'^/produto/(?P<id>\d+)(?:/|$)', re.I)
BRL_RE = re.compile(r'R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})', re.I)
RATING_RE = re.compile(r'Avalia[çc][ãa]o\s*(\d+(?:[.,]\d+)?)\s*de\s*5(?:[.,]0)?', re.I)
INST_RE = re.compile(r'(\d+)\s*x\s*de\s*R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})', re.I)
STOCK_RE = re.compile(r'Resta(?:m)?\s+(\d+)\s+Unid\.', re.I)
DISCOUNT_RE = re.compile(r'Desconto:\s*-?\s*(\d+(?:[.,]\d+)?)\s*%', re.I)
PRODUCT_STARTS = r'(?:Notebook|Placa|PC\s|Computador|Geforce|Gigabyte)'
CUPON_RE = re.compile(r'Cupom\s*([A-Z0-9]{3,22}?)(?='+PRODUCT_STARTS+r')', re.I)
GPU_RE = re.compile(r'\b(RTX|GTX|GT|RX)\s*[- ]?\s*(\d{3,4})(?:\s*(Ti|SUPER))?\b', re.I)
CHARS_RE = re.compile(r'[\ue000-\uf8ff\u200b\u200c\u200d\u2060\uFE0F]')
KNOWN_BRANDS = (
    'GIGABYTE', 'GALAX', 'ASUS', 'MSI', 'PNY', 'INNO3D', 'ZOTAC', 'PALIT',
    'PCYES', 'LENOVO', 'ACER', 'DELL', 'NEOLOGIC', 'INFOTECH', 'HUSKY', 'AFOX',
)
QUANT = Decimal('0.01')


def dec_brl(s: str | None) -> Decimal | None:
    if s is None:
        return None
    try:
        return Decimal(s.replace('.', '').replace(',', '.'))
    except (InvalidOperation, ValueError):
        return None


def money(d: Decimal | None) -> str | None:
    return str(d.quantize(QUANT, rounding=ROUND_HALF_UP)) if d is not None else None


def centavos(d: Decimal | None) -> int | None:
    return int(d * 100) if d is not None else None


def normalize_space(value: str) -> str:
    value = CHARS_RE.sub('', unicodedata.normalize('NFKC', value or ''))
    return re.sub(r'\s+', ' ', value).strip()


def detect_category(title: str) -> str:
    if re.search(r'placa.m[ãa]e|motherboard', title, re.I):
        return 'placa_mae'
    if re.search(r'notebook|alienware', title, re.I):
        return 'notebook'
    if re.search(r'\b(?:PC|computador|workstation)\b', title, re.I):
        return 'computador'
    if re.search(r'placa\s+de\s+v[íi]deo|\b(?:GeForce|GPU)\b|\bRTX\s*\d', title, re.I):
        return 'kit_gpu_fonte' if re.search(r'\+\s*Fonte\b', title, re.I) else 'placa_video'
    return 'outro'


def gpu_model(text: str) -> str | None:
    match = GPU_RE.search(text or '')
    if not match:
        return None
    result = f'{match.group(1).upper()} {match.group(2)}'
    if match.group(3):
        result += f' {match.group(3).upper()}'
    return result


def detect_brand(title: str) -> str | None:
    for brand in KNOWN_BRANDS:
        if re.search(r'\b'+re.escape(brand)+r'\b', title, re.I):
            return {'PCYES': 'PcYes', 'INNO3D':'Inno3D', 'NEOLOGIC':'Neologic', 'INFOTECH':'Infotech', 'HUSKY':'Husky', 'ASUS':'ASUS', 'MSI':'MSI', 'PNY':'PNY', 'GALAX':'GALAX', 'DELL':'Dell'}.get(brand,brand.title())
    return None


def get_specs(title: str, category: str) -> dict:
    """Extrai somente especificações expressas no próprio título do anúncio."""
    if category in ('placa_video','kit_gpu_fonte'):
        vram = re.search(r'(?<!\d)(\d{1,2})\s*GB\b', title, re.I)
        memory = re.search(r'\bGDDR\s*(\d)\b', title, re.I)
        bits = re.search(r'\b(\d{2,3})\s*[- ]?\s*bits?\b', title, re.I)
        return {
            'vram_gb_anunciada': int(vram.group(1)) if vram else None,
            'tipo_vram_anunciada': 'GDDR'+memory.group(1) if memory else None,
            'barramento_bits_anunciado': int(bits.group(1)) if bits else None,
            'dlss_mencionado': True if re.search(r'\bDLSS\b',title,re.I) else None,
            'ray_tracing_mencionado': True if re.search(r'Ray\s+Tracing',title,re.I) else None,
        }
    return {}


def get_sku(title: str) -> str | None:
    # Hífens do modelo no meio do nome não são suficientes para inferir SKU.
    trailing = re.search(r'\s[-–]\s*([A-Z0-9][A-Z0-9-]{4,})\s*$', title, re.I)
    if trailing:
        return trailing.group(1)
    technical = re.search(r'\b(\d{3}-[A-Z0-9]+(?:-[A-Z0-9]+)+)\s*$', title, re.I)
    return technical.group(1) if technical else None


def clean_product_title(preamble: str) -> tuple[str, str | None]:
    text = normalize_space(preamble)
    text = RATING_RE.sub('', text)
    text = re.sub(r'(?i)Frete\s+gr[áa]tis\s*\*?', '', text)
    # O scraper concatena cupom+nome sem espaço, por isso o lookahead.
    coupon = CUPON_RE.search(text)
    code = coupon.group(1).upper() if coupon else None
    if coupon:
        text = text[:coupon.start()] + text[coupon.end():]
    text = normalize_space(text)
    return text, code


def parse_product(link: dict, base_url: str) -> dict | None:
    href = str(link.get('href') or '')
    parsed = urlparse(urljoin(base_url, href))
    if parsed.netloc.lower() not in ('www.kabum.com.br', 'kabum.com.br'):
        return None
    match = PRODUCT_RE.match(parsed.path)
    if not match:
        return None

    raw_text = str(link.get('text') or '')
    price_cut = re.search(r'No\s+PIX\b', raw_text, re.I)
    prefix = raw_text[:price_cut.start()] if price_cut else raw_text
    price_matches = list(BRL_RE.finditer(prefix))
    if not price_matches:
        # Não fabricar preço quando houve falha de extração.
        return {'produto_id': match.group('id'), 'url': urljoin(base_url, href),
                'imagem_url': urljoin(base_url, link.get('image_url')) if link.get('image_url') else None,
                'status_extracao': 'preco_ausente', 'texto_original': raw_text,
                'alertas': ['preco_ausente']}
    current = dec_brl(price_matches[-1].group(1))
    original = dec_brl(price_matches[-2].group(1)) if len(price_matches) > 1 else None
    title, coupon = clean_product_title(prefix[:price_matches[0].start()])
    card_rating = RATING_RE.search(raw_text)
    stock = STOCK_RE.search(raw_text)
    inst = INST_RE.search(raw_text)
    disc = DISCOUNT_RE.search(raw_text)

    installment_value = dec_brl(inst.group(2)) if inst else None
    installment_count = int(inst.group(1)) if inst else None
    installments_total = installment_value * installment_count if inst else None

    advertised = Decimal(disc.group(1).replace(',', '.')) if disc else None
    calculated = ((Decimal('1') - current / original) * 100).quantize(QUANT,rounding=ROUND_HALF_UP) if original and current and original > 0 else None
    model_title = gpu_model(title)
    model_slug = gpu_model(parsed.path.replace('-', ' '))
    cat = detect_category(title)
    specs = get_specs(title, cat)
    issues = []
    if model_title and model_slug and model_title != model_slug:
        issues.append('divergencia_gpu_titulo_url')
    cpu_re = re.compile(r'\bi[3579]\s*-?\s*\d{4,5}[A-Za-z]*\b', re.I)
    cpu_title = cpu_re.search(title)
    cpu_slug = cpu_re.search(parsed.path.replace('-', ' '))
    if cpu_title and cpu_slug and cpu_title.group(0).lower().replace(' ', '').replace('-', '') != cpu_slug.group(0).lower().replace(' ', '').replace('-', ''):
        issues.append('divergencia_cpu_titulo_url')
    if advertised is not None and calculated is not None and abs(calculated - advertised) > Decimal('2'):
        issues.append('desconto_anunciado_diverge_do_calculado')
    if original is not None and current is not None and original < current:
        issues.append('preco_anterior_menor_que_atual')
    if inst and (not installment_count or installment_count <= 0):
        issues.append('parcelamento_invalido')
    if installment_value and installments_total < current * Decimal('0.98'):
        issues.append('parcelamento_total_menor_que_pix')

    return {
        'produto_id': match.group('id'),
        'url': urljoin(base_url, href),
        'imagem_url': urljoin(base_url, link.get('image_url')) if link.get('image_url') else None,
        'titulo': title,
        'sku_anunciado': get_sku(title),
        'marca': detect_brand(title),
        'categoria': cat,
        'modelo_gpu': model_title,
        'especificacoes_anunciadas': specs,
        'corresponde_busca_rtx_5050': bool(model_title == 'RTX 5050'),
        'moeda': 'BRL',
        'preco_pix': money(current),
        'preco_pix_centavos': centavos(current),
        'preco_anterior': money(original),
        'desconto_anunciado_pct': float(advertised) if advertised is not None else None,
        'desconto_calculado_pct': float(calculated) if calculated is not None else None,
        'parcelamento': {
            'quantidade': installment_count,
            'valor_parcela': money(installment_value),
            'valor_total': money(installments_total),
        } if inst else None,
        'avaliacao': float(card_rating.group(1).replace(',', '.')) if card_rating else None,
        'quantidade_restante_anunciada': int(stock.group(1)) if stock else None,
        'frete_gratis_anunciado': True if re.search(r'Frete\s+gr[áa]tis', raw_text, re.I) else None,
        'cupom_anunciado': coupon,
        'status_extracao': 'ok',
        'alertas': issues,
    }


def refinement(source: dict) -> dict:
    data = source.get('data') or {}
    origin = source.get('finalUrl') or source.get('requestedUrl') or 'https://www.kabum.com.br/'
    if urlparse(origin).netloc.lower() not in ('www.kabum.com.br', 'kabum.com.br'):
        raise ValueError('Origem incompatível com o extrator KaBuM!')
    products, ids_seen, duplicates = [], set(), []
    for item in data.get('links', []):
        parsed = parse_product(item, origin)
        if not parsed:
            continue
        if parsed['produto_id'] in ids_seen:
            duplicates.append(parsed['produto_id'])
            continue
        ids_seen.add(parsed['produto_id'])
        parsed['posicao_lista'] = len(products) + 1
        products.append(parsed)

    full_text = data.get('text') or ''
    total_match = re.search(r'(\d[\d.]*)\s+produtos', full_text, re.I)
    query = re.search(r'/busca/([^/?#]+)', urlparse(origin).path, re.I)
    category_counts = Counter(p.get('categoria', 'outro') for p in products)
    alert_counts = Counter(a for p in products for a in p.get('alertas', []))
    matching = [p for p in products if p.get('corresponde_busca_rtx_5050')]
    valid_prices = [Decimal(p['preco_pix']) for p in products if p.get('preco_pix')]
    screenshot = data.get('screenshotArtifact') or {}
    breadcrumbs = []
    for item in data.get('links', []):
        href = str(item.get('href') or '')
        label = normalize_space(str(item.get('text') or ''))
        if href in ('/hardware','/hardware/placa-de-video-vga','/hardware/placa-de-video-vga/placa-de-video-nvidia') and label and label not in breadcrumbs:
            breadcrumbs.append(label)
    if query:
        breadcrumbs.append(query.group(1).replace('-', ' ').upper())
    return {
        'versao_schema': '1.0.0',
        'origem': {
            'loja': 'KaBuM!',
            'url_solicitada': source.get('requestedUrl'),
            'url_final': origin,
            'data_captura_utc': source.get('capturedAt'),
            'status_http': source.get('statusCode'),
            'content_type': source.get('contentType'),
            'termo_busca': query.group(1).replace('-', ' ') if query else None,
            'titulo_pagina': data.get('title'),
            'descricao_pagina': data.get('description'),
            'trilha_navegacao': breadcrumbs,
            'titulos_seo': data.get('headings') or [],
            'total_resultados_informado_pelo_site': int(total_match.group(1).replace('.', '')) if total_match else None,
            'imagem_capturada': {k: screenshot[k] for k in ('id','sha256','fileName','sizeBytes','contentType') if k in screenshot} or None,
        },
        'resumo': {
            'quantidade_produtos_extraidos': len(products),
            'quantidade_aderentes_rtx_5050': len(matching),
            'quantidade_fora_do_termo': len(products)-len(matching),
            'aderentes_sem_divergencia_modelo_url': sum('divergencia_gpu_titulo_url' not in p.get('alertas',[]) for p in matching),
            'aderentes_com_divergencia_modelo_url': sum('divergencia_gpu_titulo_url' in p.get('alertas',[]) for p in matching),
            'distribuicao_categorias': dict(sorted(category_counts.items())),
            'menor_preco_pix_amostra': money(min(valid_prices)) if valid_prices else None,
            'maior_preco_pix_amostra': money(max(valid_prices)) if valid_prices else None,
            'alertas_por_tipo': dict(sorted(alert_counts.items())),
            'ids_duplicados_omitidos': duplicates,
            'ocorrencias_alerta_total': sum(alert_counts.values()),
            'produtos_com_alertas': sum(bool(p.get('alertas')) for p in products),
            'observacoes': [
                'Total anunciado no site não é a quantidade efetivamente capturada.',
                'Frete, cupom e estoque não anunciados são representados por null, não por false/zero.',
                'Desconto anunciado é mantido; percentual calculado não substitui a alegação comercial.',
                'Valores de preço/parcelas são strings decimais para evitar imprecisão de ponto flutuante.',
                'Atributos de vendedores e especificações não foram inferidos a partir de filtros da página.',
            ],
        },
        'produtos': products,
    }


def save_csv(path: Path, products: list[dict]) -> None:
    fields = ['produto_id','posicao_lista','titulo','marca','categoria','modelo_gpu','corresponde_busca_rtx_5050',
              'preco_pix','preco_anterior','desconto_anunciado_pct','desconto_calculado_pct',
              'parcelas','valor_parcela','total_parcelado','avaliacao','estoque_anunciado',
              'frete_gratis_anunciado','cupom_anunciado','alertas','url']
    with path.open('w', encoding='utf-8-sig', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=fields, delimiter=';')
        w.writeheader()
        for p in products:
            inst = p.get('parcelamento') or {}
            w.writerow({
                'produto_id': p['produto_id'], 'posicao_lista':p.get('posicao_lista'), 'titulo': p.get('titulo'), 'marca':p.get('marca'),
                'categoria': p.get('categoria'), 'modelo_gpu':p.get('modelo_gpu'),
                'corresponde_busca_rtx_5050':p.get('corresponde_busca_rtx_5050'),
                'preco_pix':p.get('preco_pix'),'preco_anterior':p.get('preco_anterior'),
                'desconto_anunciado_pct':p.get('desconto_anunciado_pct'),
                'desconto_calculado_pct':p.get('desconto_calculado_pct'),
                'parcelas':inst.get('quantidade'), 'valor_parcela':inst.get('valor_parcela'),
                'total_parcelado':inst.get('valor_total'), 'avaliacao':p.get('avaliacao'),
                'estoque_anunciado':p.get('quantidade_restante_anunciada'),
                'frete_gratis_anunciado':p.get('frete_gratis_anunciado'),
                'cupom_anunciado':p.get('cupom_anunciado'),
                'alertas': '|'.join(p.get('alertas') or []), 'url':p.get('url')
            })


def run() -> int:
    parser = argparse.ArgumentParser(description='Trata JSON bruto da busca KaBuM!')
    parser.add_argument('input', type=Path, help='arquivo com objeto JSON original de scraping')
    parser.add_argument('--output', type=Path, default=Path('produtos_refinados.json'))
    parser.add_argument('--csv', type=Path, default=Path('produtos_refinados.csv'))
    parser.add_argument('--report', type=Path, default=Path('diagnostico.json'))
    args = parser.parse_args()
    raw = json.loads(args.input.read_text(encoding='utf-8-sig'))
    result = refinement(raw)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    save_csv(args.csv, result['produtos'])
    args.report.write_text(json.dumps(result['resumo'], ensure_ascii=False, indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result['resumo'], ensure_ascii=False, indent=2))
    return 0

if __name__ == '__main__':
    sys.exit(run())
