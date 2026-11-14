// Verify the false acceptance on the exact native .34 final candidate and both role records.
import { frozenAssertionMaterial } from "./assertion-reconciliation.mjs";

export const archivedDeliveryAcceptance = {
  "archiveSha256": "f590af10fb6c200f5c47bda5d796bc15d955102ce8bc111f8b23da0ab65fb6e5",
  "terminalStateSha256": "b1a1b7e839931810ba804d216c24f79b382fc226a7c379c01e7e0da0298d8f2a",
  "receiptSha256": "b81fdc1edd0f85d5ac1ba905a8f182763784ee2b0312b35116e716d25a390f37",
  "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
  "goalFileSha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
  "sourceSha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
  "candidateSha256": "80e5f08c5e32947a3e322f96dafce9317f43a886d1737cf2401a70bf8d28eb40",
  "terminal": "closed",
  "decision": "accept",
  "goalFit": {
    "pass": true,
    "basis": "总纲 G2 三项要求均已满足：为 E1、E2、E3 分别写清处置与原文行号（第6、7、8行，行号准确）；保留一句有实测依据的 [稿件自述] 且只描述稿件本身（确为3行）；文末有大白话（第14行）。GitHub 与演练登记分开核验，演练性质已标明。"
  },
  "conclusion": {
    "pass": true,
    "basis": "四条断言均有授权原文或当前总纲支持：C1 忠实转述摘录的可选值关系并如实声明完整取值未读；C2 的 E1 华北与纳入、C3 的 E2 华东与排除，记录值与行号都准确；C4 只把字面值“空白”写成登记事实，把“是否等同待补”明确归给总纲第4行，符合“不能混用”。上轮两处退回（E2 说成未填、空白写成空字段）均已改正，本轮未发现事实错误，可关单。"
  },
  "alternatives": {
    "pass": true,
    "basis": "备选一：C4 直接按总纲写成“E3 列入待补”而不再区分字面值与规则桥接，更贴合“写清处置”，但会把规则判定混入原文事实，与总纲“不能混用”冲突，所以未采。备选二：删掉 C4 只留 E1/E2，损失了“空白”这个口子的信息。现稿保真优先、处置靠规则授权，可接受。"
  },
  "plain": {
    "pass": true,
    "basis": "大白话：改稿把 E2 改回“华东”，E3 只说登记写着“空白”、算不算待补交给总纲规则，不再硬说成空字段；逐行对了原文，没发现别的错。"
  }
};

export const archivedDeliveryCandidate = [
  "# 地区入组说明\n",
  "\n",
  "地区边界（总纲 PROJECT.md 第4行）：只纳入华北；明确登记为其他地区的排除；地区字段空白才待补。\n",
  "\n",
  "- C1：GitHub 检查套件的 completed 状态可能对应 failure 结论（出处：sources/github-checks.md 第6-7行；该摘录只保留 failure/success 两项，完整取值列表未读）。\n",
  "- C2：演练登记 E1 的地区为华北，按华北边界纳入（出处：sources/regional-register.md 第3行）。\n",
  "- C3：演练登记 E2 的地区为华东，属明确登记的其他地区，按边界排除（出处：sources/regional-register.md 第4行）。\n",
  "- C4：演练登记 E3 的地区记为字面值“空白”，按边界不视为华北大区登记；它是否等同“地区字段空白”从而列入待补，仅由总纲第4行规则授权，不是登记原文的事实（出处：sources/regional-register.md 第5行）。\n",
  "\n",
  "[稿件自述] 本稿带 sources/regional-register.md 行号定位的共3行。\n",
  "\n",
  "演练登记为虚构材料，以上 E1/E2/E3 只作演练判断，不构成真实地区事实。\n",
  "\n",
  "大白话：按总纲只收华北——华北的留下，写华东的排除，写着“空白”的既不收也不当空字段补，除非按总纲规则把它算作待补。\n",
].join("");

