import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { TenantSmtpConfig } from "@prisma/client";
import { decryptSecret } from "@argws/scout-shared/crypto";
import { prisma } from "./db.ts";

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  password?: string | null;
  fromEmail: string;
  fromName: string;
};

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export class TenantSmtpNotConfiguredError extends Error {
  constructor() {
    super("SMTP de envio não configurado nesta organização.");
    this.name = "TenantSmtpNotConfiguredError";
  }
}

function transporter(settings: SmtpSettings): Transporter {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.username
      ? { auth: { user: settings.username, pass: settings.password ?? "" } }
      : {}),
    requireTLS: !settings.secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function sender(settings: SmtpSettings): { name: string; address: string } {
  return { name: settings.fromName, address: settings.fromEmail };
}

export function recoverySmtpSettings(
  env: NodeJS.ProcessEnv = process.env,
): SmtpSettings | null {
  const host = env.SCOUT_RECOVERY_SMTP_HOST?.trim();
  const fromEmail = env.SCOUT_RECOVERY_SMTP_FROM_EMAIL?.trim();
  if (!host && !fromEmail) return null;
  if (!host || !fromEmail)
    throw new Error("SMTP de recuperação exige host e remetente configurados.");
  const port = Number(env.SCOUT_RECOVERY_SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Porta do SMTP de recuperação inválida.");
  const username = env.SCOUT_RECOVERY_SMTP_USERNAME?.trim() || undefined;
  const password = env.SCOUT_RECOVERY_SMTP_PASSWORD || undefined;
  if (Boolean(username) !== Boolean(password))
    throw new Error(
      "Usuário e senha do SMTP de recuperação devem ser informados juntos.",
    );
  return {
    host,
    port,
    secure: env.SCOUT_RECOVERY_SMTP_SECURE === "true",
    username,
    password,
    fromEmail,
    fromName: env.SCOUT_RECOVERY_SMTP_FROM_NAME?.trim() || "ARGWS Scout",
  };
}

function tenantSmtpSettings(config: TenantSmtpConfig): SmtpSettings {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    password: config.passwordEncrypted
      ? decryptSecret(config.passwordEncrypted)
      : null,
    fromEmail: config.fromEmail,
    fromName: config.fromName,
  };
}

async function sendWith(settings: SmtpSettings, message: OutgoingEmail) {
  return transporter(settings).sendMail({
    from: sender(settings),
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}

export async function verifySmtp(settings: SmtpSettings): Promise<void> {
  await transporter(settings).verify();
}

export async function sendRecoveryEmail(input: {
  to: string;
  name: string;
  resetUrl: string;
}): Promise<void> {
  const settings = recoverySmtpSettings();
  if (!settings) throw new Error("SMTP de recuperação não configurado.");
  await sendWith(settings, {
    to: input.to,
    subject: "Redefinição da senha do ARGWS Scout",
    text: [
      `Olá, ${input.name}.`,
      "",
      "Recebemos uma solicitação para redefinir sua senha do ARGWS Scout.",
      `Use este link em até 30 minutos: ${input.resetUrl}`,
      "",
      "Se você não pediu esta redefinição, ignore esta mensagem.",
    ].join("\n"),
    html: `<p>Olá, ${escapeHtml(input.name)}.</p><p>Recebemos uma solicitação para redefinir sua senha do ARGWS Scout.</p><p><a href="${escapeHtml(input.resetUrl)}">Redefinir senha</a></p><p>Este link expira em 30 minutos. Se você não pediu esta redefinição, ignore esta mensagem.</p>`,
  });
}

export async function sendTenantEmail(
  tenantId: string,
  message: OutgoingEmail,
): Promise<{ messageId: string }> {
  const config = await prisma.tenantSmtpConfig.findUnique({
    where: { tenantId },
  });
  if (!config) throw new TenantSmtpNotConfiguredError();
  const result = await sendWith(tenantSmtpSettings(config), message);
  return { messageId: result.messageId };
}

export async function testTenantSmtp(
  config: TenantSmtpConfig,
  recipient: string,
): Promise<void> {
  const settings = tenantSmtpSettings(config);
  await verifySmtp(settings);
  await sendWith(settings, {
    to: recipient,
    subject: "Teste de SMTP — ARGWS Scout",
    text: `Este e-mail confirma que o SMTP de envio da organização está configurado. Remetente: ${settings.fromEmail}.`,
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}
