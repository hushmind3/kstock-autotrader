import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { BROKER_IDS, type BrokerCredentials, type BrokerId } from "@kstock/shared";
import { adminTokenMatches } from "../security/admin-token.js";
import type { TradingEngine } from "../core/trading-engine.js";

const ControlSchema = z.object({
  action: z.enum([
    "halt-all",
    "resume-global",
    "pause-new-buys",
    "resume-new-buys",
    "pause-broker",
    "start-broker",
  ]),
  brokerId: z.enum(BROKER_IDS).optional(),
});

const AmendSchema = z.object({
  newLimitPrice: z.number().int().positive(),
  remainingQuantity: z.number().int().positive().optional(),
});

const CredentialParamsSchema = z.object({
  brokerId: z.enum(BROKER_IDS),
  environment: z.enum(["live", "paper"]),
});

const CredentialBodySchema = z.object({
  appKey: z.string().trim().min(1).max(512),
  appSecret: z.string().trim().min(1).max(1_024),
  accountId: z.string().trim().min(1).max(64),
  accountProductCode: z.string().trim().max(8).optional(),
  htsId: z.string().trim().max(128).optional(),
  connectNow: z.boolean().default(true),
}).strict();

const DerivativeCredentialParamsSchema = z.object({
  environment: z.enum(["live", "paper"]),
});

const DerivativeCredentialBodySchema = z.object({
  appKey: z.string().trim().min(1).max(512).optional(),
  appSecret: z.string().trim().min(1).max(1_024).optional(),
  reuseCashCredentials: z.boolean().default(false),
  accountId: z.string().trim().min(1).max(64),
  accountProductCode: z.literal("03").default("03"),
  htsId: z.string().trim().max(128).optional(),
  connectNow: z.boolean().default(true),
}).strict().superRefine((input, context) => {
  if (!/^[0-9-]+$/.test(input.accountId)) {
    context.addIssue({
      code: "custom",
      path: ["accountId"],
      message: "선물·옵션 계좌번호는 숫자와 하이픈만 입력할 수 있습니다.",
    });
  }
  const compact = input.accountId.replaceAll("-", "");
  if (!/^(?:\d{8}|\d{8}03)$/.test(compact)) {
    context.addIssue({
      code: "custom",
      path: ["accountId"],
      message: "한국투자 선물·옵션 계좌번호는 8자리이거나 상품코드 03을 포함한 10자리여야 합니다.",
    });
  }
  if ((input.appKey === undefined) !== (input.appSecret === undefined)) {
    context.addIssue({
      code: "custom",
      path: input.appKey === undefined ? ["appKey"] : ["appSecret"],
      message: "API 키와 API 비밀키는 둘 다 입력해야 합니다.",
    });
  }
  if (!input.reuseCashCredentials && input.appKey === undefined) {
    context.addIssue({
      code: "custom",
      path: ["reuseCashCredentials"],
      message: "현물 API 키 재사용을 선택하거나 API 키와 비밀키를 직접 입력해 주세요.",
    });
  }
});

const DerivativesControlSchema = z.object({
  action: z.enum(["start", "halt", "pause-new", "resume-new"]),
}).strict();

function validatedCredentials(
  brokerId: BrokerId,
  input: z.infer<typeof CredentialBodySchema>,
): BrokerCredentials {
  if (!/^[0-9-]+$/.test(input.accountId)) {
    throw new z.ZodError([{
      code: "custom",
      path: ["accountId"],
      message: "계좌번호는 숫자와 하이픈만 입력할 수 있습니다.",
    }]);
  }

  const compactAccountId = input.accountId.replaceAll("-", "");
  if (brokerId === "kiwoom") {
    if (!/^(?:\d{8}|\d{10})$/.test(compactAccountId)) {
      throw new z.ZodError([{
        code: "custom",
        path: ["accountId"],
        message: "키움 계좌번호는 8자리 또는 상품코드를 포함한 10자리 숫자여야 합니다.",
      }]);
    }
    return {
      appKey: input.appKey,
      appSecret: input.appSecret,
      accountId: input.accountId,
    };
  }

  const productCode = input.accountProductCode?.trim();
  const htsId = input.htsId?.trim();
  const accountNumber = compactAccountId.length === 10
    ? compactAccountId.slice(0, 8)
    : compactAccountId;
  const accountProductInNumber = compactAccountId.length === 10
    ? compactAccountId.slice(8)
    : null;
  const issues: z.core.$ZodIssue[] = [];
  if (!/^\d{8}$/.test(accountNumber)) {
    issues.push({
      code: "custom",
      path: ["accountId"],
      message: "한국투자 계좌번호(CANO)는 8자리 숫자여야 합니다.",
    });
  }
  if (!productCode || !/^\d{2}$/.test(productCode)) {
    issues.push({
      code: "custom",
      path: ["accountProductCode"],
      message: "한국투자 계좌 상품코드는 2자리 숫자여야 합니다.",
    });
  } else if (accountProductInNumber && accountProductInNumber !== productCode) {
    issues.push({
      code: "custom",
      path: ["accountProductCode"],
      message: "계좌번호에 포함된 상품코드와 입력한 상품코드가 다릅니다.",
    });
  }
  if (!htsId) {
    issues.push({
      code: "custom",
      path: ["htsId"],
      message: "실시간 주문·체결 확인을 위한 HTS 사용자 ID가 필요합니다.",
    });
  }
  if (issues.length > 0) throw new z.ZodError(issues);

  return {
    appKey: input.appKey,
    appSecret: input.appSecret,
    accountId: accountNumber,
    accountProductCode: productCode!,
    htsId: htsId!,
  };
}

