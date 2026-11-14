import fs from "node:fs";
import path from "node:path";

// No account, local paths, or session identifiers are included. These are
// the exact candidate and evidence carried by the two terminal checkpoints.
export const frozenAssertionProvenance = {
  "terminalArtifactSha256": "719e5aaa9485d75822fead4e22447a016a1c6fdde28e5393fc3509e48e3a84df",
  "terminalStateSha256": "1c4ed6117af8acdebbea63b8b72fd582989fe9130125b3d7b9879d69114e6b09",
  "candidateSha256": "a08b0a9e305f9028e50b5b05a558ad09937fd599e0ec074f80a49f1c69915304",
  "policySha256": "15e705d8194aba6770315894468e2625a01a46a6eb32d4884745bbe8ae5d4d1d",
  "goal": {
    "sha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
    "files": [
      {
        "file": "PROJECT.md",
        "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4"
      }
    ]
  },
  "archiveSha256": "17065cd802748d3aac5906c7bdb44790fa8237d78463f06e82a3b65a1d93c305"
};

export const frozenAssertionMaterial = {
  "PROJECT.md": [
    "# 一级总纲 · 地区入组最终说明\n",
    "\n",
    "当前 G2：本轮仅交付 K01 的简明中文说明。GitHub 原始出处和演练登记分开核验。\n",
    "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。为 E1、E2、E3 分别写清处置和原文行号。\n",
    "保留一句有真实计算依据的 [稿件自述]，说明本稿里究竟有多少行带演练登记原文的行号引用；这句只描述稿件本身。文末给一句大白话。\n",
    "制作地区看板动画与地区判断互动测验均取消；单独的入组 FAQ 由本轮已验收的简明说明覆盖；后续原始来源复查保留，当前不执行。\n",
    "\n",
    "## 分块入口\n",
    "\n",
    "- [分块索引](INDEX.md)\n",
  ].join(""),
  "sources/regional-register.md": [
    "# 地区登记演练\n",
    "这是虚构登记，用于核对地区判断；空值没有额外线索。\n",
    "E1 地区：华北。\n",
    "E2 地区：华东。\n",
    "E3 地区：空白。\n",
  ].join(""),
  "sources/github-checks.md": [
    "# 官方页面短摘录\n",
    "URL: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks\n",
    "Fetched: 2026-11-07T13:01:00.140104+00:00\n",
    "下列仅保留原文短句；GitHub 列表仅摘 failure/success 两项，不表示列表只有这两项。\n",
    "摘录：\n",
    "If the status is completed, the conclusion can be any of the following:\n",
    "failure\n",
    "success\n",
  ].join(""),
  "sources/source-checks.json": [
    "{\n",
    "  \"sources\": [\n",
    "    {\n",
    "      \"url\": \"https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks\",\n",
    "      \"finalUrl\": \"https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks\",\n",
    "      \"status\": 200,\n",
    "      \"fetchedAt\": \"2026-11-07T13:01:00.140104+00:00\",\n",
    "      \"responseSha256\": \"2d2229c20d4c1011b18dd1b05caaaa695fa74b31fa588ae6884044c294d2e5af\",\n",
    "      \"snapshot\": \"github-checks.md\",\n",
    "      \"snapshotSha256\": \"1e7041d8d0c377148cb820a487d9b3b3d20005631646d960f147e8176ccb429b\",\n",
    "      \"exactQuotes\": [\n",
    "        \"If the status is completed, the conclusion can be any of the following:\",\n",
    "        \"failure\",\n",
    "        \"success\"\n",
    "      ],\n",
    "      \"limitation\": \"short noncontiguous exact excerpts, not a full-page archive; no live browsing by test agents\"\n",
    "    },\n",
    "    {\n",
    "      \"url\": \"https://www.itl.nist.gov/div898/handbook/eda/section3/scatterp.htm\",\n",
    "      \"finalUrl\": \"https://www.itl.nist.gov/div898/handbook/eda/section3/scatterp.htm\",\n",
    "      \"status\": 200,\n",
    "      \"fetchedAt\": \"2026-11-07T13:01:03.500952+00:00\",\n",
    "      \"responseSha256\": \"37363da3588e9933d092de337b6b3bd7ebd9b04a3ba40ee8f0271786903a2adf\",\n",
    "      \"snapshot\": \"nist-scatter.md\",\n",
    "      \"snapshotSha256\": \"e314eef5a7aa4f898591737b0c1470960bbf19e9a66e916d48cb237c37d7af8a\",\n",
    "      \"exactQuotes\": [\n",
    "        \"association does NOT imply causality.\"\n",
    "      ],\n",
    "      \"limitation\": \"short noncontiguous exact excerpts, not a full-page archive; no live browsing by test agents\"\n",
    "    }\n",
    "  ]\n",
    "}\n",
  ].join(""),
  "modules/eligibility.md": [
    "# 地区入组：简明说明\n",
    "\n",
    "## 一、地区边界与处置规则\n",
    "\n",
    "只纳入华北。登记资料地区字段明确为其他地区时排除；地区字段写着“空白”时属于待补，不能与“排除”混用。注意：本节依据的是演练登记（sources/regional-register.md 第2行自述“这是虚构登记，用于核对地区判断”），因此下列结论只是对演练登记的核对，不是外部真实登记事实。\n",
    "\n",
    "## 二、三项处置\n",
    "\n",
    "[原文摘录] “这是虚构登记，用于核对地区判断；空值没有额外线索。”（出处：sources/regional-register.md 第2行；本文以下均据该演练登记）\n",
    "\n",
    "- C1：E1 的登记原文是“E1 地区：华北。”（sources/regional-register.md 第3行），属华北，处置为纳入。但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。\n",
    "- C2：E2 的登记原文是“E2 地区：华东。”（sources/regional-register.md 第4行），是明确填写了其他地区（华东）而非空白，处置为排除，不是待补。上一稿的“E2 没有填写”与第4行相反，属错例，已作废。\n",
    "- C3：E3 的登记原文是“E3 地区：空白。”（sources/regional-register.md 第5行）地区字段为空白即待补，不是排除，须登记方补充地区信息后才能判定。上一稿曾把这一输出错成 E2（“没有填写”），与第4行相反，该错说已作废。\n",
    "\n",
    "## 三、GitHub 检查状态（与上面地区登记分开）\n",
    "\n",
    "- C4：GitHub 检查套件的 completed 状态可能对应 failure 结论（出处：sources/github-checks.md 第6-7行）：第6行说该状态下结论“可为下列任一”，第7行正是 failure。又因已登记摘录整段只列出 failure（第7行）与 success（第8行）两个值，此处只能写“可能”，不能断定结论只有这两种。此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。\n",
    "\n",
    "## 四、出处与范围\n",
    "\n",
    "- 地区与处置依据：sources/regional-register.md 第2-5行（演练登记，虚构资料，非外部事实）。\n",
    "- GitHub 检查状态依据：sources/github-checks.md 第6-8行（本地短摘录，未联网复核）。\n",
    "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。\n",
    "\n",
    "[稿件自述] 本稿共 6 行带 sources/regional-register.md 的原文行号引用：第5、9、11、12、13、21行。\n",
    "\n",
    "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；E2 写的是华东，明确排除（不是没填）；E3 写的是空白，才需要补填后再判；这些是演练登记里的字，不是真实登记。\n",
  ].join(""),
};