const goalLine = frozenAssertionMaterial["PROJECT.md"].split("\n")[3];
const ruleScope = "“空白”有时是录入标签，有时表示真正缺项。本批未指定它是哪一种，须先由维护者确认，不能替维护者决定。";
const expectedDisposition = "登记地区写着“空白”，按当前总纲应补充地区信息后重新判定";
const clarification = "登记 E3 的地区写着“空白”，本批含义尚未定义，E3 待确认。请维护者确认，本批的“空白”是录入标签，还是表示地区字段未填写？";
const summaryPrefix = "大白话：E1 纳入；E2 排除；";
const positiveSummary = summaryPrefix + "E3 待补，先请补齐地区。";
const clarificationSummary = summaryPrefix + "E3 待确认，请维护者确认“空白”是不是没填。";
const inconsistentSummary = summaryPrefix + "E3 排除。";
const withDisposition = (decision, body, summary) => {
  const lines = archivedDeliveryCandidate.split("\n");
  lines[5] = lines[5].replace("- C2：演练登记 E1 的", "- C2：E1：纳入，演练登记的");
  lines[6] = lines[6].replace("- C3：演练登记 E2 的", "- C3：E2：排除，演练登记的");
  lines[7] = "- C4：" + (decision ? "E3：" + decision + "，" : "") + body + "（出处：sources/regional-register.md 第5行）。";
  lines[13] = summary;
  return lines.join("\n");
};

/** Keeping the other decision rows and source pins fixed isolates the delivery defect. */
export const deliveryVariants = {
  historicalNoOutcome: archivedDeliveryCandidate,
  definiteOutcome: withDisposition("待补", expectedDisposition, positiveSummary),
  genuineClarification: withDisposition(null, clarification, clarificationSummary),
  summaryMismatch: withDisposition("待补", expectedDisposition, inconsistentSummary),
  isolatedNoOutcome: withDisposition(null, archivedDeliveryCandidate.split("\n")[7]
    .replace("- C4：", "").split("（出处：")[0], summaryPrefix + "E3 是否待补仍由总纲规则授权。"),
  clarificationGoal: frozenAssertionMaterial["PROJECT.md"].replace(goalLine, goalLine + ruleScope),
  conflictingSecondBodyOutcome: withDisposition("待补", expectedDisposition, positiveSummary)
    .replace("（出处：sources/regional-register.md 第5行）。", "（出处：sources/regional-register.md 第5行）。\nE3：排除。"),
  repeatedIdsInNarration: withDisposition("待补", expectedDisposition, positiveSummary)
    .replace("E1：纳入，演练登记的", "E1：纳入，演练登记 E1 的")
    .replace("E2：排除，演练登记的", "E2：排除，演练登记 E2 的")
    .replace("E3：待补，登记地区", "E3：待补，登记 E3 的地区"),
};