function allowedOrigins(): Set<string> {
  return new Set([
    "http://127.0.0.1:3100",
    "http://localhost:3100",
    ...(process.env.WEB_ORIGIN ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);
}

export async function createApiServer(
  engine: TradingEngine,
  adminToken: string,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-kstock-admin-token",
          "*.appKey",
          "*.appSecret",
          "*.token",
          "*.accountId",
          "req.body.appKey",
          "req.body.appSecret",
          "req.body.accountId",
          "req.body.accountProductCode",
          "req.body.htsId",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 256 * 1024,
    // Credential verification may perform several real broker queries. This is
    // deliberately longer than the adapters' individual transport timeouts.
    requestTimeout: 65_000,
  });

  const origins = allowedOrigins();
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || origins.has(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "x-kstock-admin-token"],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const header = request.headers["x-kstock-admin-token"];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!adminTokenMatches(adminToken, provided)) {
      await reply.code(401).send({ error: "unauthorized", message: "관리 토큰이 유효하지 않습니다." });
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "kstock-trading-engine",
    instanceId: process.env.KSTOCK_INSTANCE_ID ?? null,
    buildFingerprint: process.env.KSTOCK_BUILD_FINGERPRINT ?? null,
    startedAt: engine.startedAt,
    market: engine.marketSession,
  }));

  app.get("/api/dashboard", async () => engine.dashboard());
  app.get("/api/settings", async () => engine.settingsResponse());
  app.put("/api/settings", async (request) => engine.updateSettings(request.body));
  app.post<{
    Params: { brokerId: string; environment: string };
  }>("/api/credentials/:brokerId/:environment", async (request) => {
    const params = CredentialParamsSchema.parse(request.params);
    const input = CredentialBodySchema.parse(request.body);
    const credentials = validatedCredentials(params.brokerId, input);
    return engine.saveCredentials(params.brokerId, params.environment, {
      credentials,
      connectNow: input.connectNow,
    });
  });
  app.delete<{
    Params: { brokerId: string; environment: string };
  }>("/api/credentials/:brokerId/:environment", async (request) => {
    const params = CredentialParamsSchema.parse(request.params);
    return engine.deleteCredentials(params.brokerId, params.environment);
  });
  app.get<{
    Params: { environment: string };
  }>("/api/derivatives/credentials/koreainvestment/:environment", async (request) => {
    const params = DerivativeCredentialParamsSchema.parse(request.params);
    return engine.derivativeCredentialsStatus(params.environment);
  });
  app.post<{
    Params: { environment: string };
  }>("/api/derivatives/credentials/koreainvestment/:environment", async (request) => {
    const params = DerivativeCredentialParamsSchema.parse(request.params);
    const input = DerivativeCredentialBodySchema.parse(request.body);
    return engine.saveDerivativeCredentials(params.environment, input);
  });
  app.post<{
    Params: { environment: string };
  }>("/api/derivatives/credentials/koreainvestment/:environment/verify", async (request) => {
    const params = DerivativeCredentialParamsSchema.parse(request.params);
    return engine.verifyDerivativeCredentials(params.environment);
  });
  app.delete<{
    Params: { environment: string };
  }>("/api/derivatives/credentials/koreainvestment/:environment", async (request) => {
    const params = DerivativeCredentialParamsSchema.parse(request.params);
    return engine.deleteDerivativeCredentials(params.environment);
  });
  app.get("/api/derivatives/dashboard", async () => engine.derivativesDashboard());
  app.get("/api/derivatives/settings", async () => engine.derivativesSettingsResponse());
  app.put("/api/derivatives/settings", async (request) =>
    engine.updateDerivativesSettings(request.body));
  app.post("/api/derivatives/control", async (request) => {
    const input = DerivativesControlSchema.parse(request.body);
    return engine.controlDerivatives(input.action);
  });
  app.post("/api/derivatives/reconcile", async () => engine.reconcileDerivatives());
  app.post("/api/control", async (request) => {
    const input = ControlSchema.parse(request.body);
    await engine.control(input.action, input.brokerId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/orders/:id/cancel", async (request) => {
    await engine.cancelOrder(request.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/orders/:id/amend", async (request) => {
    const input = AmendSchema.parse(request.body);
    await engine.amendOrder(request.params.id, input.newLimitPrice, input.remainingQuantity);
    return { ok: true };
  });

  app.setErrorHandler((error, request, reply) => {
    const isValidation = error instanceof z.ZodError;
    const candidateStatus =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 500;
    const status = isValidation
      ? 400
      : Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
        ? candidateStatus
        : 500;
    const message = isValidation
      ? error.issues[0]?.message ?? "입력값을 확인해 주세요."
      : error instanceof Error
        ? error.message
        : String(error);
    if (status >= 500) request.log.error({ err: error }, "API request failed");
    void reply.code(status).send({
      error: isValidation ? "validation_error" : "request_failed",
      message: status >= 500 ? "요청 처리 중 오류가 발생했습니다." : message,
      ...(isValidation ? { issues: error.issues } : {}),
    });
  });

  return app;
}
