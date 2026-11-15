import { describe, expect, it } from "vitest";
import { fakeClipboard } from "./test-support.ts";

const content = {
  html: '架空 花子様<br><span style="color:#ff0000">赤字</span>',
  text: "架空 花子様\n赤字",
};

describe("クリップボードへのコピー", () => {
  it("本文：HTML（text/html）とテキスト（text/plain）の両方を、1つの ClipboardItem にして入れる", async () => {
    const { copier, write, writeText, written } = fakeClipboard("rich");
    expect(await copier.copyRich(content)).toBe("rich");
    expect(write).toHaveBeenCalledTimes(1);
    expect(await written()).toEqual([
      {
        "text/html": ["text/html", content.html],
        "text/plain": ["text/plain", content.text],
      },
    ]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("本文：ClipboardItem がない環境では、テキストだけを入れる", async () => {
    const { copier, write, writeText } = fakeClipboard("no-clipboard-item");
    expect(await copier.copyRich(content)).toBe("text-only");
    expect(write).not.toHaveBeenCalled();
    expect(writeText.mock.calls).toEqual([[content.text]]);
  });

  it("本文：HTML を入れられなかったら（write が失敗）、テキストだけを入れる", async () => {
    const { copier, writeText } = fakeClipboard("write-rejects");
    expect(await copier.copyRich(content)).toBe("text-only");
    expect(writeText.mock.calls).toEqual([[content.text]]);
  });

  it("本文：クリップボードがない環境では、何も入れられない", async () => {
    const { copier } = fakeClipboard("none");
    expect(await copier.copyRich(content)).toBe("failed");
  });

  it("件名・あて先：テキストだけを入れる。入れられなければ false", async () => {
    const rich = fakeClipboard("rich");
    expect(await rich.copier.copyText("hanako@example.com")).toBe(true);
    expect(rich.writeText.mock.calls).toEqual([["hanako@example.com"]]);
    expect(rich.write).not.toHaveBeenCalled();

    const rejecting = fakeClipboard("rich");
    rejecting.writeText.mockRejectedValueOnce(new DOMException("書けない", "NotAllowedError"));
    expect(await rejecting.copier.copyText("件名")).toBe(false);

    expect(await fakeClipboard("none").copier.copyText("件名")).toBe(false);
  });
});
