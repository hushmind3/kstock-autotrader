import { confirm, input, password, select } from "@inquirer/prompts";
import type { BrokerCredentials, BrokerId, TradingEnvironment } from "@kstock/shared";
import { CredentialStore } from "./security/credential-store.js";

async function collectCredentials(
  brokerId: BrokerId,
  environment: TradingEnvironment,
): Promise<BrokerCredentials> {
  const appKey = await password({ message: "App Key", mask: "*", validate: (value) => value.length > 0 });
  const appSecret = await password({
    message: brokerId === "kiwoom" ? "Secret Key" : "App Secret",
    mask: "*",
    validate: (value) => value.length > 0,
  });
  const accountId = await input({
    message: "계좌번호 (문자열 그대로, 하이픈 허용)",
    validate: (value) => value.trim().length > 0,
  });
  if (brokerId === "koreainvestment") {
    const accountProductCode = await input({
      message: "계좌 상품코드",
      default: "01",
      validate: (value) => value.trim().length > 0,
    });
    const htsId = await input({
      message: "HTS 사용자 ID (실시간 주문·체결 통보용)",
      validate: (value) => value.trim().length > 0,
    });
    return { appKey, appSecret, accountId: accountId.trim(), accountProductCode: accountProductCode.trim(), htsId: htsId.trim() };
  }
  return { appKey, appSecret, accountId: accountId.trim() };
}

async function main(): Promise<void> {
  const store = new CredentialStore();
  console.log("\nK-Stock 보안 자격증명 설정");
  console.log("입력값은 브라우저나 SQLite가 아닌 운영체제 보안 저장소에 저장됩니다.\n");
  let again = true;
  while (again) {
    const brokerId = await select<BrokerId>({
      message: "증권사",
      choices: [
        { name: "키움증권", value: "kiwoom" },
        { name: "한국투자증권", value: "koreainvestment" },
      ],
    });
    const environment = await select<TradingEnvironment>({
      message: "계좌 환경",
      choices: [
        { name: "모의투자 (권장)", value: "paper" },
        { name: "실전투자", value: "live" },
      ],
    });
    const credentials = await collectCredentials(brokerId, environment);
    await store.save(brokerId, environment, credentials);
    console.log(`\n저장 완료: ${brokerId} / ${environment}\n`);
    again = await confirm({ message: "다른 증권사 또는 환경도 설정할까요?", default: false });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