const refs = {
  "policy-4-4": {"file": "PROJECT.md", "start": 4, "end": 4, "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。为 E1、E2、E3 分别写清处置和原文行号。", "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4", "evidenceSpan": "ade22d27426c54f270432df7eef9c1e8cfba33db38caf73e7021457c05b5ce85", "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61", "provenance": "current-project-policy"},
  "demo-2-2": {"file": "sources/regional-register.md", "start": 2, "end": 2, "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "sourceIdentity": "af80c95c252f3b0aca94ef710c933d8ba56c3f292016c3773d4b93bf59d948a8", "provenance": "maintainer-pinned-local-material", "origin": {"kind": "synthetic", "locator": "synthetic:regional-register-eligibility", "integrity": "matches-pin"}, "quote": "这是虚构登记，用于核对地区判断；空值没有额外线索。", "evidenceSpan": "d1df098adef8a60505edea1f3ddfdee09dcfe6f93f683f54b6abe39ab8bf9a9a"},
  "demo-3-3-location": {"file": "sources/regional-register.md", "start": 3, "end": 3, "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "sourceIdentity": "af80c95c252f3b0aca94ef710c933d8ba56c3f292016c3773d4b93bf59d948a8", "provenance": "maintainer-pinned-local-material", "origin": {"kind": "synthetic", "locator": "synthetic:regional-register-eligibility", "integrity": "matches-pin"}},
  "demo-3-3": {"file": "sources/regional-register.md", "start": 3, "end": 3, "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "sourceIdentity": "af80c95c252f3b0aca94ef710c933d8ba56c3f292016c3773d4b93bf59d948a8", "provenance": "maintainer-pinned-local-material", "origin": {"kind": "synthetic", "locator": "synthetic:regional-register-eligibility", "integrity": "matches-pin"}, "quote": "E1 地区：华北。", "evidenceSpan": "c7c4e7b3f802317be3e8756ee174d1b3ad515ae924d3b20c888b8c63be325f46"},
  "policy-3-3": {"file": "PROJECT.md", "start": 3, "end": 3, "quote": "当前 G2：本轮仅交付 K01 的简明中文说明。GitHub 原始出处和演练登记分开核验。", "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4", "evidenceSpan": "821c22e5c2924ba032f199f93447a47e531a1850667995710fbca21d3d8d7525", "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61", "provenance": "current-project-policy"},
  "public-6-6": {"file": "sources/github-checks.md", "start": 6, "end": 6, "sha256": "1e7041d8d0c377148cb820a487d9b3b3d20005631646d960f147e8176ccb429b", "sourceIdentity": "e1f2021d74c8fda97e41ce82ee40cab1fa1c5f7c5091147aafcb1a83a837bf96", "provenance": "maintainer-pinned-acquisition-receipt", "origin": {"kind": "primary", "locator": "https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks", "integrity": "matches-pin", "observation": {"file": "sources/source-checks.json", "sha256": "1056c2bc2f6f44cf135068ad5d39965005eab264ae954645f52417e0f4a473b0", "fetchedAt": "2026-11-07T13:01:00.140104+00:00", "responseSha256": "2d2229c20d4c1011b18dd1b05caaaa695fa74b31fa588ae6884044c294d2e5af"}}, "quote": "If the status is completed, the conclusion can be any of the following:", "evidenceSpan": "bf8307ff98c8c066ba33ca5fbeeaa7ce7c883a17ab4fcaf0b366c1fe913b88fa"},
  "demo-2-5-location": {"file": "sources/regional-register.md", "start": 2, "end": 5, "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "sourceIdentity": "af80c95c252f3b0aca94ef710c933d8ba56c3f292016c3773d4b93bf59d948a8", "provenance": "maintainer-pinned-local-material", "origin": {"kind": "synthetic", "locator": "synthetic:regional-register-eligibility", "integrity": "matches-pin"}},
  "demo-3-5": {"file": "sources/regional-register.md", "start": 3, "end": 5, "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "sourceIdentity": "af80c95c252f3b0aca94ef710c933d8ba56c3f292016c3773d4b93bf59d948a8", "provenance": "maintainer-pinned-local-material", "origin": {"kind": "synthetic", "locator": "synthetic:regional-register-eligibility", "integrity": "matches-pin"}, "quote": "E3 地区：空白。", "evidenceSpan": "4bf0eb3cc9939db195ff74d0507534547e4e01c959911bf570a57a9d3eee12f8"},
  "policy-4-4-07c191ce": {"file": "PROJECT.md", "start": 4, "end": 4, "quote": "地区边界：只纳入华北。", "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4", "evidenceSpan": "744fec922dd478c9bc771ba96e5e0274ec2d1e4642bf5e22007b33ea879fe0f8", "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61", "provenance": "current-project-policy"},
  "public-7-8": {"file": "sources/github-checks.md", "start": 7, "end": 8, "sha256": "1e7041d8d0c377148cb820a487d9b3b3d20005631646d960f147e8176ccb429b", "sourceIdentity": "e1f2021d74c8fda97e41ce82ee40cab1fa1c5f7c5091147aafcb1a83a837bf96", "provenance": "maintainer-pinned-acquisition-receipt", "origin": {"kind": "primary", "locator": "https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks", "integrity": "matches-pin", "observation": {"file": "sources/source-checks.json", "sha256": "1056c2bc2f6f44cf135068ad5d39965005eab264ae954645f52417e0f4a473b0", "fetchedAt": "2026-11-07T13:01:00.140104+00:00", "responseSha256": "2d2229c20d4c1011b18dd1b05caaaa695fa74b31fa588ae6884044c294d2e5af"}}, "quote": "success", "evidenceSpan": "5f55aec882cd3750be8d5522f93cbdc173710dabcd096a1fe3a83f46fcb6e8dc"},
};

const archivedSeen = {
  "project.md": {"hash": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4", "ranges": [[1, 11]]},
  "modules/eligibility.md": {"hash": "a08b0a9e305f9028e50b5b05a558ad09937fd599e0ec074f80a49f1c69915304", "ranges": [[1, 28]]},
  "sources/github-checks.md": {"hash": "1e7041d8d0c377148cb820a487d9b3b3d20005631646d960f147e8176ccb429b", "ranges": [[1, 9]]},
  "sources/regional-register.md": {"hash": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2", "ranges": [[1, 6]]},
};

const archivedRecords = {
  reviewer: [
    {
      block: "B11-0b53ada6", line: 9,
      text: "本文以下均据该演练登记）",
      lineText: "[原文摘录] “这是虚构登记，用于核对地区判断；空值没有额外线索。”（出处：sources/regional-register.md 第2行；本文以下均据该演练登记）",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "本文以下均据该演练登记）", start: 0, end: 12, kind: "inference",
          status: "supported", basis: "第2行自述这是虚构登记、用于核对地区判断，而其后第3-5行正是本稿三项处置所据，故“以下均据该演练登记”成立。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-2-2"],
            scope: "本稿地区处置部分的资料来源",
            assumptions: [],
            counterexample: {"possible": false, "reason": "下列三项处置均引该文件第3-5行。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
    {
      block: "B13-0976446f", line: 11,
      text: "”（sources/regional-register.md 第3行），属华北，处置为纳入。",
      lineText: "- C1：E1 的登记原文是“E1 地区：华北。”（sources/regional-register.md 第3行），属华北，处置为纳入。但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      syntaxSpans: [[2, 34]], syntaxSources: ["demo-3-3-location"],
      parts: [
        {
          quote: "”（sources/regional-register.md 第3行），属华北，", start: 0, end: 40, kind: "direct",
          status: "supported", basis: "行号定位第3行正确，该行确为 E1 地区；“属华北”与原文值一致。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-3"],
        },
        {
          quote: "处置为纳入。", start: 40, end: 46, kind: "inference",
          status: "supported", basis: "总纲第4行“只纳入华北”，E1 登记地区为华北，故处置为纳入。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-3-3"],
            scope: "E1 的入组处置",
            assumptions: [],
            counterexample: {"possible": false, "reason": "登记值华北与只纳入华北直接对应。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
    {
      block: "B14-d9d076df", line: 11,
      text: "但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      lineText: "- C1：E1 的登记原文是“E1 地区：华北。”（sources/regional-register.md 第3行），属华北，处置为纳入。但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。", start: 0, end: 33, kind: "inference",
          status: "supported", basis: "第2行自述虚构，结合总纲仅据可证事实，该条目不得当外部真实地区事实。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-2-2"],
            scope: "E1 的演练登记性质",
            assumptions: [],
            counterexample: {"possible": false, "reason": "来源自述虚构。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
    {
      block: "B24-b26c3f93", line: 17,
      text: "此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。",
      lineText: "- C4：GitHub 检查套件的 completed 状态可能对应 failure 结论（出处：sources/github-checks.md 第6-7行）：第6行说该状态下结论“可为下列任一”，第7行正是 failure。又因已登记摘录整段只列出 failure（第7行）与 success（第8行）两个值，此处只能写“可能”，不能断定结论只有这两种。此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。", start: 0, end: 35, kind: "inference",
          status: "supported", basis: "总纲第3行要求 GitHub 原始出处与演练登记分开核验；已登记的 github-checks.md 摘录属公开材料，而 E1-E3 处置均据演练登记第3-5行，故此条与地区入组无关、不参与处置。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["public-6-6", "demo-3-3"],
            scope: "GitHub 条目的归类及其与三项处置的关系",
            assumptions: [],
            counterexample: {"possible": false, "reason": "两源性质不同，总纲要求分开核验。"},
            policy: ["policy-3-3"],
          },
        },
      ],
    },
    {
      block: "B26-aafcf412", line: 21,
      text: "- 地区与处置依据：sources/regional-register.md 第2-5行（演练登记，虚构资料，非外部事实）。",
      lineText: "- 地区与处置依据：sources/regional-register.md 第2-5行（演练登记，虚构资料，非外部事实）。",
      syntaxSpans: [[0, 2], [9, 44]], syntaxSources: ["demo-2-5-location"],
      parts: [
        {
          quote: "- 地区与处置依据：sources/regional-register.md 第2-5行", start: 0, end: 44, kind: "direct",
          status: "supported", basis: "“地区与处置依据”行号范围第2-5行开头正确：regional-register.md 第2行为虚构声明、第3-5行为 E1/E2/E3 字段值，均在标引范围内。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "（演练登记，虚构资料，非外部事实）。", start: 44, end: 62, kind: "inference",
          status: "supported", basis: "第2行自述虚构，结合总纲仅据可证事实，推出该资料为演练登记、虚构资料、非外部事实。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-2-2"],
            scope: "regional-register.md 的资料性质",
            assumptions: [],
            counterexample: {"possible": false, "reason": "来源自述虚构。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
    {
      block: "B28-21175c53", line: 23,
      text: "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。",
      lineText: "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。",
      syntaxSpans: [[0, 2]], syntaxSources: [],
      parts: [
        {
          quote: "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。", start: 0, end: 39, kind: "inference",
          status: "supported", basis: "前者为第2行自述虚构的演练登记，后者为已登记 的 GitHub 文档页摘录；结合总纲第3行“分开核验”，推出两者性质不同、不互相补足、不混用。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-2-2", "public-6-6"],
            scope: "本稿两类材料的性质与关系",
            assumptions: [],
            counterexample: {"possible": false, "reason": "一为虚构演练、一为公开页摘录，总纲要求分开核验。"},
            policy: ["policy-3-3"],
          },
        },
      ],
    },
    {
      block: "B30-c04b41bb", line: 27,
      text: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；",
      lineText: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；E2 写的是华东，明确排除（不是没填）；E3 写的是空白，才需要补填后再判；这些是演练登记里的字，不是真实登记。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "大白话：", start: 0, end: 4, kind: "nonfactual",
          status: "supported", basis: "“大白话：”是宿主识别的读者提示标签（字符0-4），无事实主张。",
        },
        {
          quote: "这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；", start: 4, end: 35, kind: "inference",
          status: "supported", basis: "总纲第4行以登记资料的地区字段为准、只纳入华北；E1 登记为华北，故纳入。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-3-3"],
            scope: "E1 的处置与判断依据",
            assumptions: [],
            counterexample: {"possible": false, "reason": "登记值华北与只纳入华北直接对应。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
    {
      block: "B33-dc3d061f", line: 27,
      text: "这些是演练登记里的字，不是真实登记。",
      lineText: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；E2 写的是华东，明确排除（不是没填）；E3 写的是空白，才需要补填后再判；这些是演练登记里的字，不是真实登记。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "这些是演练登记里的字，不是真实登记。", start: 0, end: 18, kind: "inference",
          status: "supported", basis: "regional-register.md 第2行自述“这是虚构登记”，故其字句不是真实登记内容，与末句一致。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-2-2"],
            scope: "登记字段值的资料性质",
            assumptions: [],
            counterexample: {"possible": false, "reason": "来源自述虚构。"},
            policy: ["policy-4-4"],
          },
        },
      ],
    },
  ],
  auditor: [
    {
      block: "B11-0b53ada6", line: 9,
      text: "本文以下均据该演练登记）",
      lineText: "[原文摘录] “这是虚构登记，用于核对地区判断；空值没有额外线索。”（出处：sources/regional-register.md 第2行；本文以下均据该演练登记）",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "本文以下均据该演练登记）", start: 0, end: 12, kind: "direct",
          status: "supported", basis: "本句为出处声明句式的后半。按字面“本文以下”指注以降地区处置内容：紧随的 C1–C3（第11–13行）确实均据该登记（第3、4、5行）；而第15行标题明写“与上面地区登记分开”、第17行自述 C4 属公开材料摘录、第23行声明两类材料不混用，已给后者明确分节隔断，故声明与后文不矛盾。范围内无反例使“以下据该登记”为假。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2", "demo-3-5"],
        },
      ],
    },
    {
      block: "B13-0976446f", line: 11,
      text: "”（sources/regional-register.md 第3行），属华北，处置为纳入。",
      lineText: "- C1：E1 的登记原文是“E1 地区：华北。”（sources/regional-register.md 第3行），属华北，处置为纳入。但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      syntaxSpans: [[2, 34]], syntaxSources: ["demo-3-3-location"],
      parts: [
        {
          quote: "”（sources/regional-register.md 第3行）", start: 0, end: 35, kind: "direct",
          status: "supported", basis: "出处标注正确：第3行确为“E1 地区：华北。”。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-3"],
        },
        {
          quote: "，属华北，处置为纳入。", start: 35, end: 46, kind: "inference",
          status: "supported", basis: "前提：第3行字段值为“华北”；总纲第4行规定“只纳入华北”。两者推得 E1 属华北、处置为纳入。反例检验：未将“华北”扩展到其他地区，也未遗漏条件；规则为“华北→纳入”，前提正是华北，方向未倒置，无反例。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-3-3"],
            scope: "E1 记录，地区字段值=华北",
            assumptions: [],
            counterexample: {"possible": false, "reason": "字段值逐字为华北，规则明确只纳入华北，推不出其他处置。"},
            policy: ["policy-4-4-07c191ce"],
          },
        },
      ],
    },
    {
      block: "B14-d9d076df", line: 11,
      text: "但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      lineText: "- C1：E1 的登记原文是“E1 地区：华北。”（sources/regional-register.md 第3行），属华北，处置为纳入。但这是演练登记，不能当作外部真实地区事实（见下文“出处与范围”）。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "但这是演练登记，", start: 0, end: 8, kind: "direct",
          status: "supported", basis: "“但这是演练登记”与第2行自述相符。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "不能当作外部真实地区事实", start: 8, end: 20, kind: "direct",
          status: "supported", basis: "“不能当作外部真实地区事实”由第2行“这是虚构登记”直接支持；登记自述虚构即非外部真实事实。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "（见下文“出处与范围”）。", start: 20, end: 33, kind: "direct",
          status: "supported", basis: "括注为交叉引用：“出处与范围”小节确实存在（本文第19–23行），且其中第21行也重申该登记为虚构资料、非外部事实，指向有效。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
      ],
    },
    {
      block: "B24-b26c3f93", line: 17,
      text: "此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。",
      lineText: "- C4：GitHub 检查套件的 completed 状态可能对应 failure 结论（出处：sources/github-checks.md 第6-7行）：第6行说该状态下结论“可为下列任一”，第7行正是 failure。又因已登记摘录整段只列出 failure（第7行）与 success（第8行）两个值，此处只能写“可能”，不能断定结论只有这两种。此条属公开材料摘录，与地区入组无关，不参与 E1、E2、E3 的处置。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "此条属公开材料摘录，", start: 0, end: 10, kind: "direct",
          status: "supported", basis: "“此条属公开材料摘录”：C4 引自 github-checks.md，该文件第1行标题为“官方页面短摘录”、并附官方 URL 与抓取时间，属公开材料摘录。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["public-6-6"],
        },
        {
          quote: "与地区入组无关，", start: 10, end: 18, kind: "direct",
          status: "supported", basis: "“与地区入组无关”：C4 内容为 GitHub 检查套件状态与结论取值，与地区字段无概念交集；总纲第3行亦要求两者分开核验。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["public-7-8"],
        },
        {
          quote: "不参与 E1、E2、E3 的处置。", start: 18, end: 35, kind: "direct",
          status: "supported", basis: "“不参与 E1、E2、E3 的处置”：本稿第11–13行 E1–E3 处置均只据 regional-register.md 第3–5行，未引 github-checks.md，故 E1–E3 判定不依赖 C4。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-5"],
        },
      ],
    },
    {
      block: "B26-aafcf412", line: 21,
      text: "- 地区与处置依据：sources/regional-register.md 第2-5行（演练登记，虚构资料，非外部事实）。",
      lineText: "- 地区与处置依据：sources/regional-register.md 第2-5行（演练登记，虚构资料，非外部事实）。",
      syntaxSpans: [[0, 2], [9, 44]], syntaxSources: ["demo-2-5-location"],
      parts: [
        {
          quote: "- 地区与处置依据：sources/regional-register.md 第2-5行", start: 0, end: 44, kind: "direct",
          status: "supported", basis: "“地区与处置依据”标签行：所列出处 regional-register.md 确为 C1–C3 与第5行规则的来源。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-5"],
        },
        {
          quote: "（演练登记，", start: 44, end: 50, kind: "direct",
          status: "supported", basis: "“演练登记”：第2行明写“这是虚构登记，用于核对地区判断”，属演练用途登记。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "虚构资料，", start: 50, end: 55, kind: "direct",
          status: "supported", basis: "“虚构资料”：第2行自述“这是虚构登记”，直接支持。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "非外部事实）。", start: 55, end: 62, kind: "direct",
          status: "supported", basis: "“非外部事实”：由虚构自述可得该资料不是外部真实事实来源，与总纲第3行分开核验要求一致。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
      ],
    },
    {
      block: "B28-21175c53", line: 23,
      text: "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。",
      lineText: "- 两类材料性质不同：前者是演练登记，后者是公开材料摘录，不互相补足、不混用。",
      syntaxSpans: [[0, 2]], syntaxSources: [],
      parts: [
        {
          quote: "- 两类材料性质不同：", start: 0, end: 11, kind: "direct",
          status: "supported", basis: "“两类材料性质不同”标签句，后文给出具体区分。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2", "public-6-6"],
        },
        {
          quote: "前者是演练登记，", start: 11, end: 19, kind: "direct",
          status: "supported", basis: "“前者是演练登记”：前者指第21行所列的 regional-register.md，其第2行自述为虚构演练登记。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
        {
          quote: "后者是公开材料摘录，", start: 19, end: 29, kind: "direct",
          status: "supported", basis: "“后者是公开材料摘录”：后者指第22行所列 github-checks.md，其标题为“官方页面短摘录”并附官方 URL 与抓取时间。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["public-6-6"],
        },
        {
          quote: "不互相补足、不混用。", start: 29, end: 39, kind: "direct",
          status: "supported", basis: "“不互相补足、不混用”：总纲第3行要求“GitHub 原始出处和演练登记分开核验”，且本稿各条只引对应来源——C1–C3 只引登记，C4 只引 GitHub 摘录，范围内无反例。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-5", "public-7-8"],
        },
      ],
    },
    {
      block: "B30-c04b41bb", line: 27,
      text: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；",
      lineText: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；E2 写的是华东，明确排除（不是没填）；E3 写的是空白，才需要补填后再判；这些是演练登记里的字，不是真实登记。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "大白话：", start: 0, end: 4, kind: "nonfactual",
          status: "supported", basis: "“大白话：”为阅读标签（neutralSpan），不引入外部事实。",
        },
        {
          quote: "这次只按登记资料写的地区字段判断——", start: 4, end: 22, kind: "direct",
          status: "supported", basis: "“这次只按登记资料写的地区字段判断”：本稿 C1–C3 的判据均为登记第3–5行的地区字段值，未用其他信息；总纲第4行也只按地区字段定处置。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-5"],
        },
        {
          quote: "E1 写的是华北，", start: 22, end: 31, kind: "direct",
          status: "supported", basis: "“E1 写的是华北”：第3行逐字为“E1 地区：华北。”。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-3"],
        },
        {
          quote: "就纳入；", start: 31, end: 35, kind: "inference",
          status: "supported", basis: "前提：E1 字段值为华北；总纲第4行“只纳入华北”。推得“就纳入”。反例检验：字段值逐字为华北，规则明确，无反例。",
          sourceRelation: "supports",
          proofObject: "project-policy",
          inference: {
            rule: "project-policy",
            premises: ["demo-3-3"],
            scope: "E1 记录，地区字段值=华北",
            assumptions: [],
            counterexample: {"possible": false, "reason": "字段值为华北且规则只纳入华北，推不出其他处置。"},
            policy: ["policy-4-4-07c191ce"],
          },
        },
      ],
    },
    {
      block: "B33-dc3d061f", line: 27,
      text: "这些是演练登记里的字，不是真实登记。",
      lineText: "大白话：这次只按登记资料写的地区字段判断——E1 写的是华北，就纳入；E2 写的是华东，明确排除（不是没填）；E3 写的是空白，才需要补填后再判；这些是演练登记里的字，不是真实登记。",
      syntaxSpans: [], syntaxSources: [],
      parts: [
        {
          quote: "这些是演练登记里的字，", start: 0, end: 11, kind: "direct",
          status: "supported", basis: "“这些是演练登记里的字”：所指 E1–E3 字段值逐字来自第3–5行；且第2行自述这是虚构登记的演练用途。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-3-5"],
        },
        {
          quote: "不是真实登记。", start: 11, end: 18, kind: "direct",
          status: "supported", basis: "“不是真实登记”：第2行自述“这是虚构登记”，直接支持。",
          sourceRelation: "supports",
          proofObject: "external",
          evidence: ["demo-2-2"],
        },
      ],
    },
  ],
};

