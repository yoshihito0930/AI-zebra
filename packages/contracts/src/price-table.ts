// 料金表（docs/product-specs/booking.md「料金」の「料金表」）。プランや単価を変える可能性が高いので、
// 料金の計算とプランの決め方はこのデータを受け取って計算する。管理画面で変えられるようにするときも、この形で読み書きする。
// ホリゾントは英語の cyclorama（撮影スタジオの背景の壁）と呼ぶ。
import { z } from "zod";
import { Yen } from "./money.ts";

const Id = z.string().min(1);

/** プラン。単価は税抜の30分あたり。時間帯は通常帯・深夜帯（booking.md「用語」） */
const Plan = z.object({
  id: Id,
  name: z.string().min(1),
  halfHourRates: z.object({ normal: Yen, lateNight: Yen }),
});

/**
 * プランを決める規則。上から順に見て、書いてある条件をすべて満たす最初の規則のプランになる。
 * 条件を書かない規則は、どの申込にも当てはまる（最後の規則は条件なしにして、必ずどれかのプランになるようにする）。
 * - maxPartySize：人数がこれ以下
 * - cycloramaFloorProtection：ホリゾントの床面を全面養生する
 */
const PlanRule = z.object({
  plan: Id,
  maxPartySize: z.number().int().positive().optional(),
  cycloramaFloorProtection: z.literal(true).optional(),
});

/** オプション。税抜で、1予約につき1回 */
const Option = z.object({
  id: Id,
  name: z.string().min(1),
  price: Yen,
});

export const PriceTable = z
  .object({
    plans: z.array(Plan).min(1),
    planRules: z.array(PlanRule).min(1),
    /** 機材保険（税抜、1予約につき1回） */
    equipmentInsurance: Yen,
    options: z.array(Option),
  })
  .superRefine((table, ctx) => {
    const planIds = table.plans.map((plan) => plan.id);
    if (new Set(planIds).size !== planIds.length) {
      ctx.addIssue({ code: "custom", path: ["plans"], message: "プランの id が重なっている" });
    }
    const optionIds = table.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "オプションの id が重なっている",
      });
    }
    table.planRules.forEach((rule, index) => {
      if (!planIds.includes(rule.plan)) {
        ctx.addIssue({
          code: "custom",
          path: ["planRules", index, "plan"],
          message: "規則が、料金表にないプランを指している",
        });
      }
    });
    const last = table.planRules.at(-1);
    if (
      last !== undefined &&
      (last.maxPartySize !== undefined || last.cycloramaFloorProtection !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["planRules", table.planRules.length - 1],
        message: "最後の規則は条件なしにする（どの申込もどれかのプランになるように）",
      });
    }
  });
export type PriceTable = z.infer<typeof PriceTable>;
