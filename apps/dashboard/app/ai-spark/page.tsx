import { redirect } from "next/navigation";

// 旧入口兼容：AI / Spark 已升级为「模型与 API」（本地推理 / 云端 API / 中转站）。
export default function AiSparkPage() {
  redirect("/models");
}