// Projection of the stored C4 and plain-language proof parts, omitting actor IDs.
export const archivedDeliveryRoles = {
  "reviewer": {
    "receiptSha256": "fd0232769f0183cb79bccbf0fad1c5d908baab2ed28ea283744a12962984058d",
    "candidateSha256": "80e5f08c5e32947a3e322f96dafce9317f43a886d1737cf2401a70bf8d28eb40",
    "rejectedCount": 0,
    "total": 13,
    "records": [
      {
        "block": "B9-bfe412d9",
        "line": 8,
        "text": "- C4：演练登记 E3 的地区记为字面值“空白”，按边界不视为华北大区登记；",
        "parts": [
          {
            "kind": "nonfactual",
            "status": "supported",
            "quote": "- C4：",
            "basis": "“C4”为编号标签前缀，不承载独立事实。"
          },
          {
            "kind": "direct",
            "status": "supported",
            "quote": "演练登记 E3 的地区记为字面值“空白”",
            "basis": "原文第5行逐字为“E3 地区：空白。”；候选明确把它描述为“记为字面值‘空白’”，与原文记法一致，未把字面值改写为空字段。"
          },
          {
            "kind": "inference",
            "status": "supported",
            "quote": "，按边界不视为华北大区登记；",
            "basis": "总纲第4行只纳入华北；E3 登记的“空白”不是华北，故“不视为华北大区登记”是规则与记录的联合结果，且未反过来断言它就是空字段。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              }
            ]
          }
        ]
      },
      {
        "block": "B10-0250bd6f",
        "line": 8,
        "text": "它是否等同“地区字段空白”从而列入待补，仅由总纲第4行规则授权，不是登记原文的事实（出处：sources/regional-register.md 第5行）。",
        "parts": [
          {
            "kind": "inference",
            "status": "supported",
            "quote": "它是否等同“地区字段空白”从而列入待补，仅由总纲第4行规则授权，不是登记原文的事实",
            "basis": "总纲第4行同时写着“地区字段空白才是待补”与“不能混用”；登记原文第5行只是字面值“空白”、第2行说空值没有额外线索，都没有把“空白”定义成空字段。候选把“是否等同、从而待补”的判定归到总纲第4行、并明确说“不是登记原文的事实”，正好对应总纲“不能混用”的分工，对象、条件与来源归属均一致。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              },
              {
                "file": "sources/regional-register.md",
                "start": 2,
                "end": 2,
                "quote": "这是虚构登记，用于核对地区判断；空值没有额外线索。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "d1df098adef8a60505edea1f3ddfdee09dcfe6f93f683f54b6abe39ab8bf9a9a"
              }
            ]
          },
          {
            "kind": "direct",
            "status": "supported",
            "quote": "（出处：sources/regional-register.md 第5行）。",
            "basis": "sources/regional-register.md 第5行确为 E3 记录，出处行号定位准确。"
          }
        ]
      },
      {
        "block": "B13-ccca47c8",
        "line": 14,
        "text": "大白话：按总纲只收华北——华北的留下，写华东的排除，写着“空白”的既不收也不当空字段补，除非按总纲规则把它算作待补。",
        "parts": [
          {
            "kind": "nonfactual",
            "status": "supported",
            "quote": "大白话：",
            "basis": "neutralSpan 字符 0-4 为显式标签“大白话：”，仅为读者提示。"
          },
          {
            "kind": "inference",
            "status": "supported",
            "quote": "按总纲只收华北——华北的留下，写华东的排除，写着“空白”的既不收也不当空字段补，除非按总纲规则把它算作待补。",
            "basis": "大白话三句与总纲第4行及登记行一一对应：E1 华北对应“只纳入华北”而得“留下”；E2 华东对应“明确登记为其他地区时排除”而得“写华东的排除”；E3 字面“空白”对应“地区字段空白才是待补，不能混用”而得“既不收也不当空字段补，除非按总纲规则算待补”。未把“空白”当成已证的空字段，也未在无规则依据下自行列为待补。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 3,
                "end": 3,
                "quote": "E1 地区：华北。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "c7c4e7b3f802317be3e8756ee174d1b3ad515ae924d3b20c888b8c63be325f46"
              },
              {
                "file": "sources/regional-register.md",
                "start": 4,
                "end": 4,
                "quote": "E2 地区：华东。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "8ebbc2b4521b9267b0359c221f8deaeb19529a01364b7df2f3547527a2e004dc"
              },
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              }
            ]
          }
        ]
      }
    ]
  },
  "auditor": {
    "receiptSha256": "b0e10d904ec6966d4aca701378784d393886fd9e737995f3296be07d5fc28cd0",
    "candidateSha256": "80e5f08c5e32947a3e322f96dafce9317f43a886d1737cf2401a70bf8d28eb40",
    "rejectedCount": 0,
    "total": 13,
    "records": [
      {
        "block": "B9-bfe412d9",
        "line": 8,
        "text": "- C4：演练登记 E3 的地区记为字面值“空白”，按边界不视为华北大区登记；",
        "parts": [
          {
            "kind": "direct",
            "status": "supported",
            "quote": "- C4：演练登记 E3 的地区记为字面值“空白”",
            "basis": "登记第5行逐字为“E3 地区：空白。”；本句用“字面值「空白」”避免把它当成空字段，与原文无引号的“空白”字被狐实保留。"
          },
          {
            "kind": "inference",
            "status": "supported",
            "quote": "，按边界不视为华北大区登记；",
            "basis": "总纲只纳入华北；E3 登记内容为“空白”而非华北，故不能算作华北大区登记。此句只做否定判定，未提前把它定为待补，也未与空白字段混用，与总纲第4行“不能混用”一致。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              }
            ]
          }
        ]
      },
      {
        "block": "B10-0250bd6f",
        "line": 8,
        "text": "它是否等同“地区字段空白”从而列入待补，仅由总纲第4行规则授权，不是登记原文的事实（出处：sources/regional-register.md 第5行）。",
        "parts": [
          {
            "kind": "inference",
            "status": "supported",
            "quote": "它是否等同“地区字段空白”从而列入待补，仅由总纲第4行规则授权，不是登记原文的事实",
            "basis": "requiredAssertions 为 project-application：premises 给登记事实（第5行“E3 地区：空白。”、第2行空值无额外线索），policy 给总纲第4行待补规则，两者独立取证。登记未给待补结论，本句只说“仅由总纲授权、不是登记原文的事实”，未把待补当已定结论，也未用常识补口径。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 2,
                "end": 2,
                "quote": "这是虚构登记，用于核对地区判断；空值没有额外线索。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "d1df098adef8a60505edea1f3ddfdee09dcfe6f93f683f54b6abe39ab8bf9a9a"
              },
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              }
            ]
          },
          {
            "kind": "direct",
            "status": "supported",
            "quote": "（出处：sources/regional-register.md 第5行）。",
            "basis": "所引 sources/regional-register.md 第5行确为 E3 的登记行，行号定位与当前已读原文一致。"
          }
        ]
      },
      {
        "block": "B13-ccca47c8",
        "line": 14,
        "text": "大白话：按总纲只收华北——华北的留下，写华东的排除，写着“空白”的既不收也不当空字段补，除非按总纲规则把它算作待补。",
        "parts": [
          {
            "kind": "nonfactual",
            "status": "supported",
            "quote": "大白话：",
            "basis": "块首“大白话：”是结构标签，仅标明后续为面向读者的直白说法，本身不作外部事实主张。"
          },
          {
            "kind": "inference",
            "status": "supported",
            "quote": "按总纲只收华北——华北的留下，写华东的排除，写着“空白”的既不收也不当空字段补，除非按总纲规则把它算作待补。",
            "basis": "requiredAssertions 为 project-application：premises 给三条登记原文，policy 给总纲第4行；白话句逐一对应规则分支，末句保留待补的开放性，未把未决事项说成已决，也未把字面值“空白”直接当空字段补。",
            "policy": [
              {
                "file": "PROJECT.md",
                "start": 4,
                "end": 4,
                "quote": "地区边界：只纳入华北。明确登记为其他地区时排除；地区字段空白才是待补，不能混用。",
                "sha256": "e22b74637cccc0c9fc27e906840b13b605b55f16f17a25c8a3d70dc3c6ee72b4",
                "goalSha256": "c100406a8d4a2e4653fe7936701e1893ca1a4d8f4aa151432aa520b58bcb7f61",
                "evidenceSpan": "1d1f0b80a20e5464bc81fe458c1d2b1e8d0c0871dbd6aef1cca9c540ad812611"
              }
            ],
            "premises": [
              {
                "file": "sources/regional-register.md",
                "start": 3,
                "end": 3,
                "quote": "E1 地区：华北。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "c7c4e7b3f802317be3e8756ee174d1b3ad515ae924d3b20c888b8c63be325f46"
              },
              {
                "file": "sources/regional-register.md",
                "start": 4,
                "end": 4,
                "quote": "E2 地区：华东。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "8ebbc2b4521b9267b0359c221f8deaeb19529a01364b7df2f3547527a2e004dc"
              },
              {
                "file": "sources/regional-register.md",
                "start": 5,
                "end": 5,
                "quote": "E3 地区：空白。",
                "sha256": "08193e20f1f55b49998644bd3ff147932c57e856d932920b9154684cafcf4dc2",
                "evidenceSpan": "b6c02f6513ba1c66f557f65d6503e917c0179ef5b838ecfb9d33a22048c730b6"
              }
            ]
          }
        ]
      }
    ]
  }
};