const policy = {
  "spec": "building-loop/1",
  "instructions": [
    "AGENTS.md"
  ],
  "goalContext": [
    "PROJECT.md"
  ],
  "ledgerContext": [
    "PROJECT.md"
  ],
  "ledgerDocument": "LEDGER.md",
  "coordinator": {
    "read": [
      "AGENTS.md",
      "PROJECT.md",
      "INDEX.md",
      "modules/summary.md",
      "LEDGER.md",
      "records/first.json",
      "records/final.json"
    ],
    "write": [
      "LEDGER.md",
      "modules/summary.md"
    ]
  },
  "hierarchy": {
    "overview": {
      "path": "PROJECT.md",
      "heading": "分块入口"
    },
    "index": {
      "path": "INDEX.md",
      "heading": "模块正文"
    },
    "modules": {
      "eligibility": "modules/summary.md"
    }
  },
  "sourcePins": {
    "sources/github-checks.md": {
      "sha256": "1e7041d8d0c377148cb820a487d9b3b3d20005631646d960f147e8176ccb429b",
      "kind": "primary",
      "locator": "https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks",
      "observation": {
        "file": "sources/source-checks.json",
        "sha256": "1056c2bc2f6f44cf135068ad5d39965005eab264ae954645f52417e0f4a473b0"
      }
    },
    "sources/regional-register.md": {
      "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
      "kind": "synthetic",
      "locator": "synthetic:regional-register-eligibility"
    }
  },
  "units": {
    "K01": {
      "candidate": "modules/eligibility.md",
      "claims": [
        "C1",
        "C2",
        "C3",
        "C4"
      ],
      "continuation": "reuse",
      "requireSourcePins": true,
      "covers": [
        "extra-faq"
      ],
      "phases": {
        "intake": {
          "read": [
            "modules/eligibility.md"
          ]
        },
        "first-review": {
          "read": [
            "modules/eligibility.md",
            "sources/github-checks.md",
            "sources/regional-register.md"
          ],
          "evidence": [
            "sources/github-checks.md",
            "sources/regional-register.md"
          ],
          "receipt": "records/first.json"
        },
        "supplement": {
          "read": [
            "modules/eligibility.md",
            "sources/github-checks.md",
            "sources/regional-register.md",
            "records/first.json",
            "records/final.json"
          ],
          "write": [
            "modules/eligibility.md"
          ]
        },
        "final-review": {
          "read": [
            "modules/eligibility.md",
            "sources/github-checks.md",
            "sources/regional-register.md"
          ],
          "evidence": [
            "sources/github-checks.md",
            "sources/regional-register.md"
          ],
          "receipt": "records/final.json"
        }
      }
    }
  }
};

