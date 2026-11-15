const objectExamples = {
  excerptCount: { kind: "registered-excerpts", check: "count", file: "原句明确写出的来源路径", expected: 1 },
  citingLineCount: { kind: "candidate", check: "citation-count", source: "原句所说的被引用来源", expected: 6 },
  note: "以原句的实际数量和范围为准。有 objectCheckHint 时按本块提示提交，其中 expected 也须相符。已登记摘录不等于网页全文，稿件统计须核当前稿，外部出处不能代证。",
};

/** Attach directions to the visible inventory page, including explicit continuation pages. */
export function coveragePageGuidance(blocks = []) {
  if (!blocks.length) return {};
  return {
    ...(blocks.some(block => block.neutralSpans?.length) ? {
      neutralSpanRule: "只在 neutralSpans 所示范围用 nonfactual + supported + basis。保留逐字覆盖；标签后的数量、条件、事实和推导照常核。",
    } : {}),
    ...(blocks.some(block => /^\s*\[模拟\]/u.test(block.text)) ? {
      simulationRule: "[模拟] 是实际来源范围声明，须用 direct 及已读的模拟原文或对应合成来源凭据。余下断言分别举证。",
    } : {}),
    ...(blocks.some(block => /\[\^[^\]\s]+\]/u.test(block.text)) ? {
      footnoteRule: "逐字引句紧接脚注时，核同名定义和它指向的已读原文。相邻其他出处不能替该脚注证明。脚注定义之后的事实照常核。",
    } : {}),
    ...(blocks.some(block => block.inferenceHint) ? {
      nonEntailmentRule: "区分前提推不出 P 和前提证实非 P。有 inferenceHint 时按该连续原句提交 inference 判定、sourceRelation 与依据，宿主将按提示的有界规则复算。",
    } : {}),
    ...(blocks.some(block => block.stance === "error-example") ? {
      errorExampleRule: "仅原文明示的错例用 error-example，核示例推理为 contradicts 或 insufficient，附所需反证或不足依据。错例不得作为已证前提。",
    } : {}),
    ...(blocks.some(block => block.objectCheckHint || /\[(?:摘录范围|稿件自述)\]/u.test(block.text))
      ? { objectCheckExamples: objectExamples } : {}),
  };
}
