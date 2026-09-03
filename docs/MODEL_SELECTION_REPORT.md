# 模型选型最终报告（2026-09-03，Part 4 格式）

## 判定

**MODEL_SELECTION_BLOCKED — 判别性证据不足，不得强行选出赢家**

两模型在全部已测硬门禁上**完全同级通过**，无法按规则分出 WINNER；
而完成可靠选型所必需的三类证据（充足回放样本、并发/负载档位、5/10 Bot
调度）尚未产生。依据用户纪律「不允许用不足样本强行选出赢家」，输出 BLOCKED。

## 候选精确信息

| 项 | M1 | M2（incumbent） |
|---|---|---|
| 仓库 | spele1100/Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4 | mazinb-nvfp4（本地目录；checkpoint 源仓库待补溯源——见限制） |
| revision | c56d7696e9022d5d76ae211021924ac5a2d8aa95（目录名=快照 sha） | 目录无 rev 文件（待补） |
| 量化 | NVFP4 W4A4 专家 + FP8 W8A8 稠密 + BF16 视觉/MTP（21G，recipe.yaml 在库） | NVFP4/PLE（177G） |
| 推理引擎 | vLLM 0.1.dev20073+g8e685d198（镜像 vllm/vllm-openai:qwen38-flash-next digest d464f3b4…） | 同镜像同 digest |
| 启动参数 | max-len 131072/seqs 4/gpu 0.75/qwen3 parser/qwen3_coder tools/MTP2/prefetch | max-len 65536/seqs 4/gpu 0.75/qwen3 parser/qwen3_coder tools/MTP2/PLE offload（实录见 SPARK_DEPLOYMENT_MATRIX） |
| 溯源 | ornith-ai→OS-Software Heretic-JA（ARA 法）→spele1100 GB10 转换，MIT，全链文档 ✓ | 前期实测转正（R 轮），checkpoint 溯源待补 |

测试代码 HEAD：评测器冻结 @864644a + eval-fix @5f2827a/02e4d5f（修复均在有效数据产生前；两轮同版）。

## 正式对比数据（EVAL_CONTRACT v1：temp=0/max_tokens=3000/stop 判据/串行单流/单栈五时点切换）

| 指标 | M1 | M2 |
|---|---|---|
| 拒绝测试 executed/refused/moralizing/truncated/error | **80/0/0/0/0** | **80/0/0/0/0** |
| GAME_ACTION_REFUSAL_RATE（硬门禁=0） | **0 ✓** | **0 ✓** |
| 拒绝延迟 P50/P95/P99 | 37.4s / 93.5s / 171.5s | **13.0s / 33.8s / 106.0s** |
| 回放 jsonValid / 工具名合法（n=11） | 11/11 / 11/11 | 11/11 / 11/11 |
| 回放 P50 / 平均思考 token | 11.7s / 442 | **6.4s / 152** |
| 真实主控 completed / sync_noop / error（n=10） | 2 / 7 / 1（瞬态 409） | 2 / 8 / 0 |
| 主控 e2e P50 | **3.86s** | 6.36s |
| 无效工具派发 / planner 拒绝 / AI 错误 | 0 / 0 / 0 | 0 / 0 / 0 |

## 失败样本与无效轮次（如实保留）

- M1 基线失败证据：max_tokens=200/300 空 content（runtime-data/model-selection/baseline-evidence-M1.json，用户指示保留不被调优覆盖）。
- Pilot 数据（-pilot 后缀）：700 预算 54/80 截断；回放 pilot 2/11 截断——校准链依据。
- 无效轮次：M1 controller-ab 首轮 10×400（评测器 timeout 超限，模型未参与）；M2 controller-ab 首轮 10×503（studio 在模型加载完成前启动，AI 熔断未恢复=环境问题）；均按纪律作废重跑，评测器两轮同版。

## 判别性分析（为何 BLOCKED）

1. **硬门禁完全同级**：拒绝率双 0、工具合法性双 100%、无效调用/AI 错误双 0——已测维度无差异。
2. **延迟分裂**：裸推理 M2 快 2.0-2.9×（PLE 优势）；但真实主控 noop 路径 M1 反快 ~1.6×（n=10，噪声范围内不可下结论）。
3. **样本不足**：回放 n=11（契约明示不足为唯一依据）；主控电池 10 条观察类 goal 被 planner grounding 策略 70-80% noop（电池本身判别力弱——设计使然，非模型差异）。
4. **未跑的必测项**：并发 1/2/4/8/16 档、5/10 Bot 调度负载、长期连续性/中断恢复、资源（统一内存/KV/CUDA Graph 峰值）与稳定性——均为完成可靠选型的必要证据。

## 解除 BLOCKED 所需（按序）

1. S-12 指标管线开启规划输入全量记录（脱敏）→ 回放语料扩到 ≥200（在下一轮 L1-L8/soak 中自然积累）。
2. 重新设计判别性主控电池（含可验证动作类 goal，绕开 grounding-noop 家族；含多步/恢复场景）。
3. 并发档位 1/2/4/8/16 + 5/10 Bot 负载 + 资源峰值与稳定性测试（单栈串行）。
4. M2 checkpoint 溯源补档。

## 当前生产含义

- 无赢家 → 不切换主控；M2 仍为 incumbent（在线运行中，未动）。
- 备用/回退：M1 权重与部署实录在库（docker start ornith15-heretic，五时点齐）。
- 推荐生产参数：两模型各自实录参数即当前最优稳定配置（已完整记录）。

## 证据路径

- runtime-data/model-selection/refusal-{M1,M2}-formal.json（全样本留档）
- runtime-data/model-selection/replay-{M1,M2}-formal.json
- runtime-data/model-selection/controller-ab-{M1,M2}-formal.json
- 切换五时点：M1 起 06:56:19→ready 07:04:46；M1 停 08:57:20-22；M2 起 08:57:22→ready ~09:12
- 状态：Spark=mazinb@18300 运行中；ornith15-heretic 容器保留（stopped）；studio 运行中指向 M2；工作树 clean（除本报告）；stash 未动。