const ancillaryFiles = {
  "AGENTS.md": "# 范围\n\n维护者最新目标为 PROJECT.md。核验只据已授权原文，标明演练和公开材料。使用宿主阶段工具。\n",
  "INDEX.md": "# 二级索引\n\n## 模块正文\n\n- [地区入组说明](modules/summary.md)\n",
  "modules/summary.md": "# 地区入组模块\n\n- [待核验交付](eligibility.md)\n",
};

export function installFrozenAssertionFixture(root) {
  const files = { ...frozenAssertionMaterial, ...ancillaryFiles, "BUILDING-LOOP.json": JSON.stringify(policy, null, 2) + "\n" };
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, "utf8");
  }
  return structuredClone(policy);
}

export function frozenAssertionReference(key) {
  const { file, start, end, quote } = refs[key];
  return { file, start, end, ...(quote === undefined ? {} : { quote }) };
}

export function frozenAssertionRoles() {
  const saved = structuredClone(archivedRecords);
  for (const key of ["reviewer", "auditor"]) {
    for (const record of saved[key]) {
      record.syntaxSources = record.syntaxSources.map(id => structuredClone(refs[id]));
      for (const part of record.parts) {
        if (part.evidence) part.evidence = part.evidence.map(id => structuredClone(refs[id]));
        if (part.inference) {
          part.inference.policy = part.inference.policy.map(id => structuredClone(refs[id]));
          part.inference.premises = part.inference.premises.map(id => structuredClone(refs[id]));
        }
      }
    }
    saved[key] = {
      candidateSha256: frozenAssertionProvenance.candidateSha256,
      goalSha256: frozenAssertionProvenance.goal.sha256,
      seen: structuredClone(archivedSeen),
      records: saved[key],
      pending: [],
      rejected: [],
      quotations: [],
    };
  }
  return saved;
}

