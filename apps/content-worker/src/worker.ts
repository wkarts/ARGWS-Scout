import "dotenv/config";
import amqp from "amqplib";
import { Prisma, PrismaClient, ContentBatchStatus, ContentReviewStatus } from "@prisma/client";
import { QUEUES } from "@argws/scout-core";
import { storeArtifact } from "@argws/scout-shared/storage";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();
const amqpUrl = process.env.RABBITMQ_URL;
const engineUrl = process.env.SCOUT_CONTENT_ENGINE_URL ?? "http://content-engine:8088";
const apiKey = process.env.SCOUT_CONTENT_ENGINE_KEY ?? "";
if (!amqpUrl || !/^https?:\/\/[^/]+$/.test(engineUrl) || apiKey.length < 32)
  throw new Error("Configure RABBITMQ_URL, SCOUT_CONTENT_ENGINE_URL e uma chave interna de 32+ caracteres.");
// A URL do serviço é configurada pelo operador de infraestrutura; nunca usa
// URL extraída do scraping. Em Docker ela aponta ao host fixo content-engine.
const engine = async (path: string, options: RequestInit = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), path === "/v1/process" ? 900_000 : 180_000);
  try {
    const response = await fetch(`${engineUrl}${path}`, {
      ...options, signal: controller.signal,
      headers: { "x-api-key": apiKey, ...(options.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Serviço de conteúdo retornou HTTP ${response.status}`);
    return response;
  } finally { clearTimeout(timeout); }
};
const asObject = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
function validCapturedDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function originHost(value: unknown): string {
  try { return new URL(String(value)).hostname.toLowerCase().slice(0,255); }
  catch { return "sem-dominio"; }
}
function identityKey(item: Record<string, unknown>): string {
  const external = String(item.id ?? "").trim();
  if (external && external.length <= 190) return external;
  return createHash("sha256").update(String(item.url ?? item.title ?? "")).digest("hex");
}
async function engineJson(path: string, options?: RequestInit): Promise<any> {
  return (await engine(path, options)).json();
}
async function engineFile(path: string, maxBytes: number): Promise<Buffer> {
  const response = await engine(path);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new Error("Arte excedeu o limite de tamanho");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Arte excedeu o limite de tamanho");
  return bytes;
}
async function processBatch(batchId: string, tenantId: string): Promise<void> {
  const claim = await prisma.contentBatch.updateMany({
    where: {id:batchId, tenantId, status:ContentBatchStatus.QUEUED},
    data: {status:ContentBatchStatus.RUNNING, startedAt:new Date(), attempts:{increment:1}, errorCode:null},
  });
  if (!claim.count) return;
  const batch = await prisma.contentBatch.findUnique({
    where:{id:batchId},include:{job:{include:{instance:true}}},
  });
  if (!batch) return;
  const options = asObject(batch.options);
  try {
    if (batch.job.status !== "SUCCEEDED" || batch.job.tenantId !== tenantId)
      throw new Error("Job não disponível para refinamento");
    const started = await engineJson("/v1/process", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({payload:batch.job.result, options:{
        query:String(options.query ?? "").slice(0,150),
        only_relevant:options.onlyRelevant === true,
        max_items:Math.min(250, Math.max(1,Number(options.maxItems ?? 100))),
        create_story:options.createStory !== false,
        fetch_images:options.fetchImages === true,
        enrich_images:options.enrichImages === true,
      }}),
    });
    const outputJobId = String(started.job_id ?? "");
    if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(outputJobId))
      throw new Error("Identificador da saída inválido");
    const [manifest, normalized] = await Promise.all([
      engineJson(`/v1/jobs/${outputJobId}/manifest`),
      engineJson(`/v1/jobs/${outputJobId}/normalized`),
    ]);
    const results = new Map<string, any>((normalized.items ?? []).map((row:any)=>[String(row.id),row]));
    for (const output of manifest.items ?? []) {
      const sourceId = String(output.id ?? "");
      const record = results.get(sourceId);
      if (!record || !/^[-a-zA-Z0-9_]+$/.test(String(output.slug)))
        throw new Error("Manifesto contém item sem referência válida");
      const recordSource = asObject(record.source);
      const host = originHost(recordSource.url || record.url);
      const key = identityKey(record);
      const identity = await prisma.contentIdentity.upsert({
        where:{instanceId_originHost_externalKey:{instanceId:batch.instanceId,originHost:host,externalKey:key}},
        update:{title:String(record.title).slice(0,500),url:record.url ?? null},
        create:{tenantId:batch.tenantId,instanceId:batch.instanceId,originHost:host,externalKey:key,
                title:String(record.title).slice(0,500),url:record.url ?? null},
      });
      const existing = await prisma.contentEntry.findUnique({
        where:{batchId_sourceRecordId:{batchId:batch.id,sourceRecordId:key}},
      });
      if (existing) continue;
      const path = `/v1/jobs/${outputJobId}/files/publicacoes/${output.slug}/`;
      const captions: Record<string,string> = {};
      const textFiles: Record<string,string> = {
        whatsapp:"whatsapp.txt",telegram:"telegram.html.txt",emailText:"email.txt",
        emailHtml:"email.html",facebook:"facebook.txt",instagram:"instagram.txt",
        linkedin:"linkedin.txt",sms:"sms.txt",
      };
      for (const [channel, file] of Object.entries(textFiles)) {
        const text = await engineFile(path + file,128_000);
        captions[channel] = text.toString("utf8");
      }
      const imgs: Record<string,string> = {};
      const artifactRows: Array<{id:string,jobId:string,kind:string,objectKey:string,fileName:string,contentType:string,sha256:string,sizeBytes:bigint}> = [];
      for (const [format, file, type, limit] of [
        ["square","card-square.png","image/png",3_000_000],
        ["wide","card-wide.png","image/png",3_000_000],
        ...(options.createStory === false ? [] : [["story","card-story.png","image/png",4_000_000]]),
        ["eml","email.eml","message/rfc822",5_000_000],
      ] as Array<[string,string,string,number]>) {
        const bytes = await engineFile(path + file,limit);
        const stored = await storeArtifact({tenantId:batch.tenantId,jobId:batch.jobId,
          fileName:`content-${key.slice(0,30)}-${file}`,contentType:type,bytes});
        imgs[format] = stored.id;
        artifactRows.push({id:stored.id,jobId:batch.jobId,kind:`content-${format}`,
          objectKey:stored.objectKey,fileName:file,contentType:type,
          sha256:stored.sha256,sizeBytes:BigInt(stored.sizeBytes)});
      }
      await prisma.$transaction(async tx=>{
        for (const artifact of artifactRows) await tx.artifact.create({data:artifact});
        await tx.contentObservation.upsert({
          where:{identityId_jobId:{identityId:identity.id,jobId:batch.jobId}},
          update:{},create:{identityId:identity.id,jobId:batch.jobId,
            price:record.price ?? null,previousPrice:record.previous_price ?? null,
            capturedAt:validCapturedDate(recordSource.captured_at)},
        });
        await tx.contentEntry.create({data:{batchId:batch.id,identityId:identity.id,
          sourceRecordId:key,title:String(record.title).slice(0,500),
          kind:String(record.kind ?? "conteudo").slice(0,64),url:record.url ?? null,
          price:record.price ?? null,
          normalized:record as Prisma.InputJsonValue,
          channels:captions as Prisma.InputJsonValue,
          images:imgs as Prisma.InputJsonValue,
          warnings:(record.warnings ?? []) as Prisma.InputJsonValue,
          reviewStatus:record.requires_review ? ContentReviewStatus.REVIEW : ContentReviewStatus.DRAFT,
        }});
      });
      // Atualiza o lease implícito para o recuperador de workers interrompidos.
      await prisma.contentBatch.update({where:{id:batch.id},data:{updatedAt:new Date()}});
    }
    await prisma.contentBatch.update({where:{id:batch.id},data:{status:ContentBatchStatus.SUCCEEDED,
      total:Number(manifest.total ?? 0),reviewRequired:Number(manifest.review_required ?? 0),
      finishedAt:new Date(),errorCode:null}});
    // Artefatos definitivos estão no S3; liberar cache temporário do Python.
    await engine(`/v1/jobs/${outputJobId}`, {method:"DELETE"}).catch(()=>undefined);
  } catch(err) {
    // Repetições feitas pela Outbox; não apagar dados parciais de execução.
    const attempts = batch.attempts;
    const terminalInputError = err instanceof Error && /HTTP (413|422)/.test(err.message);
    const retry = attempts < 3 && !terminalInputError;
    await prisma.$transaction(async tx=>{
      await tx.contentBatch.update({where:{id:batch.id},data:{status:retry?ContentBatchStatus.QUEUED:ContentBatchStatus.FAILED,
        errorCode: terminalInputError ? "UNSUPPORTED_CAPTURE" : "REFINEMENT_FAILED",
        ...(retry?{startedAt:null}:{finishedAt:new Date()})}});
      if (retry) await tx.outbox.create({data:{tenantId:batch.tenantId,eventType:"content.refine",
        routingKey:"content.refine",aggregateId:batch.id,
        nextAttemptAt:new Date(Date.now()+15000*attempts),payload:{batchId:batch.id,tenantId:batch.tenantId}}});
    });
    process.stderr.write(`Refinamento ${batch.id}: ${err instanceof Error ? err.name : "erro"} (tentativa ${attempts})\n`);
  }
}
const conn=await amqp.connect(amqpUrl);
const channel=await conn.createChannel();
await channel.assertQueue(QUEUES.content,{durable:true});
await channel.prefetch(1);
await channel.consume(QUEUES.content,async message=>{
  if (!message) return;
  try {
    const data=JSON.parse(message.content.toString()) as {batchId?:string,tenantId?:string};
    if (typeof data.batchId === "string" && typeof data.tenantId === "string")
      await processBatch(data.batchId,data.tenantId);
    channel.ack(message);
  } catch (error) {
    // Mensagens inválidas são descartadas; falhas de infraestrutura são
    // reenfileiradas e não publicam nada.
    process.stderr.write("Worker de conteúdo: falha ao processar envelope\n");
    channel.nack(message,false,true);
  }
},{noAck:false});
process.stdout.write("Worker de refinamento pronto. Nenhum envio automático.\n");
async function shutdown() {
  await channel.close().catch(()=>undefined);
  await conn.close().catch(()=>undefined);
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
conn.on("close",()=>process.exit(1));
