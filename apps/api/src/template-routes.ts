import { Prisma, TenantRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertSafePublicUrl } from "@argws/scout-shared/url-policy";
import { authenticated, hasRole, isManagerUser } from "./auth.ts";
import { prisma } from "./db.ts";
import { audit } from "./audit.ts";
import {
  buildTemplateSource,
  getStarterTemplate,
  listStarterTemplates,
  templateInstanceSlug,
} from "./instance-templates.ts";

const createFromTemplateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  query: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .refine(
      (value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value),
      "Termo de busca inválido.",
    ),
  source: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      url: z.string().url().max(2048).optional(),
      allowedHosts: z
        .array(z.string().min(1).max(253))
        .min(1)
        .max(20)
        .optional(),
      engine: z.enum(["HTTP", "PLAYWRIGHT"]).optional(),
      selector: z.string().trim().max(500).optional(),
      captureScreenshot: z.boolean().optional(),
      requestIntervalMs: z.number().int().min(1000).max(300000).optional(),
    })
    .optional(),
});

export async function registerTemplateRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/instance-templates",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!isManagerUser(request))
        return reply
          .code(403)
          .send({
            error: { code: "FORBIDDEN", message: "Use uma sessão do Manager." },
          });
      return { version: 1, data: listStarterTemplates() };
    },
  );

  app.post(
    "/instance-templates/:templateId/create",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 15, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      if (
        !isManagerUser(request) ||
        !hasRole(
          request,
          TenantRole.OWNER,
          TenantRole.ADMIN,
          TenantRole.OPERATOR,
        )
      )
        return reply
          .code(403)
          .send({
            error: {
              code: "FORBIDDEN",
              message: "Esta ação exige acesso de operação.",
            },
          });
      const params = z
        .object({ templateId: z.string().min(2).max(80) })
        .safeParse(request.params);
      if (!params.success)
        return reply
          .code(400)
          .send({
            error: { code: "VALIDATION_ERROR", message: "Modelo inválido." },
          });
      const template = getStarterTemplate(params.data.templateId);
      if (!template)
        return reply
          .code(404)
          .send({
            error: {
              code: "TEMPLATE_NOT_FOUND",
              message: "Modelo não encontrado.",
            },
          });
      const parsed = createFromTemplateSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Revise o modelo e os campos da instância.",
            fields: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });

      let source;
      try {
        source = buildTemplateSource(
          template,
          parsed.data.query,
          parsed.data.source,
        );
        await assertSafePublicUrl(
          source.url.replace(/\{\{input\.[\w.-]+\}\}/g, "probe"),
          source.allowedHosts,
          process.env.SCOUT_ALLOW_HTTP === "true",
        );
      } catch (cause) {
        request.log.info(
          { templateId: template.id },
          "Template source validation rejected",
        );
        return reply.code(400).send({
          error: {
            code: "TEMPLATE_SOURCE_BLOCKED",
            message:
              cause instanceof Error
                ? cause.message
                : "Fonte do modelo não é permitida.",
          },
        });
      }
      const tenantId = request.principal!.tenantId;
      const description =
        parsed.data.description ??
        `${template.description} Modelo inicial editável: revise as regras do site antes de executar.`;
      try {
        const instance = await prisma.instance.create({
          data: {
            tenantId,
            name: parsed.data.name,
            slug: templateInstanceSlug(parsed.data.name),
            description: description.slice(0, 500),
            metadata: {
              starterTemplate: {
                id: template.id,
                version: 1,
                provider: template.provider,
                query: parsed.data.query,
                copiedAt: new Date().toISOString(),
              },
            } as Prisma.InputJsonValue,
            sources: {
              create: {
                name: source.name,
                engine: source.engine,
                urlTemplate: source.url,
                allowedHosts: source.allowedHosts,
                selector: source.selector,
                respectRobots: true,
                captureScreenshot: source.captureScreenshot,
                requestIntervalMs: source.requestIntervalMs,
              },
            },
          },
          include: { sources: true },
        });
        await audit({
          tenantId,
          actorUserId: request.principal!.userId,
          action: "instance.created_from_template",
          resourceType: "instance",
          resourceId: instance.id,
          metadata: { templateId: template.id, templateVersion: 1 },
        });
        return reply.code(201).send({
          instance,
          source: instance.sources[0],
          templateId: template.id,
          note: "Instância e fonte criadas. Verifique a página, os seletores e as regras antes da primeira coleta.",
        });
      } catch (cause) {
        if (
          cause instanceof Prisma.PrismaClientKnownRequestError &&
          cause.code === "P2002"
        )
          return reply.code(409).send({
            error: {
              code: "INSTANCE_ALREADY_EXISTS",
              message:
                "Já existe uma instância com identificador semelhante. Tente novamente.",
            },
          });
        throw cause;
      }
    },
  );
}
