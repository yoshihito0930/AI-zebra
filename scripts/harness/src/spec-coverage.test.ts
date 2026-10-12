import { describe, expect, it } from "vitest";
import {
  evaluateCoverage,
  extractDescribeNames,
  extractExampleSections,
  parsePendingList,
} from "./spec-coverage.ts";

describe("例の見出しから節の名前を取り出す", () => {
  it("「例」の親（1つ上の階層の見出し）が節の名前になる", () => {
    const md = ["# 仕様", "## 申込の締め切り", "本文", "### 例", "| a | b |"].join("\n");
    expect(extractExampleSections(md)).toEqual(["申込の締め切り"]);
  });

  it("同じ階層の見出しがあいだにあっても、親を節の名前にする（「料金」の節の形）", () => {
    const md = ["# 仕様", "## 料金", "### 単価", "### 計算", "### 例"].join("\n");
    expect(extractExampleSections(md)).toEqual(["料金"]);
  });

  it("#### 例 は、その親の ### 見出しを節の名前にする", () => {
    const md = ["# 仕様", "## 空き判定", "### バッファを30分に縮める", "#### 例", "### 例"].join(
      "\n",
    );
    expect(extractExampleSections(md)).toEqual(["バッファを30分に縮める", "空き判定"]);
  });

  it("コードブロックの中の見出しは数えない", () => {
    const md = ["# 仕様", "## 節", "```md", "## 偽物", "### 例", "```"].join("\n");
    expect(extractExampleSections(md)).toEqual([]);
  });

  it("「例」で始まるだけの見出し（「例外」など）は数えない", () => {
    const md = ["# 仕様", "## 節", "### 例外の扱い"].join("\n");
    expect(extractExampleSections(md)).toEqual([]);
  });
});

describe("テストから describe の名前を取り出す", () => {
  it("引用符の種類によらず、最初の引数の文字列を取り出す", () => {
    const src = [
      'describe("申込の締め切り", () => {});',
      "describe('料金', () => {});",
      "describe.each([1])(`予約の変更`, () => {});",
      'describe.skip("第二キープ", () => {});',
    ].join("\n");
    expect(extractDescribeNames(src)).toEqual(["申込の締め切り", "料金", "第二キープ"]);
  });
});

describe("保留リストを読む", () => {
  it("空行と # で始まる行を無視する", () => {
    expect(parsePendingList("# コメント\n\n料金\n  予約の変更  \n")).toEqual([
      "料金",
      "予約の変更",
    ]);
  });
});

describe("節ごとにテストと保留リストを照らし合わせる", () => {
  const sections = ["申込の締め切り"];

  it("テストがあり、保留リストにない → 成功", () => {
    expect(evaluateCoverage({ sections, describeNames: ["申込の締め切り"], pending: [] })).toEqual(
      [],
    );
  });

  it("テストがなく、保留リストにある → 成功（保留中）", () => {
    expect(evaluateCoverage({ sections, describeNames: [], pending: ["申込の締め切り"] })).toEqual(
      [],
    );
  });

  it("テストがなく、保留リストにもない → 失敗", () => {
    expect(evaluateCoverage({ sections, describeNames: [], pending: [] })).toEqual([
      { kind: "missing", section: "申込の締め切り" },
    ]);
  });

  it("テストがあるのに、保留リストにも残っている → 失敗（保留リストから消す）", () => {
    expect(
      evaluateCoverage({
        sections,
        describeNames: ["申込の締め切り"],
        pending: ["申込の締め切り"],
      }),
    ).toEqual([{ kind: "covered-but-pending", section: "申込の締め切り" }]);
  });

  it("仕様に新しい節の例を足したが、テストも保留リストの記載もない → 失敗", () => {
    expect(
      evaluateCoverage({
        sections: ["申込の締め切り", "予約の変更"],
        describeNames: ["申込の締め切り"],
        pending: [],
      }),
    ).toEqual([{ kind: "missing", section: "予約の変更" }]);
  });

  it("保留リストに、仕様に存在しない節がある → 失敗（保留リストから消す）", () => {
    expect(
      evaluateCoverage({ sections, describeNames: ["申込の締め切り"], pending: ["消えた節"] }),
    ).toEqual([{ kind: "unknown-pending", section: "消えた節" }]);
  });
});