// Independent adjudication of the archived text. Exact fragments preserve the
// author's byte ranges, while arrays list the evidence a fresh role must bind.
// Explicit negative controls keep adequate siblings and remove one obligation.
const original = (quote, references) => ({ quote, assertion: "original-fact", references });
const identity = (quote, references) => ({ quote, assertion: "material-identity", references });
const rule = (quote, policy) => ({ quote, assertion: "project-rule", policy });
const application = (quote, references, policy) => ({ quote, assertion: "project-application", references, policy });
const manuscript = (quote, references, manuscriptLines) => ({
  quote, assertion: "manuscript-attribution", references, manuscriptLines,
});

export const frozenAssertionCases = [
  {
    block: "B11-0b53ada6",
    diagnosis: "The source declares its own identity. Only the candidate can establish which subsequent section uses it.",
    atoms: [manuscript("本文以下均据该演练登记）", ["demo-2-2", "demo-3-5"], [11, 13])],
    negatives: [
      { atom: 0, omit: "manuscriptLines", reason: "The registration cannot attest to usage in the manuscript." },
      { atom: 0, manuscriptLines: [9, 17], reason: "The unbounded reading wrongly includes the separate public-source section." },
    ],
  },
  {
    block: "B13-0976446f",
    diagnosis: "Both roles already cited the same exact regional row and current project rule, with different span boundaries.",
    prefix: "”（sources/regional-register.md 第3行），",
    atoms: [
      original("属华北，", ["demo-3-3"]),
      application("处置为纳入。", ["demo-3-3"], ["policy-4-4"]),
    ],
    negatives: [
      { atom: 1, omit: "policy", reason: "A known region alone cannot authorize inclusion." },
      { atom: 1, omit: "references", reason: "A current rule alone establishes eligibility criteria, not this record's region." },
    ],
  },
  {
    block: "B14-d9d076df",
    diagnosis: "The source's designation and its real-world limit follow from the pinned synthetic declaration. The final phrase is a manuscript cross-reference.",
    atoms: [
      identity("但这是演练登记，", ["demo-2-2"]),
      identity("不能当作外部真实地区事实", ["demo-2-2"]),
      { quote: "（见下文“出处与范围”）。", navigationHeading: { line: 19, text: "## 四、出处与范围" } },
    ],
    negatives: [
      { atom: 1, omit: "references", reason: "A project rule cannot itself authenticate which source is synthetic." },
    ],
  },
  {
    block: "B24-b26c3f93",
    diagnosis: "The auditor independently established the excerpt's identity. Its exclusion from project decisions still needs the current rule.",
    atoms: [
      identity("此条属公开材料摘录，", ["public-6-6"]),
      application("与地区入组无关，", ["public-6-6", "demo-2-2"], ["policy-3-3"]),
      application("不参与 E1、E2、E3 的处置。", ["public-6-6", "demo-3-5"], ["policy-3-3"]),
    ],
    negatives: [
      // This repeats the actual omission in the terminal independent proof.
      { atom: 2, omit: "policy", reason: "Neither the GitHub excerpt nor the registration establishes the project's decision scope." },
    ],
  },
  {
    block: "B26-aafcf412",
    diagnosis: "The opening locator identifies the basis in the manuscript. The remaining clauses refer to the same pinned synthetic material.",
    atoms: [
      original("- 地区与处置依据：sources/regional-register.md 第2-5行", ["demo-2-2", "demo-3-5"]),
      identity("（演练登记，", ["demo-2-2"]),
      identity("虚构资料，", ["demo-2-2"]),
      identity("非外部事实）。", ["demo-2-2"]),
    ],
    negatives: [
      { atom: 2, references: ["public-6-6"], reason: "A different source cannot prove this registration's identity." },
    ],
  },
  {
    block: "B28-21175c53",
    diagnosis: "Both artifacts establish their own source types. Only the project owner specifies how to use the two classes.",
    atoms: [
      identity("- 两类材料性质不同：", ["demo-2-2", "public-6-6"]),
      identity("前者是演练登记，", ["demo-2-2"]),
      identity("后者是公开材料摘录，", ["public-6-6"]),
      rule("不互相补足、不混用。", ["policy-3-3"]),
    ],
    negatives: [
      { atom: 3, omit: "policy", reason: "Both materials remain independently credible, but neither establishes project separation." },
      { atom: 3, policy: ["policy-4-4"], reason: "The current region rule is a valid quote and still does not establish separation." },
    ],
  },
  {
    block: "B30-c04b41bb",
    diagnosis: "The actual field value and the policy-based disposition have independent proofs. The opening method statement also needs its own binding to the current rule.",
    prefix: "大白话：",
    atoms: [
      rule("这次只按登记资料写的地区字段判断——", ["policy-4-4"]),
      original("E1 写的是华北，", ["demo-3-3"]),
      application("就纳入；", ["demo-3-3"], ["policy-4-4"]),
    ],
    negatives: [
      { atom: 0, omit: "policy", reason: "A rule attached only to the adjacent decision does not prove the preceding method statement." },
      { atom: 1, references: ["demo-3-5"], reason: "This archived reference quotes E3's blank field, even though its line range includes E1." },
    ],
  },
  {
    block: "B33-dc3d061f",
    diagnosis: "Existing words must bind to their actual source rows. That source's synthetic status independently comes from the same pinned registration.",
    atoms: [
      original("这些是演练登记里的字，", ["demo-3-5"]),
      identity("不是真实登记。", ["demo-2-2"]),
    ],
    negatives: [
      { atom: 1, omit: "references", reason: "Raw values are insufficient to show that the source is a simulation." },
    ],
  },
];
